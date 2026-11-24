"""Raw NIfTI CTA to same-grid binary aortoiliac mask inference adapter.

Integrates the freely licensed default TotalSegmentator ``total`` CT task
(Apache 2.0, primary-source verified against TotalSegmentator 2.18.0) restricted
to the arterial aorta and iliac ROI subset:

- ``52``: ``aorta``
- ``65``: ``iliac_artery_left``
- ``66``: ``iliac_artery_right``

Upstream ``totalsegmentator.python_api.totalsegmentator`` supports combining
``task="total"``, ``fast=True`` (3.0 mm model task 297 after 6.0 mm ROI crop
task 298), and ``roi_subset=["aorta", "iliac_artery_left", "iliac_artery_right"]``
with ``ml=True``, ``output=None``, and ``skip_saving=True``. Setting ``fast=False``
selects the 1.5 mm model restricted to part 293 (``class_map_part_cardiac``).

All imaging and ML imports stay lazy so the base API runtime can import this
module without NumPy, NiBabel, SciPy, PyTorch, or TotalSegmentator. Returned
masks and proposals always require operator confirmation and carry no clinical
validation claim.
"""

import hashlib
import math
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

METHOD = "aortoiliac_totalsegmentator_total_v1"
TOTALSEGMENTATOR_PACKAGE = "TotalSegmentator"
TOTALSEGMENTATOR_VERIFIED_VERSION = "2.18.0"
TOTALSEGMENTATOR_LICENSE = "Apache 2.0"
TOTALSEGMENTATOR_TASK = "total"
AORTOILIAC_LABEL_MAP: dict[int, str] = {
    52: "aorta",
    65: "iliac_artery_left",
    66: "iliac_artery_right",
}
AORTOILIAC_ROI_SUBSET: tuple[str, ...] = (
    "aorta",
    "iliac_artery_left",
    "iliac_artery_right",
)
ROI_SUBSET_SUPPORTS_FAST = True
DEFAULT_MAX_VOXELS = 512 * 512 * 2048

_AFFINE_TOLERANCE = 1e-5
_SHA256_RE = re.compile(r"[a-f0-9]{64}")
_GPU_DEVICE_RE = re.compile(r"gpu:[0-9]+")
_CHUNK_BYTES = 1024 * 1024


def build_totalsegmentator_kwargs(
    *,
    fast: bool = True,
    device: str = "cpu",
    nr_thr_resamp: int = 1,
    nr_thr_saving: int = 1,
) -> dict[str, Any]:
    """Build validated keyword arguments for ``totalsegmentator.python_api.totalsegmentator``."""
    if type(fast) is not bool:
        raise ValueError("fast must be a boolean")
    if not isinstance(device, str) or (
        device not in ("cpu", "gpu", "mps") and _GPU_DEVICE_RE.fullmatch(device) is None
    ):
        raise ValueError("device must be 'cpu', 'gpu', 'mps', or 'gpu:<id>'")
    if type(nr_thr_resamp) is not int or nr_thr_resamp < 1:
        raise ValueError("nr_thr_resamp must be a positive integer")
    if type(nr_thr_saving) is not int or nr_thr_saving < 1:
        raise ValueError("nr_thr_saving must be a positive integer")
    return {
        "output": None,
        "ml": True,
        "fast": fast,
        "fastest": False,
        "task": TOTALSEGMENTATOR_TASK,
        "roi_subset": list(AORTOILIAC_ROI_SUBSET),
        "skip_saving": True,
        "quiet": True,
        "verbose": False,
        "device": device,
        "nr_thr_resamp": nr_thr_resamp,
        "nr_thr_saving": nr_thr_saving,
    }


def invoke_totalsegmentator(
    cta_image: Any,
    *,
    fast: bool = True,
    device: str = "cpu",
    nr_thr_resamp: int = 1,
    nr_thr_saving: int = 1,
) -> Any:
    """Invoke upstream ``totalsegmentator.python_api.totalsegmentator`` lazily."""
    kwargs = build_totalsegmentator_kwargs(
        fast=fast,
        device=device,
        nr_thr_resamp=nr_thr_resamp,
        nr_thr_saving=nr_thr_saving,
    )
    try:
        from totalsegmentator.python_api import totalsegmentator
    except ImportError as exc:
        raise RuntimeError(
            "TotalSegmentator is not installed in this runtime. Run inference in an "
            "isolated TotalSegmentator runtime or provide an injectable runner."
        ) from exc
    return totalsegmentator(cta_image, **kwargs)


def _validate_regular_nifti_path(cta_path: str | Path) -> Path:
    if not isinstance(cta_path, (str, Path)):
        raise TypeError("CTA path must be a str or Path")
    path = Path(cta_path)
    if (
        path.is_symlink()
        or any(parent.is_symlink() for parent in path.parents)
        or not path.is_file()
    ):
        raise ValueError("CTA path must be a regular non-symlink file")
    lower_name = path.name.lower()
    if not lower_name.endswith((".nii", ".nii.gz")):
        raise ValueError("CTA path must be a NIfTI (.nii or .nii.gz) file")
    return path


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_ras_affine(affine_ras: Any, *, label: str = "CTA"):
    import numpy as np

    affine = np.asarray(affine_ras, dtype=float)
    if (
        affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0.0, 0.0, 0.0, 1.0])
    ):
        raise ValueError(f"{label} has an invalid homogeneous RAS affine")
    spacing = np.linalg.norm(affine[:3, :3], axis=0)
    if not (spacing > 1e-3).all():
        raise ValueError(f"{label} has a singular RAS affine")
    unit = affine[:3, :3] / spacing
    if float(np.abs(unit.T @ unit - np.eye(3)).max()) > 1e-3:
        raise ValueError(f"{label} RAS affine must have index axes at right angles")
    return affine


def load_raw_cta_nifti(
    cta_path: str | Path,
    *,
    expected_sha256: str | None = None,
    max_voxels: int = DEFAULT_MAX_VOXELS,
):
    """Validate and load one raw 3D millimeter-calibrated NIfTI-1 CTA."""
    import nibabel as nib
    import numpy as np

    if type(max_voxels) is not int or max_voxels < 1:
        raise ValueError("max_voxels must be a positive integer")
    path = _validate_regular_nifti_path(cta_path)
    source_sha256 = _sha256_file(path)
    if expected_sha256 is not None:
        if not isinstance(expected_sha256, str) or _SHA256_RE.fullmatch(expected_sha256) is None:
            raise ValueError("expected_sha256 must be a 64-character lowercase hex digest")
        if source_sha256 != expected_sha256:
            raise ValueError("CTA file SHA-256 digest mismatch")

    image = nib.load(path)
    if not isinstance(image, nib.Nifti1Image):
        raise TypeError("CTA input must be a NIfTI-1 image")
    if len(image.shape) != 3 or any(dim < 1 for dim in image.shape):
        raise ValueError("CTA input must be a nonempty 3D NIfTI-1 volume")
    if math.prod(image.shape) > max_voxels:
        raise ValueError("CTA volume exceeds the configured voxel bound")
    if image.header.get_xyzt_units()[0] != "mm":
        raise ValueError("CTA spatial units must be explicitly calibrated in millimeters ('mm')")
    if int(image.header["sform_code"]) <= 0:
        raise ValueError("CTA input requires explicit sform calibration")
    affine = _validate_ras_affine(image.affine, label="CTA")

    dtype = image.get_data_dtype()
    if dtype.fields is not None or not np.issubdtype(dtype, np.number):
        raise ValueError("CTA intensity dtype must be a simple numeric type")
    for header_field in ("scl_slope", "scl_inter"):
        scalar = float(image.header[header_field])
        if math.isinf(scalar):
            raise ValueError(f"CTA header {header_field} must be finite")
    data = np.asanyarray(image.dataobj)
    if np.issubdtype(data.dtype, np.floating) and not np.isfinite(data).all():
        raise ValueError("CTA contains non-finite intensity values")
    return image, affine, source_sha256


def _extract_same_grid_aortoiliac_mask(
    seg_image: Any, source_shape: tuple[int, ...], source_affine
):
    import nibabel as nib
    import numpy as np

    if not isinstance(seg_image, nib.Nifti1Image):
        raise TypeError("Segmentation runner must return a nibabel Nifti1Image")
    if seg_image.shape != source_shape:
        raise ValueError("Segmentation output grid shape does not match source CTA")
    seg_affine = np.asarray(seg_image.affine, dtype=float)
    if (
        seg_affine.shape != (4, 4)
        or not np.isfinite(seg_affine).all()
        or not np.array_equal(seg_affine[3], [0.0, 0.0, 0.0, 1.0])
        or not np.allclose(seg_affine, source_affine, rtol=0.0, atol=_AFFINE_TOLERANCE)
    ):
        raise ValueError("Segmentation output RAS affine does not match source CTA")
    seg_units = seg_image.header.get_xyzt_units()[0]
    if seg_units not in ("mm", "unknown"):
        raise ValueError(f"Segmentation spatial units mismatch with source CTA: {seg_units!r}")

    raw_labels = np.asanyarray(seg_image.dataobj)
    if raw_labels.dtype.fields is not None or not np.issubdtype(raw_labels.dtype, np.number):
        raise ValueError("Segmentation labels must have a simple numeric dtype")
    if np.issubdtype(raw_labels.dtype, np.floating):
        if not np.isfinite(raw_labels).all():
            raise ValueError("Segmentation labels contain non-finite values")
        if not np.all(np.floor(raw_labels) == raw_labels):
            raise ValueError("Segmentation labels must be integer-valued")
    if raw_labels.size > 0 and float(raw_labels.min()) < 0.0:
        raise ValueError("Segmentation labels must be non-negative")

    label_voxel_counts = {
        name: int(np.count_nonzero(raw_labels == label_id))
        for label_id, name in AORTOILIAC_LABEL_MAP.items()
    }
    mask = np.isin(raw_labels, tuple(AORTOILIAC_LABEL_MAP)).astype(np.uint8)
    voxel_count = int(mask.sum())
    total_nonzero = int(np.count_nonzero(raw_labels))
    excluded_nonzero_voxel_count = total_nonzero - voxel_count
    if voxel_count == 0:
        raise ValueError("Inferred aortoiliac vessel mask is empty")

    mask_image = nib.Nifti1Image(mask, source_affine.copy())
    mask_image.set_data_dtype(np.uint8)
    mask_image.header.set_xyzt_units("mm", "sec")
    mask_image.header.set_slope_inter(1.0, 0.0)
    mask_image.set_sform(source_affine.copy(), code=2)
    mask_image.set_qform(source_affine.copy(), code=2)
    named = np.where(mask > 0, raw_labels, 0).astype(np.uint8)
    return mask, mask_image, label_voxel_counts, voxel_count, excluded_nonzero_voxel_count, named


def infer_aortoiliac_mask(
    cta_path: str | Path,
    *,
    expected_sha256: str | None = None,
    fast: bool = True,
    device: str = "cpu",
    nr_thr_resamp: int = 1,
    nr_thr_saving: int = 1,
    runner: Callable[..., Any] | None = None,
    max_voxels: int = DEFAULT_MAX_VOXELS,
) -> dict[str, Any]:
    """Infer one same-grid binary aortoiliac vessel mask from a raw NIfTI CTA.

    When ``runner`` is None, calls ``invoke_totalsegmentator`` using the freely
    licensed ``total`` task restricted to ``aorta``, ``iliac_artery_left``, and
    ``iliac_artery_right``. An external runtime or synthetic test may inject a
    ``runner(cta_image, **kwargs) -> nibabel.Nifti1Image`` callable.
    """
    if runner is not None and not callable(runner):
        raise TypeError("runner must be callable or None")
    kwargs = build_totalsegmentator_kwargs(
        fast=fast,
        device=device,
        nr_thr_resamp=nr_thr_resamp,
        nr_thr_saving=nr_thr_saving,
    )
    cta_image, source_affine, source_sha256 = load_raw_cta_nifti(
        cta_path,
        expected_sha256=expected_sha256,
        max_voxels=max_voxels,
    )
    if runner is None:
        seg_image = invoke_totalsegmentator(
            cta_image,
            fast=fast,
            device=device,
            nr_thr_resamp=nr_thr_resamp,
            nr_thr_saving=nr_thr_saving,
        )
    else:
        seg_image = runner(cta_image, **kwargs)

    (
        mask,
        mask_image,
        label_voxel_counts,
        voxel_count,
        excluded_nonzero_voxel_count,
        named_labels,
    ) = _extract_same_grid_aortoiliac_mask(seg_image, cta_image.shape, source_affine)

    return {
        "method": METHOD,
        "mask": mask,
        # The segmentation's own label of each vessel voxel (0 elsewhere);
        # read to check the model's names, never part of an export.
        "named_labels": named_labels,
        "mask_image": mask_image,
        "affine_ras": source_affine.copy(),
        "spatial_units": "mm",
        "shape_xyz": [int(dim) for dim in cta_image.shape],
        "source_sha256": source_sha256,
        "voxel_count": voxel_count,
        "label_voxel_counts": label_voxel_counts,
        "excluded_nonzero_voxel_count": excluded_nonzero_voxel_count,
        "operator_confirmation_required": True,
        "clinical_validation": False,
        "backend": {
            "package": TOTALSEGMENTATOR_PACKAGE,
            "verified_version": TOTALSEGMENTATOR_VERIFIED_VERSION,
            "license": TOTALSEGMENTATOR_LICENSE,
            "task": TOTALSEGMENTATOR_TASK,
            "roi_subset": list(AORTOILIAC_ROI_SUBSET),
            "label_map": dict(AORTOILIAC_LABEL_MAP),
            "fast": fast,
            "device": device,
            "injected_runner": runner is not None,
        },
    }


def propose_aortoiliac_model_from_cta(
    cta_path: str | Path,
    *,
    expected_sha256: str | None = None,
    fast: bool = True,
    device: str = "cpu",
    nr_thr_resamp: int = 1,
    nr_thr_saving: int = 1,
    runner: Callable[..., Any] | None = None,
    max_voxels: int = DEFAULT_MAX_VOXELS,
) -> dict[str, Any]:
    """Infer the same-grid aortoiliac mask and propose centerlines for operator confirmation."""
    from planner.aortoiliac_model import propose_aortoiliac_model

    segmentation = infer_aortoiliac_mask(
        cta_path,
        expected_sha256=expected_sha256,
        fast=fast,
        device=device,
        nr_thr_resamp=nr_thr_resamp,
        nr_thr_saving=nr_thr_saving,
        runner=runner,
        max_voxels=max_voxels,
    )
    proposal = propose_aortoiliac_model(
        segmentation["mask"],
        segmentation["affine_ras"],
        spatial_units=segmentation["spatial_units"],
    )
    agreement = branch_label_agreement(
        proposal, segmentation.pop("named_labels"), segmentation["affine_ras"]
    )
    return {
        "method": METHOD,
        "source_sha256": segmentation["source_sha256"],
        "spatial_units": "mm",
        "operator_confirmation_required": True,
        "clinical_validation": False,
        "segmentation": segmentation,
        "proposal": proposal,
        "label_agreement": agreement,
    }


# The model names its lines from the shape of the vessel mask alone. On a
# scan cut low, with little or no aorta in it, the widest path is an iliac
# artery and the model calls it the aorta. Each named line must therefore run
# mostly through voxels the segmentation gave the same name.
BRANCH_LABELS = {"aorta": 52, "right_iliac": 66, "left_iliac": 65}
MIN_LABEL_AGREEMENT = 0.5


def branch_label_agreement(proposal, named_labels, affine_ras) -> dict[str, float]:
    """Share of each named line's points that lie in a voxel the segmentation
    labels with that name, among its points that lie in any aorta or iliac
    artery voxel. The line is the mask's own smoothed centre line, so the few
    points left out are smoothing near the vessel wall; other labels, veins
    included, are not in the mask. Raises ValueError when a share is under
    MIN_LABEL_AGREEMENT."""
    import numpy as np

    inverse = np.linalg.inv(np.asarray(affine_ras, dtype=float))
    shape = np.asarray(named_labels.shape)
    shares: dict[str, float] = {}
    for branch in proposal["branches"]:
        name = branch["name"]
        path = np.asarray(branch["path_ras"], dtype=float)
        index = np.rint(path @ inverse[:3, :3].T + inverse[:3, 3]).astype(int)
        inside = np.all((index >= 0) & (index < shape), axis=1)
        found = named_labels[tuple(index[inside].T)]
        found = found[found > 0]
        if not len(found):
            raise ValueError(f"The line named {name} lies in no labelled vessel; not proposed")
        share = float(np.mean(found == BRANCH_LABELS[name]))
        if share < MIN_LABEL_AGREEMENT:
            values, counts = np.unique(found, return_counts=True)
            most = int(values[np.argmax(counts)])
            label = AORTOILIAC_LABEL_MAP.get(most, str(most))
            raise ValueError(
                f"The line named {name} runs mostly through vessel the segmentation "
                f"labels {label} ({share:.0%} {name}); not proposed"
            )
        shares[name] = round(share, 3)
    return shares
