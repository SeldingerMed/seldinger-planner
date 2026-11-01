"""Native accepted-mask geometry estimates. Imaging imports remain runtime-local.

Operator neck/path definitions, not automatic anatomical neck or centerline
extraction. No clinical validity, suitability or device sizing is established.
"""

from pathlib import Path

from planner.mask_geometry import surface_from_mask
from planner.morphometry_selection import clipped_sac_metrics, selected_section_metrics

ROOT = Path(__file__).resolve().parents[1]
ML_PYTHON = ROOT / ".runtime/ml-runtime/bin/python"
MAX_RESULT_BYTES = 1048576


def compute_native_geometry(aneurysm_mask, vessel_mask, affine, operator_inputs):
    """Compute explicit operator-plane estimates in calibrated RAS millimeters."""
    import numpy as np
    from scipy import ndimage

    sac = np.asarray(aneurysm_mask)
    vessel = np.asarray(vessel_mask)
    if sac.ndim != 3 or sac.shape != vessel.shape:
        raise ValueError("Accepted masks must share a three-dimensional native grid")
    aff = np.asarray(affine, dtype=float)
    if (
        aff.shape != (4, 4)
        or not np.isfinite(aff).all()
        or not np.array_equal(aff[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous source affine")
    if not np.isfinite(np.linalg.det(aff)) or abs(np.linalg.det(aff)) < 1e-12:
        raise ValueError("Invalid source affine determinant")
    inverse = np.linalg.inv(aff)

    def index(point):
        p = np.asarray(point, dtype=float)
        if p.shape != (3,) or not np.isfinite(p).all():
            raise ValueError("Operator point must have three finite coordinates")
        native = (inverse @ np.r_[p, 1])[:3]
        if any(v < 0 or v > n - 1 for v, n in zip(native, sac.shape, strict=True)):
            raise ValueError("Operator point is outside the installed image")
        return tuple(round(float(v)) for v in native)

    inputs = operator_inputs
    seed = index(inputs["aneurysm_seed"])
    index(inputs["neck_origin"])
    path = inputs["parent_path"]
    if not 4 <= len(path) <= 32:
        raise ValueError("Operator path requires four to thirty-two points")
    indices = (inputs["proximal_index"], inputs["distal_index"])
    if (
        any(type(i) is not int or not 1 <= i < len(path) - 1 for i in indices)
        or indices[0] == indices[1]
    ):
        raise ValueError("Parent stations must be distinct interior path indices")
    native_path = [index(p) for p in path]
    if np.linalg.norm(np.asarray(path[indices[0]]) - np.asarray(path[indices[1]])) <= 1e-9:
        raise ValueError("Parent stations require distinct physical positions")
    if any(sac[native_path[i]] == 1 for i in indices):
        raise ValueError("Parent stations overlap the accepted aneurysm mask; reposition them")
    if any(vessel[p] != 1 for p in native_path):
        raise ValueError("Operator parent path points must sample vessel foreground")
    labels, _ = ndimage.label(vessel == 1, structure=ndimage.generate_binary_structure(3, 1))
    station_label = labels[native_path[indices[0]]]
    if any(labels[p] != station_label for p in native_path):
        raise ValueError("Operator path crosses disconnected vessel components")
    sac_surface = surface_from_mask(sac, aff, seed_ijk=seed, reject_boundary=True)
    vessel_surface = surface_from_mask(
        vessel, aff, seed_ijk=native_path[indices[0]], reject_boundary=False
    )
    sac_mesh = sac_surface["triangles_world"]
    vessel_mesh = vessel_surface["triangles_world"]
    result = {
        "spatial_units": "mm",
        "clinical_validation": False,
        "validated_morphometry": False,
        "sac": clipped_sac_metrics(
            sac_mesh, inputs["neck_origin"], inputs["neck_normal"], spatial_units="mm"
        ),
        "neck": selected_section_metrics(
            sac_mesh, inputs["neck_origin"], inputs["neck_normal"], spatial_units="mm"
        ),
        "method": "accepted_native_masks_operator_geometry",
        "operator_path_validation": "explicit_foreground_samples_not_validated_centerline",
        "native_point_policy": "nearest_native_index_python_ties_to_even",
        "surfaces": {
            name: {k: v for k, v in surface.items() if k != "triangles_world"}
            for name, surface in [("aneurysm", sac_surface), ("vessel", vessel_surface)]
        },
    }
    for role, i in zip(("proximal_parent", "distal_parent"), indices, strict=True):
        normal = [path[i + 1][axis] - path[i - 1][axis] for axis in range(3)]
        result[role] = selected_section_metrics(vessel_mesh, path[i], normal, spatial_units="mm")
        result[role]["method"] = "operator_path_normal_native_mask_section"
    return result


def compute_job(job, *, blob_dir):
    """Verify fixed source and content-addressed masks before any geometry."""
    import hashlib
    import json
    import math
    import re
    from pathlib import Path

    import nibabel as nib
    import numpy as np

    from planner.geometry_contract import CALCULATION_VERSION
    from planner.segmentation_worker import _source_bundle

    def digest(path):
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(chunk)
        return checksum.hexdigest()

    data, revision, source_path, units = _source_bundle(job)
    deps = job["dependencies"]
    if (
        units != "mm"
        or revision != job["reference_revision"]
        or data["image"]["sha256"] != job["image_sha256"]
    ):
        raise ValueError("Source identity or physical units mismatch")
    if (
        any(deps[k] != job[k] for k in ("case_id", "image_sha256"))
        or deps["source_revision"] != revision
        or deps["calculation_version"] != CALCULATION_VERSION
    ):
        raise ValueError("Geometry dependency identity mismatch")
    raw_inputs = json.dumps(
        job["operator_inputs"], sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    if (
        len(raw_inputs.encode()) > 8192
        or hashlib.sha256(raw_inputs.encode()).hexdigest() != deps["operator_sha256"]
    ):
        raise ValueError("Operator input identity mismatch")
    source_path = Path(source_path)
    if (
        source_path.is_symlink()
        or not source_path.is_file()
        or not 0 < source_path.stat().st_size <= 64 * 1024 * 1024
        or digest(source_path) != job["image_sha256"]
    ):
        raise ValueError("Source image integrity mismatch")
    source = nib.load(source_path)
    if (
        len(source.shape) != 3
        or math.prod(source.shape) > 8_000_000
        or source.header.get_xyzt_units()[0] != "mm"
    ):
        raise ValueError("Invalid calibrated source grid")
    arrays = {}
    for role in ("aneurysm", "vessel"):
        sha = deps["masks"][role]["mask_sha256"]
        if not isinstance(sha, str) or re.fullmatch(r"[a-f0-9]{64}", sha) is None:
            raise ValueError("Invalid mask identity")
        path = Path(blob_dir) / "blobs" / f"{sha}.nii.gz"
        if (
            path.is_symlink()
            or not path.is_file()
            or not 0 < path.stat().st_size <= 16 * 1024 * 1024
            or digest(path) != sha
        ):
            raise ValueError("Mask integrity mismatch")
        image = nib.load(path)
        if (
            image.shape != source.shape
            or not np.array_equal(image.affine, source.affine)
            or image.header.get_xyzt_units() != source.header.get_xyzt_units()
        ):
            raise ValueError("Mask native geometry mismatch")
        if (
            image.get_data_dtype() != np.uint8
            or image.dataobj.slope != 1
            or image.dataobj.inter != 0
        ):
            raise ValueError("Mask dtype or scalar scaling mismatch")
        array = np.asanyarray(image.dataobj)
        if not np.isin(array, [0, 1]).all():
            raise ValueError("Mask is not binary")
        arrays[role] = array
    result = compute_native_geometry(
        arrays["aneurysm"], arrays["vessel"], source.affine, job["operator_inputs"]
    )
    return result | {
        "source_id": job["source_id"],
        "image_sha256": job["image_sha256"],
        "reference_revision": revision,
    }


def run_local_geometry(job, *, blob_dir):
    """Bounded fixed-runtime supervisor; blob_dir is trusted server config."""
    import json
    import os
    import subprocess

    if not ML_PYTHON.is_file():
        raise RuntimeError("Geometry runtime is not installed")
    payload = json.dumps({"job": job, "blob_dir": str(Path(blob_dir).resolve())}, allow_nan=False)
    if len(payload.encode()) > 16384:
        raise RuntimeError("Geometry job exceeds input cap")
    env = dict(os.environ)
    env.update(
        {
            name: "4"
            for name in (
                "OMP_NUM_THREADS",
                "MKL_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS",
            )
        }
    )
    try:
        completed = subprocess.run(
            [str(ML_PYTHON), "-m", "planner.geometry_worker"],
            input=payload,
            cwd=str(ROOT),
            env=env,
            timeout=60,
            check=False,
            shell=False,
            capture_output=True,
            text=True,
        )
    except (subprocess.TimeoutExpired, OSError):
        raise RuntimeError("Geometry worker failed or exceeded its deadline") from None
    if completed.returncode != 0 or len(completed.stdout.encode()) > MAX_RESULT_BYTES:
        raise RuntimeError("Geometry worker failed or exceeded output cap")
    try:
        result = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise RuntimeError("Geometry worker returned invalid JSON") from None
    if not isinstance(result, dict):
        raise RuntimeError("Geometry worker returned invalid result")  # noqa: TRY004 - subprocess protocol failure
    return result


def main():
    import json
    import sys

    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError("Geometry job exceeds input cap")
        payload = json.loads(raw)
        result = compute_job(payload["job"], blob_dir=Path(payload["blob_dir"]))
        output = json.dumps(result, allow_nan=False)
        if len(output.encode()) > MAX_RESULT_BYTES:
            raise ValueError("Geometry result exceeds output cap")
        print(output)
    except (ValueError, TypeError, KeyError, OSError) as exc:
        print(f"Geometry worker failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
