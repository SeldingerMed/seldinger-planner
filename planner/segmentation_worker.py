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
VESSEL_CHECKPOINT = _REPO_ROOT / ".runtime" / "models" / "pooled-vessel-v1" / "checkpoint_best.pth"
VESSEL_LANDMARKS = _REPO_ROOT / ".runtime" / "models" / "pooled-vessel-v1" / "landmarks.npz"
SAM_CHECKPOINT = _REPO_ROOT / ".runtime" / "models" / "sam2.1-tiny" / "sam2.1_hiera_tiny.pt"

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
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # Deliberately isolate module resolution to this fresh project.
    env["PYTHONPATH"] = str(_REPO_ROOT)
    env["OMP_NUM_THREADS"] = str(_CPU_THREADS)
    env["MKL_NUM_THREADS"] = str(_CPU_THREADS)
    command = [
        str(ML_PYTHON),
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


def _run_job(job, output_dir):
    """Child entry point: verify the fixed reference, infer, save artifacts."""
    import hashlib

    import nibabel as nib
    import numpy as np

    if not isinstance(job, dict):
        raise TypeError("job must be a JSON object")
    kind = job.get("kind")
    if kind not in ("vessel", "sam2"):
        raise ValueError("Unsupported segmentation kind")
    case_id = job.get("case_id")
    image_sha256 = job.get("image_sha256")
    reference_revision = job.get("reference_revision")
    if not all(
        isinstance(value, str) and value for value in (case_id, image_sha256, reference_revision)
    ):
        raise ValueError("Job identity fields are incomplete")

    raw_manifest = (REFERENCE_DIR / "manifest.json").read_bytes()
    manifest = json.loads(raw_manifest)
    expected_sha = manifest["image"]["sha256"]
    if (
        image_sha256 != expected_sha
        or reference_revision != hashlib.sha256(raw_manifest).hexdigest()
    ):
        raise ValueError("Job does not match the installed reference revision")
    actual_sha = hashlib.sha256(REFERENCE_IMAGE.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        raise ValueError("Installed reference image hash mismatch")

    source = nib.load(str(REFERENCE_IMAGE))
    data = np.asarray(source.dataobj)
    if data.ndim != 3 or data.size == 0:
        raise ValueError("Source image must be a nonempty 3D volume")
    if data.size > _MAX_VOXELS:
        raise ValueError("Source image exceeds the 8,000,000 voxel guard")
    if not np.isfinite(data).all():
        raise ValueError("Source image contains non-finite voxels")
    native_shape = tuple(int(value) for value in data.shape)
    source_units = source.header.get_xyzt_units()[0] or "unknown"
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
    else:
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
        result = refine_slice(
            image,
            points=[(i, j)],
            labels=[1],
            box=box,
            checkpoint_path=SAM_CHECKPOINT,
            prompt_provenance="operator_entered",
        )
        candidate = np.asarray(result["mask"], dtype=np.uint8)
        if candidate.shape != (height, width) or not np.isin(candidate, [0, 1]).all():
            raise ValueError("SAM returned an unusable candidate mask")
        mask_xyz = np.zeros(native_shape, dtype=np.uint8)
        mask_xyz[:, :, k] = candidate.T
        slice_index = k
        segmentation_extent = "single_native_axial_slice"
        prompt_provenance = "operator_entered"

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
    metadata = {
        "producer": "owned_vessel" if kind == "vessel" else "sam2_prompted_slice",
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
        "clinical_validation": "none",
    }
    if slice_index is not None:
        metadata["slice_index"] = slice_index
        metadata["prompt_provenance"] = prompt_provenance
        metadata["prompt_context"] = "curated_reference_case; crosshair may be reference-informed"
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
