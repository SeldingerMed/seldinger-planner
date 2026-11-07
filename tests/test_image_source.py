"""Tests for planner.image_source.CalibratedSourceStore (contract: docs/plans/calibrated-image-source-contract.md).

These are store-integrity tests with tiny synthetic bytes + trusted test-DI hashes.
They are NOT proof of valid image/model content; parent exercises the real source.
"""

from __future__ import annotations

import hashlib
import json
import os

import pytest

from planner.image_source import (
    CALIBRATED_IMAGE_SHA256,
    CALIBRATED_MANIFEST_SHA256,
    CALIBRATED_ROOT,
    CALIBRATED_SOURCE_ID,
    SOURCE_IMAGE_SHA256,
    CalibratedSourceStore,
)

AFFINE = [
    [-0.5, 0.0, 0.0, -1.0],
    [0.0, -0.5, 0.0, 2.0],
    [0.0, 0.0, 0.625, -3.0],
    [0.0, 0.0, 0.0, 1.0],
]


def make_manifest(**overrides):
    manifest = {
        "version": 1,
        "image": {
            "filename": "context-cta.nii.gz",
            "sha256": CALIBRATED_IMAGE_SHA256,
            "bytes": 8,
            "shape_xyz": [2, 2, 2],
            "dtype": "int32",
            "spatial_units": "mm",
            "affine_ras": AFFINE,
        },
        "crop": {"start_voxels": [0, 0, 0], "size_voxels": [2, 2, 2]},
        "source_image_sha256": SOURCE_IMAGE_SHA256,
        "source_provenance": {"source": "synthetic"},
        "clinical_validation": False,
        "application_installation": False,
        "selection_and_evidence_limits": {
            "independent_localization": False,
            "stl_frame_units_validated": False,
            "stl_registration_validated": False,
            "annotation_validated_anatomy": False,
        },
    }
    for key, value in overrides.items():
        if key == "image":
            manifest["image"].update(value)
        else:
            manifest[key] = value
    return manifest


def make_tree(tmp_path, manifest, image_bytes=b"\x00" * 8, *, symlink=None):
    root = tmp_path / "case"
    root.mkdir(exist_ok=True)
    image_path = root / manifest["image"]["filename"]
    image_path.write_bytes(image_bytes)
    manifest["image"]["bytes"] = len(image_bytes)
    manifest["image"]["sha256"] = hashlib.sha256(image_bytes).hexdigest()
    manifest_bytes = json.dumps(manifest).encode()
    if symlink == "root":
        link = tmp_path / "link"
        link.symlink_to(root, target_is_directory=True)
        root = link
    elif symlink == "manifest":
        (root / "manifest.json").symlink_to(root / "real-manifest.json")
        (root / "real-manifest.json").write_bytes(manifest_bytes)
        return root, manifest_bytes, image_path
    (root / "manifest.json").write_bytes(manifest_bytes)
    return root, manifest_bytes, image_path


def build_store(tmp_path, manifest=None, image_bytes=b"\x00" * 8, **kw):
    manifest = manifest if manifest is not None else make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest, image_bytes, **kw)
    return CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )


def test_constants_pinned():
    assert CALIBRATED_SOURCE_ID == "zenodo-case006-calibrated"
    assert CALIBRATED_ROOT.name == "context-v3"
    assert (
        CALIBRATED_ROOT.parts[-4:]
        == (
            "zenodo-15697196",
            "prepared-case-006",
            "context-v3",
        )
        or "prepared-case-006/context-v3" in CALIBRATED_ROOT.as_posix()
    )
    assert ".runtime" in CALIBRATED_ROOT.as_posix()
    assert CALIBRATED_IMAGE_SHA256.startswith("88f6e5a6")
    assert CALIBRATED_MANIFEST_SHA256.startswith("cb4f1ced")
    assert SOURCE_IMAGE_SHA256.startswith("98ecbced")
    assert CALIBRATED_SOURCE_ID in CalibratedSourceStore(CALIBRATED_ROOT).source_id


def test_load_returns_data_revision_image_path(tmp_path):
    store = build_store(tmp_path)
    data, revision, paths = store.load()
    assert data["version"] == 1
    assert paths["image"].name == "context-cta.nii.gz"
    assert revision == store.expected_manifest_sha256
    assert revision != store.expected_image_sha256


def test_load_rejects_manifest_hash_mismatch(tmp_path):
    store = build_store(tmp_path)
    store.expected_manifest_sha256 = "0" * 64
    with pytest.raises(ValueError):
        store.load()


def test_load_rejects_image_hash_mismatch(tmp_path):
    root, manifest_bytes, _image_path = make_tree(tmp_path, make_manifest(), b"\x01" * 8)
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256="0" * 64,
    )
    with pytest.raises(ValueError):
        store.load()


def test_load_rejects_wrong_image_bytes_recorded(tmp_path):
    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest, b"\x00" * 8)
    # Mutate the recorded byte count after hashing so it no longer matches the file.
    bad = json.loads(manifest_bytes)
    bad["image"]["bytes"] = 7
    bad_bytes = json.dumps(bad).encode()
    (root / "manifest.json").write_bytes(bad_bytes)
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(bad_bytes).hexdigest(),
        expected_image_sha256=bad["image"]["sha256"],
    )
    with pytest.raises(ValueError):
        store.load()


def test_load_rejects_image_too_large(tmp_path):
    manifest = make_manifest()
    root, manifest_bytes, _image_path = make_tree(tmp_path, manifest, b"\x00" * 17)
    # shrink the byte cap by overriding via a store subclass of limits is not
    # public; instead forge size past 16MiB is too slow, so test the <=16MiB
    # boundary via monkeypatched cap on the module constant.
    import planner.image_source as mod

    orig = mod.MAX_IMAGE_BYTES
    mod.MAX_IMAGE_BYTES = 4
    try:
        store = CalibratedSourceStore(
            root,
            expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
            expected_image_sha256=manifest["image"]["sha256"],
        )
        with pytest.raises(ValueError):
            store.load()
    finally:
        mod.MAX_IMAGE_BYTES = orig


def test_load_rejects_manifest_too_large(tmp_path):
    import planner.image_source as mod

    store = build_store(tmp_path)
    orig = mod.MAX_MANIFEST_BYTES
    mod.MAX_MANIFEST_BYTES = 4
    try:
        with pytest.raises(ValueError):
            store.load()
    finally:
        mod.MAX_MANIFEST_BYTES = orig


def test_load_missing_manifest(tmp_path):
    root = tmp_path / "empty"
    root.mkdir()
    store = CalibratedSourceStore(
        root, expected_manifest_sha256="0" * 64, expected_image_sha256="0" * 64
    )
    with pytest.raises(FileNotFoundError):
        store.load()


def test_load_malformed_json(tmp_path):
    root = tmp_path / "bad"
    root.mkdir()
    (root / "manifest.json").write_bytes(b"not json")
    (root / "context-cta.nii.gz").write_bytes(b"\x00" * 8)
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(b"not json").hexdigest(),
        expected_image_sha256="0" * 64,
    )
    with pytest.raises(ValueError):
        store.load()


def test_load_rejects_symlink_root(tmp_path):
    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest, symlink="root")
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    with pytest.raises((ValueError, OSError)):
        store.load()


def test_load_rejects_symlink_manifest(tmp_path):
    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest, symlink="manifest")
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    with pytest.raises((ValueError, OSError)):
        store.load()


def test_load_rejects_symlink_image(tmp_path):
    manifest = make_manifest()
    root = tmp_path / "case"
    root.mkdir()
    real = tmp_path / "elsewhere.nii.gz"
    real.write_bytes(b"\x00" * 8)
    (root / "context-cta.nii.gz").symlink_to(real)
    (root / "manifest.json").write_bytes(json.dumps(manifest).encode())
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(json.dumps(manifest).encode()).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    with pytest.raises((ValueError, OSError)):
        store.load()


def test_load_rejects_flags_true(tmp_path):
    for path, value in [
        (("clinical_validation",), True),
        (("application_installation",), True),
        (("selection_and_evidence_limits", "independent_localization"), True),
        (("selection_and_evidence_limits", "stl_registration_validated"), True),
        (("selection_and_evidence_limits", "stl_frame_units_validated"), True),
        (("selection_and_evidence_limits", "annotation_validated_anatomy"), True),
    ]:
        manifest = make_manifest()
        node = manifest
        for key in path[:-1]:
            node = node[key]
        node[path[-1]] = value
        with pytest.raises((ValueError, OSError)):
            build_store(tmp_path, manifest).load()


def test_load_rejects_source_image_sha_mismatch(tmp_path):
    manifest = make_manifest(source_image_sha256="9" * 64)
    with pytest.raises(ValueError):
        build_store(tmp_path, manifest).load()


def test_load_rejects_bad_version(tmp_path):
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(version=2)).load()


@pytest.mark.parametrize(
    "bad", [[0, 2, 2], [-1, 2, 2], [2049, 2, 2], [2.5, 2, 2], [2048, 2048, 2048]]
)
def test_load_rejects_bad_dimensions(tmp_path, bad):
    manifest = make_manifest(
        image={"shape_xyz": bad}, crop={"start_voxels": [0, 0, 0], "size_voxels": bad}
    )
    with pytest.raises(ValueError):
        build_store(tmp_path, manifest).load()


def test_load_rejects_crop_size_mismatch(tmp_path):
    manifest = make_manifest(crop={"start_voxels": [0, 0, 0], "size_voxels": [1, 2, 2]})
    with pytest.raises(ValueError):
        build_store(tmp_path, manifest).load()


def test_load_rejects_negative_crop_start(tmp_path):
    manifest = make_manifest(crop={"start_voxels": [-1, 0, 0], "size_voxels": [2, 2, 2]})
    with pytest.raises(ValueError):
        build_store(tmp_path, manifest).load()


def test_load_rejects_bad_dtype_or_units(tmp_path):
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"dtype": "float32"})).load()
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"spatial_units": "vox"})).load()


def test_load_rejects_bad_affine(tmp_path):
    nan_affine = [row[:] for row in AFFINE]
    nan_affine[0][0] = float("nan")
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"affine_ras": nan_affine})).load()
    singular = [row[:] for row in AFFINE]
    singular[0][0] = 0.0
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"affine_ras": singular})).load()
    bad_last_row = [row[:] for row in AFFINE]
    bad_last_row[3][0] = 1.0
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"affine_ras": bad_last_row})).load()


def test_load_rejects_nonpositive_spacing(tmp_path):
    zero = [row[:] for row in AFFINE]
    zero[2][2] = 0.0
    with pytest.raises(ValueError):
        build_store(tmp_path, make_manifest(image={"affine_ras": zero})).load()


def test_load_rejects_nonregular_image(tmp_path):
    manifest = make_manifest()
    root = tmp_path / "case"
    root.mkdir()
    os.mkfifo(root / "context-cta.nii.gz")
    (root / "manifest.json").write_bytes(json.dumps(manifest).encode())
    store = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(json.dumps(manifest).encode()).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    with pytest.raises((ValueError, OSError)):
        store.load()


def test_metadata_exact_shape(tmp_path):
    store = build_store(tmp_path)
    bundle = store.load()
    meta = store.metadata(bundle)
    expected_keys = {
        "source_id",
        "case_label",
        "source_url",
        "license_url",
        "citation",
        "image_sha256",
        "image_url",
        "reference_revision",
        "spatial_units",
        "dimensions",
        "spacing_mm",
        "image_affine_ras",
        "method",
        "selection_basis",
        "clinical_validation",
        "stl_registration_validated",
    }
    assert set(meta) == expected_keys
    assert meta["source_id"] == "zenodo-case006-calibrated"
    assert meta["source_url"] == "https://doi.org/10.5281/zenodo.15697196"
    assert meta["license_url"] == "https://creativecommons.org/licenses/by/4.0/"
    assert meta["image_url"] == "/api/image-sources/zenodo-case006-calibrated/volume"
    assert meta["method"] == "calibrated_context_crop"
    assert meta["selection_basis"] == "reference-informed candidate context"
    assert meta["clinical_validation"] is False
    assert meta["stl_registration_validated"] is False
    assert meta["spatial_units"] == "mm"
    assert meta["dimensions"] == [2, 2, 2]
    assert meta["reference_revision"] == bundle[1]
    assert isinstance(meta["citation"], str) and meta["citation"]
    assert len(meta["spacing_mm"]) == 3
    assert all(s > 0 for s in meta["spacing_mm"])
    assert meta["image_affine_ras"] == AFFINE
    for forbidden in ("annotation", "mesh", "transform", "focus"):
        assert not any(forbidden in key for key in meta)


def test_metadata_adds_case_id_only_when_supplied(tmp_path):
    store = build_store(tmp_path)
    bundle = store.load()
    assert "case_id" not in store.metadata(bundle)
    assert store.metadata(bundle, case_id="case-006")["case_id"] == "case-006"


def test_metadata_no_curated_annotation_fields(tmp_path):
    store = build_store(tmp_path)
    bundle = store.load()
    data = bundle[0]
    assert "annotations" not in data
    meta = store.metadata(bundle)
    assert "annotations" not in meta
    assert meta["source_id"] != "curated-annotations"


def test_planning_constants_pinned():
    from planner.image_source import (
        PLANNING_IMAGE_SHA256,
        PLANNING_MANIFEST_SHA256,
        PLANNING_ROOT,
        PLANNING_SOURCE_ID,
        PlanningSourceStore,
    )

    assert PLANNING_SOURCE_ID == "zenodo-case006-planning-context"
    assert "prepared-case-006/context-planning-v1" in PLANNING_ROOT.as_posix()
    assert ".runtime" in PLANNING_ROOT.as_posix()
    assert PLANNING_IMAGE_SHA256 == (
        "26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473"
    )
    assert PLANNING_MANIFEST_SHA256 == (
        "92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e"
    )
    assert PlanningSourceStore(PLANNING_ROOT).source_id == PLANNING_SOURCE_ID
    assert PLANNING_SOURCE_ID != CALIBRATED_SOURCE_ID


def test_planning_synthetic_di_load_and_metadata(tmp_path):
    from planner.image_source import (
        PLANNING_SOURCE_ID,
        PlanningSourceStore,
    )

    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest)
    store = PlanningSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    data, revision, paths = store.load()
    assert revision == store.expected_manifest_sha256
    assert paths["image"].name == "context-cta.nii.gz"
    meta = store.metadata(bundle=(data, revision, paths), case_id="case-006")
    assert meta["source_id"] == "zenodo-case006-planning-context"
    assert meta["case_label"] == "Zenodo case 006 planning context"
    assert meta["image_url"] == f"/api/image-sources/{PLANNING_SOURCE_ID}/volume"
    assert meta["method"] == "calibrated_context_crop"
    assert meta["selection_basis"] == "reference-informed candidate context"
    assert meta["clinical_validation"] is False
    assert meta["stl_registration_validated"] is False
    assert meta["case_id"] == "case-006"
    # distinct pins vs calibrated source
    assert store.expected_image_sha256 != CALIBRATED_IMAGE_SHA256
    assert PLANNING_SOURCE_ID != CALIBRATED_SOURCE_ID


def test_planning_default_constructor_uses_planning_pins(tmp_path):
    from planner.image_source import (
        PLANNING_IMAGE_SHA256,
        PLANNING_MANIFEST_SHA256,
        PlanningSourceStore,
    )

    store = PlanningSourceStore(tmp_path)
    assert store.root == tmp_path
    assert store.expected_manifest_sha256 == PLANNING_MANIFEST_SHA256
    assert store.expected_image_sha256 == PLANNING_IMAGE_SHA256
    assert store.source_id == "zenodo-case006-planning-context"


def test_calibrated_defaults_unchanged(tmp_path):
    store = CalibratedSourceStore()
    assert store.source_id == CALIBRATED_SOURCE_ID
    assert store.root == CALIBRATED_ROOT
    assert store.expected_manifest_sha256 == CALIBRATED_MANIFEST_SHA256
    assert store.expected_image_sha256 == CALIBRATED_IMAGE_SHA256
    # legacy synthetic metadata keeps old identity
    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest)
    legacy = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    meta = legacy.metadata(legacy.load())
    assert meta["source_id"] == "zenodo-case006-calibrated"
    assert meta["case_label"] == "Zenodo case 006 calibrated context"
    assert meta["image_url"] == "/api/image-sources/zenodo-case006-calibrated/volume"


def test_planning_and_calibrated_metadata_distinct(tmp_path):
    from planner.image_source import PlanningSourceStore

    manifest = make_manifest()
    root, manifest_bytes, _ = make_tree(tmp_path, manifest)
    planning = PlanningSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    calibrated = CalibratedSourceStore(
        root,
        expected_manifest_sha256=hashlib.sha256(manifest_bytes).hexdigest(),
        expected_image_sha256=manifest["image"]["sha256"],
    )
    pm = planning.metadata(planning.load())
    cm = calibrated.metadata(calibrated.load())
    assert pm["source_id"] != cm["source_id"]
    assert pm["case_label"] != cm["case_label"]
    assert pm["image_url"] != cm["image_url"]


def test_actual_planning_manifest_matches_contract(tmp_path):
    """Read-only sanity of the real planning manifest (no image arrays)."""
    from planner.image_source import (
        PLANNING_IMAGE_SHA256,
        PLANNING_MANIFEST_SHA256,
        PLANNING_ROOT,
        PlanningSourceStore,
    )

    manifest_path = PLANNING_ROOT / "manifest.json"
    if not manifest_path.is_file():
        pytest.skip("actual planning source not present")
    manifest_bytes = manifest_path.read_bytes()
    assert hashlib.sha256(manifest_bytes).hexdigest() == PLANNING_MANIFEST_SHA256
    manifest = json.loads(manifest_bytes)
    assert manifest["version"] == 1
    assert manifest["clinical_validation"] is False
    assert manifest["application_installation"] is False
    assert manifest["source_image_sha256"] == SOURCE_IMAGE_SHA256
    img = manifest["image"]
    assert img["dtype"] == "int32"
    assert img["spatial_units"] == "mm"
    assert img["sha256"] == PLANNING_IMAGE_SHA256
    assert img["shape_xyz"] == [200, 200, 180]
    # Hash raw image bytes only; never decode arrays.
    image_path = PLANNING_ROOT / img["filename"]
    if not image_path.is_file():
        pytest.skip("actual planning image not present")
    assert _sha256_raw(image_path) == PLANNING_IMAGE_SHA256
    store = PlanningSourceStore()
    data, revision, paths = store.load()
    assert revision == PLANNING_MANIFEST_SHA256
    assert paths["image"].is_file()
    assert data["image"]["shape_xyz"] == [200, 200, 180]


def _sha256_raw(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def test_actual_manifest_matches_contract(tmp_path):
    """Read-only sanity of the real small manifest (no image arrays)."""
    manifest_path = CALIBRATED_ROOT / "manifest.json"
    if not manifest_path.is_file():
        pytest.skip("actual prepared source not present")
    manifest = json.loads(manifest_path.read_bytes())
    assert manifest["version"] == 1
    assert manifest["clinical_validation"] is False
    assert manifest["application_installation"] is False
    assert manifest["source_image_sha256"] == SOURCE_IMAGE_SHA256
    img = manifest["image"]
    assert img["dtype"] == "int32"
    assert img["spatial_units"] == "mm"
    assert img["sha256"] == CALIBRATED_IMAGE_SHA256
    assert "source_header" not in manifest
    limits = manifest["selection_and_evidence_limits"]
    for flag in (
        "independent_localization",
        "stl_frame_units_validated",
        "stl_registration_validated",
        "annotation_validated_anatomy",
    ):
        assert limits[flag] is False
    # Real store loads against the actual root without touching image arrays.
    store = CalibratedSourceStore()
    data, revision, paths = store.load()
    assert revision == CALIBRATED_MANIFEST_SHA256
    assert paths["image"].is_file()
    assert data["image"]["filename"] == "context-cta.nii.gz"
