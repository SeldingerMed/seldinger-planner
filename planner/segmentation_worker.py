"""Local segmentation worker: fixed-artifact vessel/SAM inference child process.

The trusted backend calls :func:`run_local_model`, which executes the installed
project ML runtime (``.runtime/ml-runtime``) as a subprocess running this same
module as a CLI. Heavy ML libraries are imported only inside functions, so the
base server environment never loads them. The child reads the fixed installed
original public reference bundle (never job-supplied paths or URLs), verifies
the manifest revision and actual image SHA-256, and produces an unaccepted
candidate mask plus JSON metadata. This is not automatic aneurysm detection
and carries no clinical validation.
"""

import json
import subprocess
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
ML_PYTHON = _REPO_ROOT / ".runtime" / "ml-runtime" / "bin" / "python"
REFERENCE_DIR = _REPO_ROOT / ".runtime" / "public-reference"
REFERENCE_IMAGE = REFERENCE_DIR / "reference-cta.nii.gz"
MASK_BLOB_DIR = _REPO_ROOT / ".runtime" / "inference-results" / "blobs"
_MAX_MASK_BYTES = 16 * 1024 * 1024
VESSEL_CHECKPOINT = _REPO_ROOT / ".runtime" / "models" / "pooled-vessel-v1" / "checkpoint_best.pth"
VESSEL_LANDMARKS = _REPO_ROOT / ".runtime" / "models" / "pooled-vessel-v1" / "landmarks.npz"
SAM_CHECKPOINT = _REPO_ROOT / ".runtime" / "models" / "sam2.1-tiny" / "sam2.1_hiera_tiny.pt"
ANEURYSM_PYTHON = _REPO_ROOT / ".runtime" / "aneurysm-runtime" / "bin" / "python"
ANEURYSM_CHECKPOINT = (
    _REPO_ROOT
    / ".runtime"
    / "models"
    / "rsna-aneurysm-stage2-v2"
    / "Dataset660_26classes_resize224_4661"
    / "onlyMirror01_lr4e3_100epochs_ps224"
    / "fold_0"
    / "checkpoint_final.pth"
)
# Trusted interpreter constants selected only by the fixed job kind. Runtime
# paths are never job inputs; requests cannot select runtime, device,
# checkpoint, expected hash, model name or paths.
_KIND_PYTHON = {
    "vessel": ML_PYTHON,
    "sam2": ML_PYTHON,
    "aneurysm": ANEURYSM_PYTHON,
}

SUBPROCESS_TIMEOUT_SECONDS = 180
_MAX_VOXELS = 8_000_000
_CPU_THREADS = 4
_DIAGNOSTIC_CHARS = 200


def ras_to_native_prompt(point_ras, affine, native_shape):
    """Map one RAS point to a native-voxel prompt via the inverse source affine.

    Returns ``(i, j, k)`` where ``i``/``j`` are the in-plane native column/row
    prompt (floats, x=i, y=j on the displayed plane ``volume[:, :, k].T``) and
    ``k`` is the nearest native axial slice index. The point must be finite and
    lie inside the volume; no silent clamping is performed. The source affine is
    authoritative; client metadata is never used.
    """
    import numpy as np

    shape = tuple(int(value) for value in native_shape)
    if len(shape) != 3 or min(shape) < 1:
        raise ValueError("native_shape must be three positive dimensions")
    matrix = np.asarray(affine, dtype=np.float64)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
        raise ValueError("affine must be a finite 4x4 matrix")
    point = np.asarray(point_ras, dtype=np.float64)
    if point.shape != (3,) or not np.isfinite(point).all():
        raise ValueError("point_ras must be three finite numbers")
    ijk = (np.linalg.inv(matrix) @ np.asarray([*point, 1.0]))[:3]
    if not np.isfinite(ijk).all():
        raise ValueError("inverse affine produced a non-finite voxel coordinate")
    i, j, k_raw = (float(value) for value in ijk)
    if not (0 <= i <= shape[0] - 1 and 0 <= j <= shape[1] - 1 and 0 <= k_raw <= shape[2] - 1):
        raise ValueError("RAS prompt falls outside the native image volume")
    return i, j, round(k_raw)


def clip_prompt_box(i, j, radius_voxels, width, height):
    """Clipped prompt box (x0, y0, x1, y1) strictly inside a width x height frame."""
    radius = int(radius_voxels)
    if not 2 <= radius <= 40:
        raise ValueError("radius_voxels must be an integer in 2..40")
    width, height = int(width), int(height)
    x0, x1 = max(0.0, float(i) - radius), min(float(width - 1), float(i) + radius)
    y0, y1 = max(0.0, float(j) - radius), min(float(height - 1), float(j) + radius)
    if not (0 <= x0 < x1 < width and 0 <= y0 < y1 < height):
        raise ValueError("prompt box cannot be placed inside the frame")
    return [x0, y0, x1, y1]


def _sanitize(text):
    """Bounded single-line diagnostics with filesystem paths redacted."""
    excerpt = " ".join(str(text).split())[-_DIAGNOSTIC_CHARS:]
    for secret in (_REPO_ROOT, Path.home()):
        excerpt = excerpt.replace(str(secret), "[redacted]")
    return excerpt


def run_local_model(job, output_dir):
    """Run the installed local model for one validated job in a child process.

    Executes the fixed project ML runtime as ``python -m
    planner.segmentation_worker <output_dir>`` with the JSON job on stdin, no
    shell, a 180 second timeout, and captured output. On success returns
    ``{"mask_path": Path, "metadata": dict}`` reading the child's artifacts from
    the private staging ``output_dir``. Failures raise a sanitized
    ``RuntimeError`` with bounded, path-redacted diagnostics only.
    """
    import os

    if not isinstance(job, dict):
        raise TypeError("job must be a JSON object")
    kind = job.get("kind")
    if kind not in _KIND_PYTHON:
        raise ValueError("Unsupported segmentation kind")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # Deliberately isolate module resolution to this fresh project.
    env["PYTHONPATH"] = str(_REPO_ROOT)
    env["OMP_NUM_THREADS"] = str(_CPU_THREADS)
    env["MKL_NUM_THREADS"] = str(_CPU_THREADS)
    command = [
        str(_KIND_PYTHON[kind]),
        "-m",
        "planner.segmentation_worker",
        str(output_dir),
    ]
    try:
        completed = subprocess.run(
            command,
            shell=False,
            check=False,
            input=json.dumps(job).encode(),
            cwd=str(_REPO_ROOT),
            env=env,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
            capture_output=True,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(
            f"Local model worker timed out after {SUBPROCESS_TIMEOUT_SECONDS} seconds"
        ) from None
    if completed.returncode != 0:
        raise RuntimeError(
            f"Local model worker failed (exit {completed.returncode}): "
            f"{_sanitize(completed.stderr)}"
        )
    mask_path = output_dir / "mask.nii.gz"
    if not mask_path.is_file() or mask_path.is_symlink():
        raise RuntimeError("Local model worker produced no readable mask artifact")
    metadata_path = output_dir / "metadata.json"
    if (
        metadata_path.is_symlink()
        or not metadata_path.is_file()
        or not 0 < metadata_path.stat().st_size <= 32768
    ):
        raise RuntimeError("Local model worker metadata failed size or file-type checks")
    with metadata_path.open("rb") as stream:
        raw_metadata = stream.read(32769)
    if len(raw_metadata) > 32768:
        raise RuntimeError("Local model worker metadata exceeds its size bound")
    metadata = json.loads(raw_metadata)
    return {"mask_path": mask_path, "metadata": metadata}


def _load_correction_base(job, source):
    """Reverify a server-selected opaque blob identity, never a supplied path."""
    import hashlib
    import re

    import nibabel as nib
    import numpy as np

    base = job["base_mask"]
    if not isinstance(base, dict):
        raise TypeError("Correction base descriptor must be an object")
    digest = base.get("mask_sha256")
    candidate = base.get("candidate_id")
    if (
        not isinstance(digest, str)
        or re.fullmatch(r"[a-f0-9]{64}", digest) is None
        or not isinstance(candidate, str)
        or re.fullmatch(r"[A-Za-z0-9_-]{1,80}", candidate) is None
        or base.get("image_sha256") != job["image_sha256"]
        or base.get("reference_revision") != job["reference_revision"]
        or type(base.get("segmentation_revision")) is not int
        or base["segmentation_revision"] < 1
        or base.get("producer") not in ("aneurysm_model", "sam2_prompted_slice")
    ):
        raise ValueError("Correction base identity does not match this job")
    path = MASK_BLOB_DIR / f"{digest}.nii.gz"
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= _MAX_MASK_BYTES:
        raise ValueError("Correction base blob is unavailable")
    with path.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
            raise ValueError("Correction base blob hash mismatch")
    mask_image = nib.load(str(path))
    if (
        mask_image.shape != source.shape
        or mask_image.get_data_dtype() != np.uint8
        or not np.array_equal(mask_image.affine, source.affine)
        or mask_image.header.get_xyzt_units() != source.header.get_xyzt_units()
    ):
        raise ValueError("Correction base geometry does not match the source")
    mask = np.asarray(mask_image.dataobj)
    if not np.isin(mask, [0, 1]).all():
        raise ValueError("Correction base must be binary")
    return mask


def _source_context_metadata(job):
    source_id = job.get("source_id", "cmha-ahmu1218001-context")
    metadata = {"source_id": source_id}
    if source_id in ("zenodo-case006-calibrated", "zenodo-case006-planning-context"):
        metadata["input_context"] = "server_installed_calibrated_reference_informed_context"
        metadata["source_annotation_registration_validated"] = False
        if job.get("kind") == "sam2":
            metadata["prompt_context"] = (
                "operator crosshair in calibrated context; ROI may be reference-informed"
            )
    return metadata


def _source_bundle(job):
    """Resolve only a registered opaque identity, never job-supplied paths."""
    import hashlib

    source_id = job.get("source_id", "cmha-ahmu1218001-context")
    if source_id in ("zenodo-case006-calibrated", "zenodo-case006-planning-context"):
        from planner import image_source

        provider = getattr(
            image_source,
            "PlanningSourceStore"
            if source_id == "zenodo-case006-planning-context"
            else "CalibratedSourceStore",
        )
        data, revision, paths = provider().load()
        return data, revision, paths["image"], "mm"
    if source_id != "cmha-ahmu1218001-context":
        raise ValueError("Unknown installed image source")
    raw_manifest = (REFERENCE_DIR / "manifest.json").read_bytes()
    return (
        json.loads(raw_manifest),
        hashlib.sha256(raw_manifest).hexdigest(),
        REFERENCE_IMAGE,
        "unknown",
    )


def _run_job(job, output_dir):
    """Child entry point: verify the fixed reference, infer, save artifacts."""
    import hashlib

    import nibabel as nib
    import numpy as np

    if not isinstance(job, dict):
        raise TypeError("job must be a JSON object")
    kind = job.get("kind")
    if kind not in ("vessel", "sam2", "aneurysm"):
        raise ValueError("Unsupported segmentation kind")
    case_id = job.get("case_id")
    image_sha256 = job.get("image_sha256")
    reference_revision = job.get("reference_revision")
    if not all(
        isinstance(value, str) and value for value in (case_id, image_sha256, reference_revision)
    ):
        raise ValueError("Job identity fields are incomplete")

    manifest, installed_revision, image_path, expected_units = _source_bundle(job)
    expected_sha = manifest["image"]["sha256"]
    if image_sha256 != expected_sha or reference_revision != installed_revision:
        raise ValueError("Job does not match the installed reference revision")
    actual_sha = hashlib.sha256(image_path.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        raise ValueError("Installed reference image hash mismatch")

    source = nib.load(str(image_path))
    data = np.asarray(source.dataobj)
    if data.ndim != 3 or data.size == 0:
        raise ValueError("Source image must be a nonempty 3D volume")
    if data.size > _MAX_VOXELS:
        raise ValueError("Source image exceeds the 8,000,000 voxel guard")
    if not np.isfinite(data).all():
        raise ValueError("Source image contains non-finite voxels")
    native_shape = tuple(int(value) for value in data.shape)
    source_units = source.header.get_xyzt_units()[0] or "unknown"
    if (
        job.get("source_id") in ("zenodo-case006-calibrated", "zenodo-case006-planning-context")
        and source_units != expected_units
    ):
        raise ValueError("Calibrated source unit declaration does not match its registry")
    source_dtype = str(source.get_data_dtype())
    window = job.get("display_window", [0, 600])
    if (
        not isinstance(window, list)
        or len(window) != 2
        or any(isinstance(v, bool) or not np.isfinite(v) for v in window)
        or not window[0] < window[1]
    ):
        raise ValueError("display_window must be two increasing finite values")
    window = [float(window[0]), float(window[1])]
    correction_base = None
    point_label = 1
    sam_prompt_metadata = {}

    if kind == "vessel":
        import torch

        torch.set_num_threads(_CPU_THREADS)
        from planner.vessel_inference import predict_vessel

        spacing_xyz = [float(value) for value in source.header.get_zooms()[:3]]
        result = predict_vessel(
            data,
            spacing_xyz,
            checkpoint_path=VESSEL_CHECKPOINT,
            landmarks_path=VESSEL_LANDMARKS,
        )
        mask_xyz = np.asarray(result["mask"], dtype=np.uint8)
        slice_index = None
        segmentation_extent = "full_volume"
        prompt_provenance = None
    elif kind == "sam2":
        from planner.sam_refinement import refine_slice

        if job.get("role") != "aneurysm":
            raise ValueError("sam2 requires the aneurysm role")
        i, j, k = ras_to_native_prompt(job.get("point_ras"), source.affine, native_shape)
        plane_rows_j_cols_i = data[:, :, k].T
        height, width = plane_rows_j_cols_i.shape
        box = clip_prompt_box(i, j, job.get("radius_voxels", 12), width, height)
        span = window[1] - window[0]
        normalized = np.clip(plane_rows_j_cols_i, window[0], window[1])
        rgb = ((normalized - window[0]) / span * 255.0).round().astype(np.uint8)
        image = np.repeat(rgb[:, :, None], 3, axis=2)
        correction_base = job.get("base_mask")
        base_volume = _load_correction_base(job, source) if correction_base is not None else None
        prior_args = (
            {"initial_mask": base_volume[:, :, k].T.copy()} if base_volume is not None else {}
        )
        point_label = job.get("point_label", 1)
        if type(point_label) is not int or point_label not in (0, 1):
            raise ValueError("Point polarity must be integer 0 or 1")
        result = refine_slice(
            image,
            points=[(i, j)],
            labels=[point_label],
            box=box,
            checkpoint_path=SAM_CHECKPOINT,
            prompt_provenance="operator_entered",
            **prior_args,
        )
        candidate = np.asarray(result["mask"])
        if candidate.shape != (height, width) or not np.isin(candidate, [0, 1]).all():
            raise ValueError("SAM returned an unusable candidate mask")
        if base_volume is not None and result.get("initial_mask_used") is not True:
            raise ValueError("SAM did not use the selected correction base")
        mask_xyz = (
            base_volume.copy()
            if base_volume is not None
            else np.zeros(native_shape, dtype=np.uint8)
        )
        mask_xyz[:, :, k] = candidate.T
        slice_index = k
        segmentation_extent = (
            "single_slice_edit_of_existing_mask"
            if base_volume is not None
            else "single_native_axial_slice"
        )
        prompt_provenance = "operator_entered"
        sam_prompt_metadata = {
            "point_label": point_label,
            "point_ras": [float(value) for value in job["point_ras"]],
            "prompt_native_ijk": [float(i), float(j), int(k)],
            "prompt_box_native_xyxy": box,
            "three_dimensional_propagation": False,
        }
    else:
        if job.get("role") != "aneurysm":
            raise ValueError("aneurysm requires the aneurysm role")
        # Lazily import the parent-owned helper; only the fixed installed
        # checkpoint constant is passed, never a job-supplied path.
        from planner.aneurysm_inference import predict_aneurysm

        result = predict_aneurysm(data, source.affine, checkpoint_path=ANEURYSM_CHECKPOINT)
        mask_xyz = np.asarray(result["mask"], dtype=np.uint8)
        slice_index = None
        segmentation_extent = "full_context_roi"
        prompt_provenance = None

    if mask_xyz.shape != native_shape or not np.isin(mask_xyz, [0, 1]).all():
        raise ValueError("Candidate mask is not a binary volume of the source shape")

    header = source.header.copy()
    candidate_image = nib.Nifti1Image(mask_xyz, source.affine, header=header)
    candidate_image.set_data_dtype(np.uint8)
    mask_path = output_dir / "mask.nii.gz"
    nib.save(candidate_image, str(mask_path))

    # Re-read and assert the saved artifact before reporting success.
    saved = nib.load(str(mask_path))
    saved_data = np.asanyarray(saved.dataobj)
    if saved.shape != native_shape or not np.allclose(saved.affine, source.affine):
        raise ValueError("Saved mask geometry does not match the source image")
    if saved.header.get_xyzt_units() != source.header.get_xyzt_units():
        raise ValueError("Saved mask header units do not match the source image")
    if saved.get_data_dtype() != np.uint8 or not np.isin(saved_data, [0, 1]).all():
        raise ValueError("Saved mask is not binary uint8 data")

    provenance = {key: value for key, value in result.items() if key != "mask"}
    producer = {
        "vessel": "owned_vessel",
        "sam2": "sam2_prompted_slice",
        "aneurysm": "aneurysm_model",
    }[kind]
    metadata = {
        "producer": producer,
        "role": "vessel" if kind == "vessel" else "aneurysm",
        "provenance": provenance,
        "case_id": case_id,
        "image_sha256": image_sha256,
        "reference_revision": reference_revision,
        "native_shape": list(native_shape),
        "source_units": source_units,
        "source_dtype": source_dtype,
        "display_window": window,
        "source_affine": [[float(value) for value in row] for row in source.affine],
        "foreground_count": int((saved_data == 1).sum()),
        "segmentation_extent": segmentation_extent,
        "volumetric_morphometry_eligible": segmentation_extent == "full_volume",
        "automatic_aneurysm_detection": False,
        # Only the fixed aneurysm mode performs in-context segmentation; no
        # independent full-head localization is claimed for any mode.
        "automatic_aneurysm_segmentation_within_selected_context": kind == "aneurysm",
        "clinical_validation": "none",
    }
    if kind == "aneurysm":
        metadata["input_context"] = "server_installed_curated_reference_selected_roi"
        metadata["slice_index"] = None
        metadata["prompt_provenance"] = None
    elif slice_index is not None:
        metadata["slice_index"] = slice_index
        metadata["prompt_provenance"] = prompt_provenance
        metadata["prompt_context"] = "curated_reference_case; crosshair may be reference-informed"
    if kind == "sam2":
        metadata.update(sam_prompt_metadata)
        if correction_base is not None:
            metadata["correction_base"] = correction_base
    metadata.update(_source_context_metadata(job))
    (output_dir / "metadata.json").write_text(json.dumps(metadata, allow_nan=False))
    return metadata


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python -m planner.segmentation_worker <output_dir>", file=sys.stderr)
        return 2
    job = json.load(sys.stdin)
    _run_job(job, Path(argv[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
