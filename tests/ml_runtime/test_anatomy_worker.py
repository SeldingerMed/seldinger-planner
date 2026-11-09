"""Anatomy proposal job adapter: verified native bytes into bounded proposals.

``compute_proposal_job`` is a pure job function for the parent-owned bounded
physics supervisor. It re-verifies the exact source and mask bytes against
their declared hashes, decodes them through the shared bounded native loader,
runs the existing anatomy proposal helper on the admitted synthetic or
installed source, and returns a source-bound proposal envelope. No clinical
validation and no automatic aneurysm detection are established here.
"""

import gzip
import hashlib
import json
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np
from test_anatomy_proposals import _green_masks

from planner.anatomy_worker import PROPOSAL_VERSION, compute_proposal_job

REVISION = "b" * 64
CASE_ID = "synthetic-case-01"
ARTIFACT_VERSION = "3"


def _save_nifti(array, affine, path, *, dtype=None):
    import nibabel as nib

    image = nib.Nifti1Image(
        array if dtype is None else array.astype(dtype), np.asarray(affine, dtype=float)
    )
    image.header.set_xyzt_units("mm", "sec")
    image.header["scl_slope"] = 1.0
    image.header["scl_inter"] = 0.0
    nib.save(image, str(path))
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _install_fixtures(tmp_path):
    """Write a calibrated source plus content-addressed mask blobs."""
    import nibabel as nib

    vessel, aneurysm = _green_masks()
    shape = tuple(int(v) for v in aneurysm.shape)
    affine = np.eye(4)
    source_path = tmp_path / "source.nii.gz"
    source_sha = _save_nifti(np.zeros(shape, dtype=np.int16), affine, source_path, dtype=np.int16)
    blobs = tmp_path / "blobs"
    blobs.mkdir()
    masks = {}
    for role, array in (("vessel", vessel), ("aneurysm", aneurysm)):
        staged = tmp_path / f"{role}.nii.gz"
        digest = _save_nifti(array, affine, staged, dtype=np.uint8)
        staged.rename(blobs / f"{digest}.nii.gz")
        masks[role] = {
            "candidate_id": f"candidate-{role}",
            "mask_sha256": digest,
            "segmentation_revision": 1,
        }
    manifest_image = {
        "sha256": source_sha,
        "shape_xyz": list(shape),
        "dtype": "int16",
        "affine_ras": [[float(v) for v in row] for row in affine],
    }
    # Sanity: the saved header really carries mm units so the installed-NIfTI
    # validator accepts it without special pleading.
    with gzip.open(source_path, "rb") as stream:
        raw = stream.read()
    assert nib.Nifti1Image.from_bytes(raw).header.get_xyzt_units()[0] == "mm"
    return source_path, blobs, manifest_image, masks


def _make_job(manifest_image, masks):
    return {
        "kind": "anatomy-proposal",
        "case_id": CASE_ID,
        "image_sha256": manifest_image["sha256"],
        "artifact_version": ARTIFACT_VERSION,
        "reference_revision": REVISION,
        "source_id": "zenodo-case006-calibrated",
        "dependencies": {
            "case_id": CASE_ID,
            "image_sha256": manifest_image["sha256"],
            "artifact_version": ARTIFACT_VERSION,
            "source_revision": REVISION,
            "masks": json.loads(json.dumps(masks)),
            "calculation_version": PROPOSAL_VERSION,
        },
        "target_ras": None,
    }


def _run(job, source_path, blobs, manifest_image, monkeypatch):
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )
    return compute_proposal_job(job, blob_dir=blobs.parent)


def test_green_synthetic_tube_and_sac_returns_bounded_proposal(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    result = _run(job, source_path, blobs, manifest_image, monkeypatch)

    assert result["proposal_version"] == PROPOSAL_VERSION
    assert result["operator_confirmation_required"] is True
    assert result["method"] == "accepted_mask_anatomy_geometry_proposal"
    inputs = result["inputs"]
    assert set(inputs) == {
        "neck_origin",
        "neck_normal",
        "aneurysm_seed",
        "parent_path",
        "proximal_index",
        "distal_index",
    }
    neck = np.asarray(inputs["neck_origin"])
    assert np.linalg.norm(neck - [8.0, 6.0, 12.0]) <= 1.5
    normal = np.asarray(inputs["neck_normal"])
    assert abs(np.linalg.norm(normal) - 1.0) <= 1e-9
    assert result["diagnostics"]["interface_voxel_count"] >= 3
    assert result["diagnostics"]["target_component_selected"] is False
    # Dependency envelope: identity-frozen and job-hash-bound.
    assert result["dependencies"]["calculation_version"] == PROPOSAL_VERSION
    frozen = result["dependencies"]
    assert isinstance(frozen, dict)
    assert json.loads(json.dumps(result))["dependencies"] == job["dependencies"]
    job["dependencies"]["masks"]["vessel"]["candidate_id"] = "mutated-after-return"
    assert frozen["masks"]["vessel"]["candidate_id"] == "candidate-vessel"
    job["dependencies"]["masks"]["vessel"]["candidate_id"] = "candidate-vessel"
    assert (
        hashlib.sha256(
            json.dumps(job, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest()
        == result["job_sha256"]
    )


def test_green_explicit_target_selects_sac_component(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    job["target_ras"] = [8.0, 3.0, 12.0]
    result = _run(job, source_path, blobs, manifest_image, monkeypatch)
    assert result["diagnostics"]["target_component_selected"] is True


def test_source_hash_identity_mismatch_is_rejected(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    job["image_sha256"] = "a" * 64
    job["dependencies"]["image_sha256"] = "a" * 64
    with pytest.raises(ValueError, match="identity"):
        _run(job, source_path, blobs, manifest_image, monkeypatch)


def test_mask_hash_mismatch_is_rejected(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    job["dependencies"]["masks"]["vessel"]["mask_sha256"] = "c" * 64
    with pytest.raises(ValueError):
        _run(job, source_path, blobs, manifest_image, monkeypatch)


def test_mask_grid_mismatch_is_rejected(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    import nibabel as nib

    stale = nib.Nifti1Image(np.ones((8, 8, 8), dtype=np.uint8), np.eye(4))
    stale.header.set_xyzt_units("mm", "sec")
    stale.header["scl_slope"] = 1.0
    stale.header["scl_inter"] = 0.0
    path = tmp_path / "stale.nii.gz"
    nib.save(stale, str(path))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    (blobs / f"{digest}.nii.gz").write_bytes(path.read_bytes())
    job = _make_job(manifest_image, masks)
    job["dependencies"]["masks"]["vessel"]["mask_sha256"] = digest
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )
    with pytest.raises(ValueError, match="grid|geometry"):
        compute_proposal_job(job, blob_dir=blobs.parent)


def test_unknown_source_units_are_rejected(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "unknown"),
    )
    with pytest.raises(ValueError, match="unit"):
        compute_proposal_job(job, blob_dir=blobs.parent)


def test_bytes_changed_after_helper_are_rejected(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    from planner import anatomy_proposals, segmentation_worker

    real_helper = anatomy_proposals.propose_aneurysm_inputs

    def mutating_helper(*args, **kwargs):
        original = source_path.read_bytes()
        source_path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
        assert hashlib.sha256(source_path.read_bytes()).hexdigest() != job["image_sha256"]
        return real_helper(*args, **kwargs)

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )
    monkeypatch.setattr(anatomy_proposals, "propose_aneurysm_inputs", mutating_helper)
    with pytest.raises(ValueError, match="mismatch|hash"):
        compute_proposal_job(job, blob_dir=blobs.parent)


def test_dependency_identity_and_revision_guards(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )

    def expect_reject(mutate, match):
        job = _make_job(manifest_image, masks)
        mutate(job)
        with pytest.raises(ValueError, match=match):
            compute_proposal_job(job, blob_dir=blobs.parent)

    expect_reject(lambda j: j.update(kind="centerline"), "kind")
    expect_reject(lambda j: j["dependencies"].update(case_id="other"), "identity")
    expect_reject(lambda j: j["dependencies"].update(source_revision="c" * 64), "identity")
    expect_reject(
        lambda j: j["dependencies"].update(calculation_version="other-v9"),
        "identity",
    )
    expect_reject(
        lambda j: j["dependencies"]["masks"]["vessel"].update(segmentation_revision=0),
        "revision",
    )
    expect_reject(
        lambda j: j["dependencies"]["masks"]["vessel"].update(candidate_id="bad id!"),
        "identity",
    )
    expect_reject(lambda j: j["dependencies"].update(masks={"vessel": {}}), "mask roles")
    expect_reject(
        lambda j: j["dependencies"]["masks"]["vessel"].pop("segmentation_revision"),
        "mask",
    )


def test_target_ras_must_be_three_actual_finite_numbers(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )
    for bad in ([1.0, 2.0], [0.0, float("nan"), 0.0], [True, 2.0, 3.0], ["8", 4.0, 5.0]):
        job = _make_job(manifest_image, masks)
        job["target_ras"] = bad
        with pytest.raises(ValueError, match="target"):
            compute_proposal_job(job, blob_dir=blobs.parent)


@pytest.mark.parametrize(
    "change",
    [
        {"artifact_version": "not-a-version"},
        {"reference_revision": "not-a-hash"},
        {"source_id": "../outside"},
        {"source_path": "/arbitrary"},
    ],
)
def test_exact_job_identity_and_closed_shape(tmp_path, monkeypatch, change):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    job.update(change)
    if "artifact_version" in change:
        job["dependencies"]["artifact_version"] = change["artifact_version"]
    if "reference_revision" in change:
        job["dependencies"]["source_revision"] = change["reference_revision"]
    with pytest.raises(ValueError):
        _run(job, source_path, blobs, manifest_image, monkeypatch)


def test_unrepresentable_integer_target_is_a_bounded_input_rejection(tmp_path, monkeypatch):
    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    job = _make_job(manifest_image, masks)
    job["target_ras"] = [10**1000, 2.0, 3.0]
    with pytest.raises(ValueError, match="target"):
        _run(job, source_path, blobs, manifest_image, monkeypatch)


def test_scaled_mask_is_rejected_as_non_native(tmp_path, monkeypatch):
    import nibabel as nib

    source_path, blobs, manifest_image, masks = _install_fixtures(tmp_path)
    vessel, _aneurysm = _green_masks()
    image = nib.Nifti1Image(vessel, np.eye(4))
    image.header.set_xyzt_units("mm", "sec")
    image.header["scl_slope"] = 2.0
    image.header["scl_inter"] = 0.0
    path = tmp_path / "scaled.nii.gz"
    nib.save(image, str(path))
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    (blobs / f"{digest}.nii.gz").write_bytes(path.read_bytes())
    job = _make_job(manifest_image, masks)
    job["dependencies"]["masks"]["vessel"]["mask_sha256"] = digest
    from planner import segmentation_worker

    monkeypatch.setattr(
        segmentation_worker,
        "_source_bundle",
        lambda _job: ({"image": manifest_image}, REVISION, source_path, "mm"),
    )
    with pytest.raises(ValueError):
        compute_proposal_job(job, blob_dir=blobs.parent)
