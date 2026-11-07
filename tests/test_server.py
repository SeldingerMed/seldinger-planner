import pytest
from fastapi.testclient import TestClient


def test_agent_refuses_unconfirmed_data_without_constructing_provider(tmp_path):
    from planner.server import build_app

    called = []
    app = build_app(tmp_path / "case.sqlite3", client_factory=lambda: called.append(True))
    client = TestClient(app)
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic metadata test",
            "image_sha256": "a" * 64,
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
        },
    ).json()
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": "1",
            "question": "Summarize",
            "public_data_confirmed": False,
        },
    )
    assert response.status_code == 422
    assert called == []


@pytest.mark.parametrize("measurement_count", [0, 101])
def test_agent_reads_real_snapshot_through_case_bound_tool(tmp_path, measurement_count):
    import json

    from planner.providers import Completion
    from planner.server import build_app

    history = []

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            history.append(messages.copy())
            if len(history) == 1:
                return Completion(
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "snapshot-1",
                                "type": "function",
                                "function": {
                                    "name": "read_case_plan",
                                    "arguments": json.dumps({}),
                                },
                            }
                        ],
                    },
                    "tool_calls",
                    {},
                )
            evidence = json.loads(messages[-1]["content"])
            assert evidence["measurement_count"] == measurement_count
            assert len(evidence["measurements"]) == min(100, measurement_count)
            assert evidence.get("measurements_returned") == min(100, measurement_count)
            assert evidence.get("measurements_truncated") is (measurement_count > 100)
            description = next(
                t["function"]["description"]
                for t in tools
                if t["function"]["name"] == "read_case_plan"
            )
            assert "100" in description and "measurement_count" in description
            return Completion(
                {"role": "assistant", "content": "Actual title: " + evidence["title"]}, "stop", {}
            )

    client = TestClient(build_app(tmp_path / "workspace.sqlite3", client_factory=Client))
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic snapshot test",
            "image_sha256": "b" * 64,
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "mm",
        },
    ).json()
    for index in range(measurement_count):
        result = client.post(
            f"/api/cases/{case['case_id']}/measurements",
            json={
                "artifact_version": case["artifact_version"],
                "label": f"Synthetic {index}",
                "point_a_mm": [0, 0, 0],
                "point_b_mm": [1, 1, 1],
            },
        )
        assert result.status_code == 200
        case = result.json()
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": case["artifact_version"],
            "question": "Read the actual case plan.",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["answer"] == "Actual title: Synthetic snapshot test"
    assert response.json()["tool_names"] == ["read_case_plan"]
    assert response.json()["artifact_version"] == case["artifact_version"]
    assert len(history) == 2


def test_local_entrypoint_binds_loopback_and_private_runtime(tmp_path, monkeypatch):
    import stat

    import uvicorn

    from planner.server import main

    runs = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: runs.append(kwargs))
    main(runtime_dir=tmp_path / "runtime")
    assert runs[0]["host"] == "127.0.0.1"
    assert runs[0]["port"] == 8765
    assert stat.S_IMODE((tmp_path / "runtime" / "workspace.sqlite3").stat().st_mode) == 0o600
