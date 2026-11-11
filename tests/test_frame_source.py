"""Pixel-frame manifest contract, installed store and read-only routes. Synthetic bytes."""

import copy
import hashlib
import json
import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from planner.frame_source import (
    MAX_MANIFEST_BYTES,
    InstalledFrameStore,
    find_frame,
    frame_filename,
    validate_manifest,
)
from planner.projection_server import register_projection_frame_routes

ROWS, COLUMNS = 64, 80
GEOMETRY = {
    "primary_deg": 30.0,
    "secondary_deg": -20.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 160.0,
    "detector_height_mm": 128.0,
}


def pixels(seed):
    return bytes((seed * 31 + i * 7) % 251 for i in range(ROWS * COLUMNS))


def frame(index, seed=None):
    data = pixels(index if seed is None else seed)
    return {
        "index": index,
        "sha256": hashlib.sha256(data).hexdigest(),
        "input_sha256": "c" * 64,
    }


def png_plane(label="single", **change):
    return {
        "plane": label,
        "rows": ROWS,
        "columns": COLUMNS,
        "container_sha256": "d" * 64,
        "container_bytes": 4096,
        "deidentification": {
            "basis": "operator_attested_crop_and_redaction",
            "burned_in_annotation": "not_declared",
            "source_rows": 480,
            "source_columns": 720,
            "crop": [100, 50, COLUMNS, ROWS],
            "redactions": [[0, 0, 720, 40]],
        },
        "geometry": None,
        "frames": [frame(3), frame(12)],
        **change,
    }


def dicom_plane(label="single", **change):
    value = {
        "plane": label,
        "rows": ROWS,
        "columns": COLUMNS,
        "container_sha256": "c" * 64,
        "container_bytes": 8192,
        "deidentification": {
            "basis": "dicom_declared_no_burned_in_annotation",
            "burned_in_annotation": "no",
            "source_rows": ROWS,
            "source_columns": COLUMNS,
            "crop": None,
            "redactions": [],
        },
        "geometry": dict(GEOMETRY),
        "frames": [frame(0), frame(5)],
    }
    value.update(change)
    return value


def manifest(planes=None, method="admitted_png_frames", **change):
    planes = [png_plane()] if planes is None else planes
    return {
        "version": 1,
        "kind": "projection_frames",
        "clinical_validation": False,
        "scope": "synthetic",
        "method": method,
        "pixel_format": "gray8",
        "biplane_linkage": "operator_declared" if len(planes) == 2 else "not_applicable",
        "planes": planes,
        **change,
    }


def deid(base, **change):
    return {**base["deidentification"], **change}


def install(root, source_id, value, *, skip=()):
    directory = root / source_id
    directory.mkdir(parents=True)
    (directory / "frames.json").write_text(json.dumps(value))
    for plane in value["planes"]:
        for item in plane["frames"]:
            name = frame_filename(plane["plane"], item["index"])
            if skip is not True and name not in skip:
                (directory / name).write_bytes(pixels(item["index"]))
    return directory


def test_valid_png_and_dicom_manifests_are_admitted():
    validate_manifest(manifest())
    validate_manifest(manifest([png_plane("a"), png_plane("b")]))
    validate_manifest(manifest([dicom_plane()], method="admitted_dicom_xa_frames"))
    # No container was named for the PNG frames.
    validate_manifest(manifest([png_plane(container_sha256=None, container_bytes=None)]))
    # A burned-in DICOM plane is admitted on an operator-attested redaction.
    burned = dicom_plane(geometry=None)
    burned["deidentification"] = deid(
        burned,
        basis="operator_attested_crop_and_redaction",
        burned_in_annotation="yes",
        redactions=[[0, 0, 10, 10]],
    )
    validate_manifest(manifest([burned], method="admitted_dicom_xa_frames"))


@pytest.mark.parametrize(
    "change",
    [
        {"version": 2},
        {"version": True},
        {"kind": "projection_series"},
        {"clinical_validation": True},
        {"scope": "private"},
        {"method": "typed"},
        {"pixel_format": "gray16"},
        {"biplane_linkage": "operator_declared"},
        {"planes": []},
        {"planes": [png_plane("a"), png_plane("b"), png_plane("b")]},
        {"planes": [png_plane("a")]},  # a lone plane is labelled single
        {"planes": [png_plane("b"), png_plane("a")], "biplane_linkage": "operator_declared"},
        {"planes": [png_plane("a"), png_plane("b")], "biplane_linkage": "cross_referenced"},
        {"extra": 1},
    ],
)
def test_manifest_declarations_are_closed(change):
    with pytest.raises(ValueError):
        validate_manifest(manifest(**change))


@pytest.mark.parametrize(
    "change",
    [
        {"plane": "c"},
        {"rows": 63},
        {"columns": 1025},
        {"rows": 64.0},
        {"container_sha256": "D" * 64},
        {"container_bytes": 0},
        {"container_bytes": None},  # a hash without a size
        {"geometry": dict(GEOMETRY)},  # a PNG plane never carries geometry
        {"frames": []},
        {"frames": [frame(i) for i in range(9)]},
        {"frames": [frame(4), frame(4)]},
        {"frames": [frame(9), frame(4)]},
        {"frames": [{**frame(4), "extra": 1}]},
        {"frames": [{**frame(4), "index": -1}]},
        {"frames": [{**frame(4), "index": True}]},
        {"frames": [{**frame(4), "sha256": "z" * 64}]},
        {"frames": [{**frame(4), "input_sha256": None}]},
        {"extra": 1},
    ],
)
def test_plane_fields_are_bounded(change):
    with pytest.raises(ValueError):
        validate_manifest(manifest([png_plane(**change)]))


@pytest.mark.parametrize(
    "change",
    [
        {"crop": None},  # a PNG plane must be cropped
        {"burned_in_annotation": "no"},  # a PNG declares nothing
        {"basis": "dicom_declared_no_burned_in_annotation"},
        {"crop": [100, 50, COLUMNS, ROWS + 1]},  # contradicts the stored size
        {"crop": [700, 50, COLUMNS, ROWS]},  # leaves the source
        {"crop": [100, 50, COLUMNS]},
        {"crop": [100.0, 50, COLUMNS, ROWS]},
        {"redactions": [[0, 0, 0, 10]]},
        {"redactions": [[0, 470, 10, 20]]},
        {"redactions": [[0, 0, 4, 4]] * 17},
        {"redactions": None},
        {"source_rows": 0},
        {"source_columns": 5000},
        {"extra": 1},
    ],
)
def test_png_deidentification_record_is_closed(change):
    plane = png_plane()
    plane["deidentification"] = deid(plane, **change)
    with pytest.raises(ValueError):
        validate_manifest(manifest([plane]))


def test_the_plane_set_is_single_or_a_then_b():
    def refused(planes, message, linkage=None):
        value = manifest(planes)
        if linkage:
            value["biplane_linkage"] = linkage
        with pytest.raises(ValueError, match=message):
            validate_manifest(value)

    count = "one or two planes required"
    refused([], count)
    refused([png_plane("a"), png_plane("b"), png_plane("single")], count)
    refused([png_plane("single")] * 3, count)
    refused([png_plane("b"), png_plane("a")], "requires planes A and B")
    refused([png_plane("a"), png_plane("a")], "requires planes A and B")
    refused([png_plane("a")], "carries no biplane linkage")
    refused([png_plane("a"), png_plane("b")], "requires planes A and B", "not_applicable")
    refused([png_plane()], "carries no biplane linkage", "operator_declared")


@pytest.mark.parametrize(
    "change",
    [
        # Burned-in or undeclared annotation needs an attested crop or redaction.
        {"burned_in_annotation": "yes"},
        {"burned_in_annotation": "unknown"},
        {"burned_in_annotation": "yes", "basis": "operator_attested_crop_and_redaction"},
        {"burned_in_annotation": "not_declared"},
        {"basis": "operator_attested_crop_and_redaction"},
        {"source_rows": ROWS + 1},  # uncropped size must equal the source
    ],
)
def test_dicom_deidentification_record_is_closed(change):
    plane = dicom_plane()
    plane["deidentification"] = deid(plane, **change)
    with pytest.raises(ValueError):
        validate_manifest(manifest([plane], method="admitted_dicom_xa_frames"))


def test_dicom_geometry_and_container_rules():
    def check(plane):
        with pytest.raises(ValueError):
            validate_manifest(manifest([plane], method="admitted_dicom_xa_frames"))

    for geometry in (
        {**GEOMETRY, "source_isocenter_mm": 1300.0},
        {**GEOMETRY, "primary_deg": 200.0},
        {**GEOMETRY, "extra": 1.0},
        {key: value for key, value in GEOMETRY.items() if key != "primary_deg"},
        [],
    ):
        check(dicom_plane(geometry=geometry))
    # A crop moves the central ray off the middle of the stored frame.
    cropped = dicom_plane()
    cropped["deidentification"] = deid(
        cropped, source_rows=200, source_columns=200, crop=[10, 10, COLUMNS, ROWS]
    )
    check(cropped)
    cropped["geometry"] = None
    validate_manifest(manifest([cropped], method="admitted_dicom_xa_frames"))
    check(dicom_plane(container_sha256=None, container_bytes=None))
    check(dicom_plane(frames=[{**frame(0), "input_sha256": "e" * 64}]))


def test_store_reads_manifest_and_verified_frames(tmp_path):
    value = manifest()
    install(tmp_path, "run-01", value)
    store = InstalledFrameStore(tmp_path)
    loaded, revision = store.load("run-01")
    assert loaded == value
    assert (
        revision == hashlib.sha256((tmp_path / "run-01" / "frames.json").read_bytes()).hexdigest()
    )
    data, same = store.frame("run-01", "single", 12)
    assert data == pixels(12) and same == revision
    assert find_frame(value, "single", 3)[1]["index"] == 3
    for plane, index in (("a", 3), ("single", 4), ("single", True), ("single", "3")):
        with pytest.raises(FileNotFoundError):
            store.frame("run-01", plane, index)
    for source_id in ("missing", "../run-01", "RUN", "", None, "a"):
        with pytest.raises(FileNotFoundError):
            store.load(source_id)


def test_store_fails_closed_on_changed_missing_or_linked_files(tmp_path):
    value = manifest()
    directory = install(tmp_path, "run-01", value)
    store = InstalledFrameStore(tmp_path)
    target = directory / frame_filename("single", 3)
    original = target.read_bytes()
    for tampered in (original[:-1] + bytes([original[-1] ^ 1]), original[:-1], original + b"\0"):
        target.write_bytes(tampered)
        with pytest.raises(ValueError):
            store.frame("run-01", "single", 3)
    target.unlink()
    with pytest.raises(ValueError):
        store.frame("run-01", "single", 3)
    outside = tmp_path / "outside.gray"
    outside.write_bytes(original)
    os.symlink(outside, target)
    with pytest.raises(ValueError):
        store.frame("run-01", "single", 3)
    # The other frame is unaffected.
    assert store.frame("run-01", "single", 12)[0] == pixels(12)

    install(tmp_path, "big", manifest())
    (tmp_path / "big" / "frames.json").write_text(" " * (MAX_MANIFEST_BYTES + 1))
    with pytest.raises(ValueError):
        store.load("big")
    install(tmp_path, "bad", manifest())
    (tmp_path / "bad" / "frames.json").write_text(json.dumps(manifest(scope="private")))
    with pytest.raises(ValueError):
        store.load("bad")
    os.symlink(directory, tmp_path / "linked")
    with pytest.raises(ValueError):
        store.load("linked")
    (tmp_path / "empty").mkdir()
    with pytest.raises(FileNotFoundError):
        store.load("empty")


def test_store_refuses_an_ancestor_swapped_after_preflight(tmp_path, monkeypatch):
    root = tmp_path / "installed"
    root.mkdir()
    other = tmp_path / "outside"
    other.mkdir()
    # Matching hashes outside the store must not make a link acceptable.
    install(root, "run-01", manifest())
    install(other, "run-01", manifest())
    store = InstalledFrameStore(root)
    directory = store._directory

    def swapped(source_id):
        path = directory(source_id)
        root.rename(tmp_path / "held")
        root.symlink_to(other, target_is_directory=True)
        return path

    monkeypatch.setattr(store, "_directory", swapped)
    with pytest.raises(ValueError, match="installed file is not a regular file"):
        store.load("run-01")


def test_routes_serve_verified_frames_read_only(tmp_path):
    value = manifest([png_plane("a"), png_plane("b")])
    directory = install(tmp_path, "run-01", value)
    app = FastAPI()
    register_projection_frame_routes(app, InstalledFrameStore(tmp_path))
    client = TestClient(app)
    listed = client.get("/api/projection-frames/run-01")
    assert listed.status_code == 200, listed.text
    assert listed.headers["Cache-Control"] == "no-store"
    body = listed.json()
    assert body["manifest"] == value and body["source_id"] == "run-01"
    served = client.get("/api/projection-frames/run-01/planes/b/frames/12")
    assert served.status_code == 200
    assert served.content == pixels(12)
    assert served.headers["Content-Type"] == "application/octet-stream"
    assert served.headers["Cache-Control"] == "no-store"
    assert served.headers["X-Content-Type-Options"] == "nosniff"
    assert served.headers["X-Frame-Manifest-Revision"] == body["manifest_revision"]
    for path in (
        "/api/projection-frames/absent",
        "/api/projection-frames/run-01/planes/single/frames/12",
        "/api/projection-frames/run-01/planes/b/frames/4",
        "/api/projection-frames/run-01/planes/b/frames/-3",
        "/api/projection-frames/run-01/planes/b/frames/1e1",
        "/api/projection-frames/run-01/planes/b/frames/00000012",
        "/api/projection-frames/run-01/planes/b/frames/%D9%A3",
    ):
        assert client.get(path).status_code == 404, path
    # No route accepts pixels or changes a bundle.
    for method in ("post", "put", "patch", "delete"):
        assert getattr(client, method)("/api/projection-frames/run-01").status_code == 405
        assert (
            getattr(client, method)("/api/projection-frames/run-01/planes/b/frames/12").status_code
            == 405
        )
    (directory / frame_filename("b", 12)).write_bytes(pixels(13))
    broken = client.get("/api/projection-frames/run-01/planes/b/frames/12")
    assert broken.status_code == 503 and "integrity" in broken.json()["detail"]
    changed = copy.deepcopy(value)
    changed["scope"] = "private"
    (directory / "frames.json").write_text(json.dumps(changed))
    assert client.get("/api/projection-frames/run-01").status_code == 503
