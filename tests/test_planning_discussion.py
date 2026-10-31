import json

from fastapi.testclient import TestClient

from planner.providers import Completion
from planner.server import build_app


def test_discussion_reads_saved_plan_and_a_fixed_primary_source_bundle(tmp_path):
    inspected = []

    class Model:
        def __enter__(self):
            self.step = 0
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            self.step += 1
            if self.step == 2:
                snapshot = json.loads(messages[-1]["content"])
                assert snapshot["aneurysm_plan"]["options"] == ["coiling", "clipping"]
                assert snapshot["aneurysm_evidence"]["linked_measurements"] == []
                inspected.append("saved plan")
            if self.step <= 2:
                name = "read_case_plan" if self.step == 1 else "read_planning_sources"
                return Completion(
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": f"call-{self.step}",
                                "type": "function",
                                "function": {"name": name, "arguments": "{}"},
                            }
                        ],
                    },
                    "tool_calls",
                    {},
                )
            sources = json.loads(messages[-1]["content"])
            assert {s["id"] for s in sources["sources"]} == {"ESO_UIA_2022", "NICE_NG228_2022"}
            assert sources["clinical_recommendation"] is False
            inspected.append("bounded sources")
            return Completion(
                {
                    "role": "assistant",
                    "content": "Anatomical evidence and rupture status remain unconfirmed. No treatment is selected.",
                },
                "stop",
                {},
            )

    client = TestClient(build_app(tmp_path / "workspace.sqlite3", client_factory=Model))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic worksheet discussion",
            "image_sha256": "e" * 64,
            "dimensions": [16, 16, 16],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    saved = client.patch(
        f"/api/cases/{case['case_id']}/aneurysm-plan",
        json={
            "artifact_version": "1",
            "plan": {"options": ["coiling", "clipping"], "questions": "What evidence is missing?"},
        },
    )
    assert saved.status_code == 200
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": "2",
            "question": "Discuss the selected options without choosing a treatment.",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 200, response.text
    assert inspected == ["saved plan", "bounded sources"]
    assert response.json()["tool_names"] == ["read_case_plan", "read_planning_sources"]
    assert {s["id"] for s in response.json()["sources"]} == {"ESO_UIA_2022", "NICE_NG228_2022"}


def test_selected_option_discussion_refuses_a_model_that_skips_sources(tmp_path):
    class SkipsSources:
        def __enter__(self):
            self.step = 0
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            self.step += 1
            if self.step == 1:
                return Completion(
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "case-only",
                                "type": "function",
                                "function": {"name": "read_case_plan", "arguments": "{}"},
                            }
                        ],
                    },
                    "tool_calls",
                    {},
                )
            return Completion(
                {"role": "assistant", "content": "Uncited comparison must not be returned."},
                "stop",
                {},
            )

    client = TestClient(build_app(tmp_path / "workspace.sqlite3", client_factory=SkipsSources))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic source guard",
            "image_sha256": "f" * 64,
            "dimensions": [16, 16, 16],
            "spacing_mm": [1, 1, 1],
        },
    ).json()
    saved = client.patch(
        f"/api/cases/{case['case_id']}/aneurysm-plan",
        json={"artifact_version": "1", "plan": {"options": ["coiling"]}},
    ).json()
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": "2",
            "question": "Compare the selected option.",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 502
    assert "planning sources" in response.json()["detail"]
    assert "answer" not in response.json()
    assert client.get(f"/api/cases/{case['case_id']}").json() == saved
