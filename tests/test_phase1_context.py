"""Phase 1 real HTTP/ledger composition with synthetic metadata, not models."""

import json

from fastapi.testclient import TestClient
from test_device_checks import geometry
from test_geometry_server import configured, input_body
from test_source_registry import CALIBRATED_HASH, Provider

from planner.server import build_app


def synthetic_metrics(job):
    result = geometry()["current"]["result"]
    result["image_sha256"] = job["image_sha256"]
    result["reference_revision"] = job["reference_revision"]
    result["sac"]["volume"] = 24.0
    result["sac"]["surface_area"] = 46.0
    # Deliberate raw geometry sentinel must never enter a planning context.
    result["surfaces"] = {"triangles_world": [[123456789, 0, 0]]}
    return result


def ready(tmp_path):
    client, case, _ = configured(tmp_path, synthetic_metrics)
    cid = case["case_id"]
    response = client.put(
        f"/api/cases/{cid}/morphometry-inputs", json=input_body(case["artifact_version"])
    )
    assert response.status_code == 200, response.text
    version = response.json()["artifact_version"]
    computed = client.post(
        f"/api/cases/{cid}/morphometry",
        json={"artifact_version": version, "reference_revision": "b" * 64},
    )
    assert computed.status_code == 200, computed.text
    return client, cid, version


def test_catalog_get_does_not_write_or_reseed_database(tmp_path):
    from contextlib import closing

    from planner.device_db import connect, seed_default_catalog

    db = tmp_path / "workspace.sqlite3"
    client = TestClient(build_app(db, inference_results_dir=tmp_path / "results"))
    with closing(connect(db)) as observer:
        seed_default_catalog(observer)
        before = observer.execute("PRAGMA data_version").fetchone()[0]
        for _ in range(2):
            response = client.get("/api/devices")
            assert response.status_code == 200, response.text
            assert response.json()["devices"]
        assert observer.execute("PRAGMA data_version").fetchone()[0] == before


def test_default_app_devices_and_territory_contracts(tmp_path):
    client = TestClient(
        build_app(tmp_path / "workspace.sqlite3", inference_results_dir=tmp_path / "results")
    )
    response = client.get("/api/devices", params={"territory": "structural_heart"})
    assert response.status_code == 200, response.text
    assert response.json()["clinical_suitability_established"] is False
    assert response.json()["devices"]
    assert all(d["territory"] == "structural_heart" for d in response.json()["devices"])
    plugins = client.get("/api/territories")
    assert plugins.status_code == 200, plugins.text
    assert any(p["key"] == "intracranial_aneurysm" for p in plugins.json()["territories"])
    assert client.get("/api/devices?category=not-real").status_code == 422


def test_current_morphometry_and_accepted_masks_reach_context_and_brief(tmp_path):
    client, cid, _ = ready(tmp_path)
    response = client.get(f"/api/cases/{cid}/planning-context")
    assert response.status_code == 200, response.text
    context = response.json()
    assert context["morphometry_summary"]["sac"]["volume"] == 24.0
    assert len(context["segmentation_summary"]) == 2
    assert context["territory_summary"]["findings"][0]["severity"] == "unknown"
    assert "triangles" not in response.text and "123456789" not in response.text
    brief = client.get(f"/api/cases/{cid}/brief")
    assert brief.status_code == 200, brief.text
    assert "24.0" in brief.text
    assert "Computed morphometry" in brief.text
    assert "triangles" not in brief.text
    assert "not clinically validated" in brief.text
    analysis = client.get(f"/api/cases/{cid}/territory-analysis")
    assert analysis.status_code == 200, analysis.text
    assert len(analysis.json()["findings"]) == 1
    assert client.get(f"/api/cases/{cid}/territory-analysis?territory=unknown").status_code == 422


def test_sizing_result_producer_reaches_context_and_brief(tmp_path):
    from test_device_inputs_state import MEASUREMENTS, PROVENANCE

    client, cid, version = ready(tmp_path)
    base = f"/api/cases/{cid}"
    saved = client.put(
        base + "/device-sizing-inputs",
        json={
            "artifact_version": version,
            "reference_revision": "b" * 64,
            "expected_input_revision": None,
            "measurements": MEASUREMENTS,
            "provenance": PROVENANCE,
        },
    )
    assert saved.status_code == 200, saved.text
    before = client.get(base + "/device-sizing").json()
    payload = {
        key: before[key]
        for key in (
            "artifact_version",
            "reference_revision",
            "geometry_result_id",
            "catalog_version",
            "calculation_version",
        )
    }
    payload.update({key: before["inputs"][key] for key in ("input_revision", "inputs_sha256")})
    computed = client.post(base + "/device-sizing", json=payload)
    assert computed.status_code == 200, computed.text
    context = client.get(base + "/planning-context")
    assert context.status_code == 200, context.text
    summary = context.json()["device_sizing_summary"]
    assert summary["validated_sizing"] is False
    assert summary["compatibility_status"] == "not_established"
    assert summary["pipeline"]["largest_parent_mm"] == max(
        MEASUREMENTS["proximal_parent"], MEASUREMENTS["distal_parent"]
    )
    assert summary["result_id"] == computed.json()["current"]["result_id"]
    assert summary["result_id"] in client.get(base + "/brief").text


def test_uncomputed_context_keeps_unavailable_explicit(tmp_path):
    client = TestClient(
        build_app(tmp_path / "workspace.sqlite3", inference_results_dir=tmp_path / "results")
    )
    created = client.post(
        "/api/cases",
        json={
            "title": "Synthetic missing source",
            "image_sha256": "a" * 64,
            "dimensions": [4, 4, 4],
            "spacing_mm": [1, 1, 1],
        },
    ).json()
    response = client.get(f"/api/cases/{created['case_id']}/planning-context")
    assert response.status_code == 200
    assert response.json()["morphometry_summary"] is None
    assert response.json()["device_sizing_summary"] is None
    assert "Unavailable" in client.get(f"/api/cases/{created['case_id']}/brief").text


def test_agent_sees_current_context_and_rejects_recomputed_geometry(tmp_path):
    from planner.geometry_state import GeometryLedger
    from planner.providers import Completion

    _client, cid, version = ready(tmp_path)
    inspected = []

    class Model:
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
                                "id": "snapshot",
                                "type": "function",
                                "function": {"name": "read_case_plan", "arguments": "{}"},
                            }
                        ],
                    },
                    "tool_calls",
                    {},
                )
            data = json.loads(messages[-1]["content"])
            assert data["computed_context"]["morphometry_summary"]["sac"]["volume"] == 24.0
            assert "triangles" not in messages[-1]["content"]
            inspected.append(True)
            # Auxiliary recomputation does not increment the case artifact version.
            ledger = GeometryLedger(tmp_path / "case.sqlite3")
            snapshot = ledger.snapshot(cid, version, "b" * 64)
            ledger.store(
                cid,
                snapshot,
                synthetic_metrics(
                    {"image_sha256": CALIBRATED_HASH, "reference_revision": "b" * 64}
                ),
            )
            return Completion(
                {"role": "assistant", "content": "Old context must be discarded."}, "stop", {}
            )

    app = build_app(
        tmp_path / "case.sqlite3",
        client_factory=Model,
        calibrated_source_store=Provider(CALIBRATED_HASH, "mm"),
        reference_dir=tmp_path / "missing",
        inference_results_dir=tmp_path / "results",
    )
    result = TestClient(app).post(
        f"/api/cases/{cid}/agent",
        json={
            "artifact_version": version,
            "question": "Summarize computed geometry only",
            "public_data_confirmed": True,
        },
    )
    assert inspected == [True]
    assert result.status_code == 409, result.text
    assert "answer" not in result.json()
