"""Projection-series manifest contract, installed store and read-only route."""

import copy
import json
import math

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from planner.projection_server import register_projection_series_routes
from planner.projection_source import (
    MAX_MANIFEST_BYTES,
    InstalledProjectionStore,
    calibration,
    validate_manifest,
)


def plane(label="single", **change):
    value = {
        "plane": label,
        "sop_class": "xa",
        "input_sha256": ("a" if label != "b" else "b") * 64,
        "input_bytes": 1024,
        "rows": 512,
        "columns": 512,
        "frame_count": 3,
        "burned_in_annotation": "no",
        "positioner_motion": "static",
        "primary_angle_deg": 30.0,
        "secondary_angle_deg": -20.0,
        "source_detector_mm": 1200.0,
        "source_isocenter_mm": 750.0,
        "imager_pixel_spacing_mm": [0.3, 0.3],
        "frame_time_ms": 66.0,
        "frame_time_vector_ms": None,
        "mask_operation": "none",
        "mask_frame_numbers": None,
        **change,
    }
    value.setdefault("calibration", calibration(value))
    return value


def manifest(planes=None, **change):
    planes = [plane()] if planes is None else planes
    return {
        "version": 1,
        "kind": "projection_series",
        "clinical_validation": False,
        "scope": "synthetic",
        "method": "converted_dicom_xa_geometry",
        "pixels_retained": False,
        "angle_convention": "dicom_xa_patient_positioner_angles",
        "biplane_linkage": "cross_referenced" if len(planes) == 2 else "not_applicable",
        "planes": planes,
        **change,
    }


def test_valid_single_and_biplane_manifests_are_admitted():
    assert validate_manifest(manifest())["planes"][0]["calibration"] == {
        "status": "calibrated",
        "missing": [],
    }
    validate_manifest(manifest([plane("a"), plane("b", primary_angle_deg=90.0)]))
    uncalibrated = plane(primary_angle_deg=None, positioner_motion="dynamic")
    assert uncalibrated["calibration"] == {
        "status": "uncalibrated",
        "missing": ["primary_angle", "static_positioner"],
    }
    validate_manifest(manifest([uncalibrated]))
    validate_manifest(
        manifest([plane(mask_operation="avg_sub", mask_frame_numbers=[1, 3], frame_time_ms=None)])
    )


@pytest.mark.parametrize(
    "change",
    [
        {"version": 2},
        {"version": True},
        {"kind": "volume"},
        {"clinical_validation": True},
        {"pixels_retained": True},
        {"scope": "private"},
        {"method": "typed"},
        {"angle_convention": "other"},
        {"biplane_linkage": "cross_referenced"},
        {"planes": []},
        {"planes": [plane(), plane(), plane()]},
        # Two planes without declared linkage.
        {"planes": [plane("a"), plane("b")], "biplane_linkage": "not_applicable"},
        {"extra": 1},
    ],
)
def test_manifest_declarations_are_closed(change):
    with pytest.raises(ValueError):
        validate_manifest(manifest(**change))


def test_biplane_requires_ordered_distinct_planes():
    for planes in (
        [plane("b"), plane("a")],
        [plane("a"), plane("a")],
        [plane("single"), plane("b")],
        [plane("a"), plane("b", input_sha256="a" * 64)],
    ):
        with pytest.raises(ValueError):
            validate_manifest(manifest(planes))


@pytest.mark.parametrize(
    "change",
    [
        {"plane": "c"},
        {"sop_class": "ct"},
        {"input_sha256": "A" * 64},
        {"input_bytes": 0},
        {"rows": 0},
        {"columns": 5000},
        {"frame_count": 0},
        {"frame_count": 3.0},
        {"burned_in_annotation": "maybe"},
        {"positioner_motion": "spinning"},
        {"primary_angle_deg": 181.0},
        {"primary_angle_deg": "30"},
        {"secondary_angle_deg": math.nan},
        {"source_detector_mm": 0.0},
        {"source_isocenter_mm": -1.0},
        {"imager_pixel_spacing_mm": [0.3]},
        {"imager_pixel_spacing_mm": [0.3, 0.0]},
        {"imager_pixel_spacing_mm": [0.3, None]},
        {"frame_time_ms": 0.0},
        {"frame_time_vector_ms": [0.0, 10.0]},
        {"frame_time_vector_ms": [0.0, None, 10.0]},
        {"mask_operation": "magic"},
        {"mask_frame_numbers": [1]},  # numbers without an averaged-mask operation
        {"mask_operation": "avg_sub", "mask_frame_numbers": [4]},
        {"mask_operation": "avg_sub", "mask_frame_numbers": [1, 1]},
        {"mask_operation": "avg_sub", "mask_frame_numbers": [True]},
        {"calibration": {"status": "uncalibrated", "missing": []}},
        {"primary_angle_deg": None, "calibration": {"status": "calibrated", "missing": []}},
        {"source_isocenter_mm": 1200.0, "calibration": {"status": "calibrated", "missing": []}},
        {"positioner_motion": "unknown", "calibration": {"status": "calibrated", "missing": []}},
    ],
)
def test_plane_fields_are_bounded_and_the_gate_cannot_be_forged(change):
    with pytest.raises(ValueError):
        validate_manifest(manifest([plane(**change)]))
    missing = plane()
    del missing["frame_time_ms"]
    with pytest.raises(ValueError):
        validate_manifest(manifest([missing]))


def install(root, source_id, value):
    directory = root / source_id
    directory.mkdir(parents=True)
    (directory / "projection.json").write_text(json.dumps(value))
    return directory


def client_for(root):
    app = FastAPI()
    register_projection_series_routes(app, InstalledProjectionStore(root))
    return TestClient(app)


def test_route_serves_admitted_manifest_and_fails_closed(tmp_path):
    root = tmp_path.resolve() / "projections"
    value = manifest([plane("a"), plane("b", primary_angle_deg=90.0)])
    install(root, "run-1", value)
    client = client_for(root)
    response = client.get("/api/projection-series/run-1")
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert body["source_id"] == "run-1" and body["manifest"] == value
    assert len(body["manifest_revision"]) == 64
    assert str(tmp_path) not in response.text
    for missing in ("absent", "Bad%20Id", "..", "run-1%2F..", "a"):
        assert client.get(f"/api/projection-series/{missing}").status_code == 404
    forged = copy.deepcopy(value)
    forged["planes"][0]["calibration"] = {"status": "calibrated", "missing": []}
    forged["planes"][0]["imager_pixel_spacing_mm"] = None
    install(root, "forged", forged)
    (root / "empty").mkdir()
    install(root, "garbage", value)
    (root / "garbage" / "projection.json").write_text("{")
    install(root, "huge", value)
    (root / "huge" / "projection.json").write_text(
        json.dumps({**value, "pad": "x" * MAX_MANIFEST_BYTES})
    )
    (root / "linked").symlink_to(root / "run-1", target_is_directory=True)
    install(root, "linked-manifest", value)
    (root / "linked-manifest" / "projection.json").unlink()
    (root / "linked-manifest" / "projection.json").symlink_to(root / "run-1" / "projection.json")
    assert client.get("/api/projection-series/empty").status_code == 404
    for broken in ("forged", "garbage", "huge", "linked", "linked-manifest"):
        response = client.get(f"/api/projection-series/{broken}")
        assert response.status_code == 503, (broken, response.text)
        assert "planes" not in response.text and str(tmp_path) not in response.text


def test_default_app_registers_the_projection_series_route(tmp_path):
    from planner.server import build_app

    root = tmp_path.resolve() / "projections"
    install(root, "run-1", manifest())
    client = TestClient(
        build_app(
            db_path=tmp_path.resolve() / "case.sqlite3",
            projection_series_store=InstalledProjectionStore(root),
        )
    )
    assert client.get("/api/projection-series/run-1").status_code == 200
    assert client.get("/api/projection-series/none").status_code == 404
