"""Registry tests use injected trusted provider bundles, not image/model evidence."""

from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

CALIBRATED_ID = "zenodo-case006-calibrated"
CALIBRATED_HASH = "88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3"


class Provider:
    def __init__(self, digest, units):
        self.digest = digest
        self.units = units
        self.revision = "b" * 64
        self.bundle = (
            {
                "image": {
                    "sha256": digest,
                    "affine_ras": [
                        [-0.5, 0, 0, 1],
                        [0, -0.5, 0, 2],
                        [0, 0, 0.625, 3],
                        [0, 0, 0, 1],
                    ],
                },
                "source_header": {"xyzt_units": 0 if units == "unknown" else 2},
                "crop": {"size_voxels": [56, 77, 50]},
            },
            self.revision,
            {"image": Path("synthetic-only.nii.gz")},
        )

    def load(self):
        return self.bundle

    def metadata(self, bundle, case_id=None):
        result = {
            "image_sha256": self.digest,
            "reference_revision": bundle[1],
            "spatial_units": self.units,
            "source_id": CALIBRATED_ID,
            "method": "calibrated_context_crop",
        }
        if case_id is not None:
            result["case_id"] = case_id
        return result


def case(digest=CALIBRATED_HASH, units="mm"):
    return {
        "case_id": "case-006",
        "image_sha256": digest,
        "dimensions": [56, 77, 50],
        "spacing_mm": [0.5, 0.5, 0.625],
        "spatial_units": units,
    }


def registry():
    from planner.source_registry import ImageSourceRegistry

    return ImageSourceRegistry(Provider("a" * 64, "unknown"), Provider(CALIBRATED_HASH, "mm"))


def test_calibrated_case_reaches_segmentation_runner_with_server_selected_source(tmp_path):
    from planner.server import build_app

    jobs = []

    def runner(job, output):
        jobs.append(job)
        path = output / "mask.nii.gz"
        path.write_bytes(b"synthetic-api-lifecycle-test-only")
        return {"mask_path": path, "metadata": {"fixture": True}}

    app = build_app(
        tmp_path / "cases.sqlite",
        reference_dir=tmp_path / "missing-old-reference",
        calibrated_source_store=Provider(CALIBRATED_HASH, "mm"),
        inference_runner=runner,
        inference_results_dir=tmp_path / "results",
    )
    client = TestClient(app)
    created = client.post(
        "/api/cases",
        json={
            "title": "synthetic API source contract",
            **{key: value for key, value in case().items() if key != "case_id"},
        },
    )
    assert created.is_success, created.text
    state = created.json()
    metadata = client.get(f"/api/cases/{state['case_id']}/image-source")
    assert metadata.status_code == 200, metadata.text
    response = client.post(
        f"/api/cases/{state['case_id']}/segmentations",
        json={
            "artifact_version": state["artifact_version"],
            "reference_revision": "b" * 64,
            "kind": "vessel",
            "role": "vessel",
        },
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "preview"
    assert jobs[0]["source_id"] == CALIBRATED_ID
    assert jobs[0]["image_sha256"] == CALIBRATED_HASH
    assert jobs[0]["reference_revision"] == "b" * 64
    assert not {"image_path", "source_path", "runtime", "checkpoint"}.intersection(jobs[0])


def test_registry_selects_image_only_source_without_curated_annotations():
    selected = registry().load_for_case(case())
    assert selected[0]["source_id"] == CALIBRATED_ID
    assert selected[0]["spatial_units"] == "mm"
    assert "annotations" not in selected[0]
    assert selected[1] == "b" * 64 and selected[1] != CALIBRATED_HASH


def test_registry_preserves_old_unknown_units():
    selected = registry().load_for_case(case("a" * 64, "unknown"))
    assert selected[0]["spatial_units"] == "unknown"
    with pytest.raises(HTTPException) as exc:
        registry().load_for_case(case("a" * 64, "mm"))
    assert exc.value.status_code == 409


@pytest.mark.parametrize(
    "changed", [{"dimensions": [1, 2, 3]}, {"spacing_mm": [1, 1, 1]}, {"spatial_units": "unknown"}]
)
def test_calibrated_case_metadata_must_match_server_owned_source(changed):
    with pytest.raises(HTTPException) as exc:
        registry().load_for_case({**case(), **changed})
    assert exc.value.status_code == 409


def test_case_source_endpoint_has_no_curated_annotation_claim():
    from planner.source_registry import register_image_source_routes

    app = FastAPI()
    register_image_source_routes(app, registry(), lambda case_id: case())
    response = TestClient(app).get("/api/cases/case-006/image-source")
    assert response.status_code == 200
    data = response.json()
    assert data["source_id"] == CALIBRATED_ID
    assert data["case_id"] == "case-006"
    assert "annotations" not in data
