"""Synthetic NIfTI source installation, integrity and real worker contracts."""

import gzip
import hashlib
import json
import struct

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from planner import image_source, segmentation_worker
from planner.image_source import InstalledNiftiSourceStore
from planner.source_registry import ImageSourceRegistry, register_image_source_routes


def install_source(tmp_path):
    root = tmp_path / "synthetic-cta"
    root.mkdir()
    header = bytearray(352)
    struct.pack_into("<i", header, 0, 348)
    struct.pack_into("<8h", header, 40, 3, 4, 5, 6, 1, 1, 1, 1)
    struct.pack_into("<2h", header, 70, 4, 16)
    struct.pack_into("<8f", header, 76, 1, 1, 1, 1, 1, 1, 1, 1)
    struct.pack_into("<f", header, 108, 352)
    header[123] = 2
    struct.pack_into("<h", header, 254, 1)
    for row, values in enumerate([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]):
        struct.pack_into("<4f", header, 280 + row * 16, *values)
    header[344:348] = b"n+1\x00"
    payload = gzip.compress(bytes(header) + bytes(4 * 5 * 6 * 2), mtime=0)
    (root / "context-cta.nii.gz").write_bytes(payload)
    manifest = {
        "version": 1,
        "clinical_validation": False,
        "source_provenance": {"data_scope": "synthetic", "permitted_use": "local tests"},
        "image": {
            "filename": "context-cta.nii.gz",
            "dtype": "int16",
            "spatial_units": "mm",
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "shape_xyz": [4, 5, 6],
            "affine_ras": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest))
    return root, manifest


def test_dynamic_source_metadata_volume_and_worker_use_same_identity(tmp_path, monkeypatch):
    root, manifest = install_source(tmp_path)
    monkeypatch.setattr(image_source, "INSTALLED_SOURCES_ROOT", tmp_path)
    registry = ImageSourceRegistry(None, installed_sources_root=tmp_path)
    sha = manifest["image"]["sha256"]
    case = {
        "case_id": "synthetic",
        "image_sha256": sha,
        "spatial_units": "mm",
        "spacing_mm": [1, 1, 1],
        "dimensions": [4, 5, 6],
    }
    bundle = registry.load_for_case(case)
    assert registry.find_installed_source_by_hash(sha) == root.name
    assert bundle[1] == hashlib.sha256((root / "manifest.json").read_bytes()).hexdigest()
    assert bundle[1] != sha
    app = FastAPI()
    register_image_source_routes(app, registry, lambda _: case)
    client = TestClient(app)
    metadata = client.get("/api/cases/synthetic/image-source")
    assert metadata.status_code == 200, metadata.text
    assert metadata.json()["image_sha256"] == sha
    assert metadata.json()["clinical_validation"] is False
    assert (
        client.get(f"/api/image-sources/{root.name}/volume").content
        == bundle[2]["image"].read_bytes()
    )
    worker_bundle = segmentation_worker._source_bundle(
        {"source_id": root.name, "image_path": "/ignored/request-path"}
    )
    assert worker_bundle[1:] == (bundle[1], bundle[2]["image"], "mm")


@pytest.mark.parametrize(
    "change",
    [
        {"filename": ".."},
        {"filename": ""},
        {"sha256": "z" * 64},
        {"spatial_units": "unknown"},
        {"shape_xyz": [4, 5, 7]},
        {"affine_ras": [[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]},
        {"dtype": "float32"},
    ],
)
def test_custom_source_rejects_invalid_manifest_and_header_mismatch(tmp_path, change):
    root, manifest = install_source(tmp_path)
    manifest["image"].update(change)
    (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        InstalledNiftiSourceStore(root, source_id=root.name).load()


def test_custom_source_rejects_bad_crop(tmp_path):
    root, manifest = install_source(tmp_path)
    manifest["crop"] = {"start_voxels": [-1, 0, 0], "size_voxels": [4, 5, 6]}
    (root / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="crop"):
        InstalledNiftiSourceStore(root, source_id=root.name).load()


def test_custom_source_rejects_tamper_and_symlink(tmp_path):
    root, _ = install_source(tmp_path)
    path = root / "context-cta.nii.gz"
    original = path.read_bytes()
    path.write_bytes(original + b"tamper")
    with pytest.raises(ValueError):
        InstalledNiftiSourceStore(root, source_id=root.name).load()
    path.unlink()
    target = tmp_path / "other.nii.gz"
    target.write_bytes(original)
    path.symlink_to(target)
    with pytest.raises(ValueError):
        InstalledNiftiSourceStore(root, source_id=root.name).load()


def test_registry_skips_malformed_and_oversized_manifests(tmp_path):
    root, _ = install_source(tmp_path)
    (root / "manifest.json").write_text('{"image": "not-an-object"}')
    registry = ImageSourceRegistry(None, installed_sources_root=tmp_path)
    assert registry.find_installed_source_by_hash("a" * 64) is None
    (root / "manifest.json").write_text(" " * (image_source.MAX_MANIFEST_BYTES + 1))
    assert registry.find_installed_source_by_hash("a" * 64) is None


def test_source_root_cannot_be_reached_through_symlinked_installation(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    root, _manifest = install_source(real)
    link = tmp_path / "linked"
    link.symlink_to(real, target_is_directory=True)
    registry = ImageSourceRegistry(None, installed_sources_root=link)
    with pytest.raises(HTTPException):
        registry.load_public(root.name)
    with pytest.raises(ValueError, match="symlink"):
        InstalledNiftiSourceStore(link / root.name, source_id=root.name).load()


def test_registry_rejects_ambiguous_image_hash_claims(tmp_path):
    import shutil

    root, manifest = install_source(tmp_path)
    shutil.copytree(root, tmp_path / "second-source")
    registry = ImageSourceRegistry(None, installed_sources_root=tmp_path)
    with pytest.raises(HTTPException) as exc:
        registry.find_installed_source_by_hash(manifest["image"]["sha256"])
    assert exc.value.status_code == 503


def test_uncompressed_volume_download_retains_its_filename(tmp_path):
    root, manifest = install_source(tmp_path)
    path = root / "synthetic.nii"
    payload = gzip.decompress((root / "context-cta.nii.gz").read_bytes())
    path.write_bytes(payload)
    manifest["image"].update(
        filename=path.name, bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest()
    )
    (root / "manifest.json").write_text(json.dumps(manifest))
    app = FastAPI()
    register_image_source_routes(
        app, ImageSourceRegistry(None, installed_sources_root=tmp_path), lambda _: {}
    )
    response = TestClient(app).get(f"/api/image-sources/{root.name}/volume")
    assert response.status_code == 200, response.text
    assert response.headers["content-disposition"] == 'attachment; filename="synthetic.nii"'
    assert response.content == payload


def test_source_change_invalidates_case_calibration(tmp_path):
    _root, manifest = install_source(tmp_path)
    registry = ImageSourceRegistry(None, installed_sources_root=tmp_path)
    with pytest.raises(HTTPException) as exc:
        registry.load_for_case(
            {
                "image_sha256": manifest["image"]["sha256"],
                "spatial_units": "mm",
                "dimensions": [4, 5, 6],
                "spacing_mm": [2, 1, 1],
            }
        )
    assert exc.value.status_code == 409
