"""Accepted binary mask to world surface helper (contract section A).

Internal engineering helper only. It produces a world-space triangle surface
from an accepted native binary mask using marching cubes on the native grid.
It establishes no registration to anatomy or annotation and asserts no
clinical validation; see ``docs/plans/case-morphometry-contract.md``.
"""

from __future__ import annotations

_MAX_VOXELS = 8_000_000
_MAX_FOREGROUND = 100_000
_MAX_TRIANGLES = 50_000
_METHOD = "native_binary_marching_cubes_0_5"


def surface_from_mask(mask, affine, *, seed_ijk=None, reject_boundary=True):
    """Build a world-space surface mesh from a binary 3D mask.

    Heavy numeric libraries (NumPy, SciPy, scikit-image) are imported lazily
    so the module stays importable in the lightweight base runtime.

    Bounds and structural validation run before marching cubes. Without a
    seed all foreground voxels are used; with a seed the exact 6-connected
    component containing the seed is used. Boundary contact of the selected
    component is reported and rejected when ``reject_boundary`` is true.
    Vertices are transformed once with the full affine (including reflected
    anisotropic/oblique axes). Output triangles are capped at 50000 before
    the Python triangle soup is materialized.
    """
    import numpy as np
    from scipy import ndimage
    from skimage import measure

    arr = np.asarray(mask)
    if arr.ndim != 3:
        raise ValueError("mask must be a three-dimensional array")
    if arr.size > _MAX_VOXELS:
        raise ValueError(f"mask has {arr.size} voxels, exceeding the {_MAX_VOXELS} cap")
    if not np.all(np.isfinite(arr)):
        raise ValueError("mask values must be finite")
    unique = np.unique(arr)
    if not np.all(np.isin(unique, (0, 1))):
        raise ValueError("mask must be strictly binary with values 0 and 1")
    binary = arr.astype(bool)
    foreground = int(binary.sum())
    if foreground == 0:
        raise ValueError("mask is empty")
    if foreground == arr.size:
        raise ValueError("mask is wholly filled")
    if foreground > _MAX_FOREGROUND:
        raise ValueError(
            f"mask has {foreground} foreground voxels, exceeding the {_MAX_FOREGROUND} cap"
        )

    aff = np.asarray(affine, dtype=float)
    if aff.shape != (4, 4):
        raise ValueError("affine must be a homogeneous 4x4 matrix")
    if not np.all(np.isfinite(aff)):
        raise ValueError("affine must be finite")
    if not np.array_equal(aff[3], [0, 0, 0, 1]):
        raise ValueError("affine must be homogeneous")
    if abs(float(np.linalg.det(aff))) < 1e-12:
        raise ValueError("affine must be nonsingular")

    if seed_ijk is not None:
        try:
            seed = tuple(seed_ijk)
        except TypeError as exc:
            raise ValueError("seed_ijk must be a sequence of three integers") from exc
        if len(seed) != 3:
            raise ValueError("seed_ijk must contain exactly three integers")
        for value in seed:
            if isinstance(value, bool) or type(value) is not int:
                raise ValueError("seed_ijk must contain native ints, not bool/float")
        i, j, k = seed
        if not (0 <= i < arr.shape[0] and 0 <= j < arr.shape[1] and 0 <= k < arr.shape[2]):
            raise ValueError("seed_ijk is out of bounds")
        if not binary[i, j, k]:
            raise ValueError("seed_ijk must fall in foreground")
        seed_index = (i, j, k)
    else:
        seed_index = None

    labels, _ = ndimage.label(binary, structure=ndimage.generate_binary_structure(3, 1))
    if seed_index is not None:
        component = labels == labels[seed_index]
    else:
        component = binary

    coords = np.argwhere(component)
    touches = bool(
        coords[:, 0].min() == 0
        or coords[:, 0].max() == arr.shape[0] - 1
        or coords[:, 1].min() == 0
        or coords[:, 1].max() == arr.shape[1] - 1
        or coords[:, 2].min() == 0
        or coords[:, 2].max() == arr.shape[2] - 1
    )
    if touches and reject_boundary:
        raise ValueError(
            "selected component touches the image boundary; "
            "pass reject_boundary=False only for vessel-only local sections"
        )

    vertices, faces, _, _ = measure.marching_cubes(
        component.astype(np.float64),
        level=0.5,
        step_size=1,
        allow_degenerate=False,
    )
    if faces.shape[0] > _MAX_TRIANGLES:
        raise ValueError(
            f"surface has {faces.shape[0]} triangles, exceeding the {_MAX_TRIANGLES} cap"
        )
    homogeneous = np.concatenate([vertices, np.ones((vertices.shape[0], 1))], axis=1)
    world = (homogeneous @ aff.T)[:, :3]
    triangles = world[faces].tolist()
    return {
        "triangles_world": triangles,
        "foreground_voxels": int(component.sum()),
        "touches_image_boundary": touches,
        "method": _METHOD,
        "clinical_validation": False,
    }
