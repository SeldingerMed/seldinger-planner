"""Synthetic reference bundles only, no real clinical data."""

import hashlib
import json
from contextlib import AbstractContextManager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from planner.providers import Completion


def install_fixture(root):
    root.mkdir()
    image = b"explicitly synthetic image bytes, not a readable CTA"
    meshes = {"aneurysm": b"synthetic aneurysm mesh", "artery": b"synthetic artery mesh"}
    (root / "reference-cta.nii.gz").write_bytes(image)
    annotations = []
    for name, data in meshes.items():
        filename = f"reference-{name}.stl"
        (root / filename).write_bytes(data)
        annotations.append(
            {
                "id": name,
                "filename": filename,
                "sha256": hashlib.sha256(data).hexdigest(),
                "triangle_count": 1,
            }
        )
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "case_label": "CMHA AHMU1218001",
        "source_url": "https://doi.org/10.6084/m9.figshare.26965450.v1",
        "license_url": "https://creativecommons.org/licenses/by/4.0/",
        "citation": "Synthetic contract fixture",
        "image": {"filename": "reference-cta.nii.gz", "sha256": hashlib.sha256(image).hexdigest()},
        "annotations": annotations,
        "focus_ras": [-10, 20, 30],
        "source_sha256": {k: "1" * 64 for k in ("cta", "aneurysm", "artery")},
        "transform": {
            "matrix": [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],
            "status": "candidate_image_consistent",
        },
        "source_header": {"xyzt_units": 0, "scl_slope": 1, "scl_inter": 0},
        "crop": {},
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def make_client(tmp_path):
    from planner.server import build_app

    root = tmp_path / "reference"
    manifest = install_fixture(root)
    return TestClient(build_app(tmp_path / "workspace.sqlite3", reference_dir=root)), root, manifest


def create_case(client, digest):
    return client.post(
        "/api/cases",
        json={
            "title": "Synthetic case",
            "image_sha256": digest,
            "dimensions": [10, 10, 10],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()


def test_reference_assets_are_case_and_revision_bound(tmp_path):
    client, root, manifest = make_client(tmp_path)
    listing = client.get("/api/reference").json()
    assert listing["image_sha256"] == manifest["image"]["sha256"]
    assert listing["spatial_units"] == "unknown"
    assert listing["alignment_status"] == "candidate_image_consistent"
    assert client.get(listing["image_url"]).content == (root / "reference-cta.nii.gz").read_bytes()
    own = create_case(client, listing["image_sha256"])
    other = create_case(client, "f" * 64)
    assert client.get(f"/api/cases/{other['case_id']}/reference").status_code == 404
    assert client.get("/api/cases/missing/reference").status_code == 404
    data = client.get(f"/api/cases/{own['case_id']}/reference").json()
    assert data["case_id"] == own["case_id"]
    asset = data["annotations"][0]
    assert client.get(asset["url"]).content == (root / f"reference-{asset['id']}.stl").read_bytes()
    stale = asset["url"].replace(data["reference_revision"], "0" * 64)
    assert client.get(stale).status_code == 409
    assert str(root) not in json.dumps(data)
    assert data["method"] == "curated_dataset_annotation"


def test_tampered_or_escaped_reference_assets_fail_closed(tmp_path):
    client, root, manifest = make_client(tmp_path)
    manifest["image"]["filename"] = "../secret.env"
    (root / "manifest.json").write_text(json.dumps(manifest))
    response = client.get("/api/reference")
    assert response.status_code == 503
    assert str(root) not in response.text


@pytest.mark.parametrize("field", ["scl_slope", "scl_inter"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_manifest_scaling_fails_closed(tmp_path, field, value):
    client, root, manifest = make_client(tmp_path)
    manifest["source_header"][field] = value
    (root / "manifest.json").write_text(json.dumps(manifest))
    assert client.get("/api/reference").status_code == 503


def test_reference_hash_mismatch_and_symlink_are_refused(tmp_path):
    client, root, _ = make_client(tmp_path)
    (root / "reference-artery.stl").write_bytes(b"modified")
    assert client.get("/api/reference").status_code == 503
    target = tmp_path / "outside"
    target.write_bytes(b"synthetic artery mesh")
    (root / "reference-artery.stl").unlink()
    (root / "reference-artery.stl").symlink_to(target)
    assert client.get("/api/reference").status_code == 503


def test_reference_is_optional_and_does_not_publish_extra_manifest_fields(tmp_path):
    from planner.server import build_app

    client = TestClient(build_app(tmp_path / "empty.sqlite3", reference_dir=tmp_path / "missing"))
    assert client.get("/api/reference").status_code == 404
    client, root, manifest = make_client(tmp_path)
    manifest["private_local_path"] = str(root / "unrelated")
    (root / "manifest.json").write_text(json.dumps(manifest))
    data = client.get("/api/reference").json()
    assert "private_local_path" not in data
    assert "Synthetic contract fixture" not in json.dumps(data)


def run_reference_model(tmp_path, *, mutate=False):
    from planner.server import build_app

    root = tmp_path / "reference"
    manifest = install_fixture(root)
    seen = {}

    class Model(AbstractContextManager):
        def __exit__(self, *args):
            return None

        def complete(self, messages, tools, **kwargs):
            if messages[-1]["role"] == "tool":
                seen.update(json.loads(messages[-1]["content"]))
                if mutate:
                    manifest["revision_note"] = "changed during synthetic model request"
                    (root / "manifest.json").write_text(json.dumps(manifest))
                return Completion(
                    {"role": "assistant", "content": "Synthetic contract result"}, "stop", {}
                )
            return Completion(
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "reference-test",
                            "type": "function",
                            "function": {"name": "read_case_plan", "arguments": "{}"},
                        }
                    ],
                },
                "tool_calls",
                {},
            )

    client = TestClient(
        build_app(tmp_path / "model.sqlite3", reference_dir=root, client_factory=Model)
    )
    case = create_case(client, manifest["image"]["sha256"])
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": "1",
            "question": "Inspect saved evidence only",
            "public_data_confirmed": True,
        },
    )
    return response, seen


def test_model_snapshot_labels_verified_curated_provenance(tmp_path):
    response, seen = run_reference_model(tmp_path)
    assert response.status_code == 200
    assert seen["reference_annotation"]["method"] == "curated_dataset_annotation"
    assert seen["reference_annotation"]["spatial_units"] == "unknown"
    assert seen["reference_annotation"]["alignment_status"] == "candidate_image_consistent"


def test_model_discards_output_if_reference_revision_changed(tmp_path):
    response, _ = run_reference_model(tmp_path, mutate=True)
    assert response.status_code == 409
