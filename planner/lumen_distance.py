"""Bounded RAS-mm lumen wall signed-distance approximation from a 3D mask.

This module provides a *voxel-center sampled* signed-distance approximation:
an exact Euclidean distance transform (EDT) over voxel-center samples with
per-axis physical spacing, evaluated by trilinear interpolation through the
inverse voxel-to-RAS affine. It is NOT an exact signed distance to any
reconstructed surface, not a wall-force model, and not clinically validated.

Sampling model and limitations (also reported via ``metadata``):

- Samples measure distance to opposite-class voxel centers, not to a
  reconstructed surface. The interpolated zero set need not agree with a
  voxel-face boundary or marching-cubes surface. No geometric error bound
  to an anatomical surface is established by this implementation.
- Between centers the field is piecewise trilinear; its gradient is not
  exact and the field is not a true Euclidean distance off the sample
  points. Synthetic interpolation probes do not establish anatomical error.
- scipy's EDT is exact for center-to-center distances in physical (mm)
  space under per-axis spacing; the approximation error comes entirely
  from the sampling locations and trilinear evaluation.
- Queries outside the grid plus the stated roundoff tolerance fail closed
  with ``ValueError``. Only tolerance-size overhang uses endpoint samples;
  substantive out-of-domain points are never treated as zero penetration.
- Millimeter units and structural affine validity do not establish physical
  spacing plausibility or a general numerical-conditioning guarantee.
"""

from __future__ import annotations

from typing import cast

import numpy as np
from scipy import ndimage

MAX_VOXELS = 256**3  # 16,777,216 total voxels
_ORTHO_RTOL = 1e-6
_DOMAIN_ATOL = 1e-9


def _validate_affine(affine: np.ndarray) -> np.ndarray:
    aff = np.asarray(affine, dtype=float)
    if aff.shape != (4, 4):
        raise ValueError("affine must be a 4x4 homogeneous matrix")
    if not np.isfinite(aff).all():
        raise ValueError("affine must be finite")
    if not np.array_equal(aff[3], np.array([0.0, 0.0, 0.0, 1.0])):
        raise ValueError("affine must be homogeneous (last row [0, 0, 0, 1])")
    if abs(float(np.linalg.det(aff))) == 0.0:
        raise ValueError("affine must be invertible (singular matrix)")
    m = aff[:3, :3]
    spacing = np.linalg.norm(m, axis=0)
    if not np.all(np.isfinite(spacing)) or not np.all(spacing > 0.0):
        raise ValueError("affine voxel-axis spacing must be finite and positive")
    directions = m / spacing
    # Normalize each column before testing pairwise angles. A tolerance
    # relative to the longest axis would hide shear between unequal axes.
    gram = directions.T @ directions
    if not np.allclose(gram, np.eye(3), rtol=0.0, atol=_ORTHO_RTOL):
        raise ValueError("affine voxel-axis columns must be orthogonal (no shear)")
    return aff


class LumenWallField:
    """Signed-distance approximation for a lumen mask in RAS millimetres.

    Sign convention: negative inside the mask (lumen interior), positive
    outside, crossing zero midway between adjacent opposite-class voxel
    centers under trilinear evaluation.
    """

    def __init__(self, mask, affine, spatial_units: str = "mm") -> None:
        if spatial_units != "mm":
            raise ValueError(
                f"spatial_units must be 'mm', got {spatial_units!r}; "
                "source units are required to be millimetres"
            )
        grid = np.asarray(mask)
        if grid.ndim != 3:
            raise ValueError("mask must be a 3-D array")
        if grid.size > MAX_VOXELS:
            raise ValueError(f"mask has {grid.size} voxels, exceeding the {MAX_VOXELS} (256^3) cap")
        if grid.dtype.kind not in "biuf" or not np.all(np.isfinite(grid)):
            raise ValueError("mask must contain finite real binary values (0 and 1)")
        if not np.all((grid == 0) | (grid == 1)):
            raise ValueError("mask must contain binary values (0 and 1)")
        fg = grid.astype(bool)
        if not fg.any():
            raise ValueError("mask must have nonempty foreground")
        if fg.all():
            raise ValueError("mask must have nonempty background")

        aff = _validate_affine(affine).copy()
        spacing = np.linalg.norm(aff[:3, :3], axis=0)  # each column is a voxel axis

        # Exact Euclidean EDT over voxel-center samples, per-axis mm spacing.
        dist_to_bg = cast(np.ndarray, ndimage.distance_transform_edt(fg, sampling=spacing))
        dist_to_fg = cast(np.ndarray, ndimage.distance_transform_edt(~fg, sampling=spacing))
        self._signed = dist_to_fg - dist_to_bg  # <0 inside, >0 outside

        self.affine = aff
        self._inv = np.linalg.inv(aff)
        self._shape = tuple(int(n) for n in grid.shape)
        self._spacing = spacing
        corners = np.array(
            [
                [i, j, k]
                for i in (0, self._shape[0] - 1)
                for j in (0, self._shape[1] - 1)
                for k in (0, self._shape[2] - 1)
            ],
            dtype=float,
        )
        self._corners_world = self._to_world(corners)

    # -- coordinate helpers -------------------------------------------------

    def _to_index(self, points: np.ndarray) -> np.ndarray:
        homog = np.concatenate([points, np.ones((points.shape[0], 1))], axis=1)
        return (self._inv @ homog.T).T[:, :3]

    def _to_world(self, index_coords: np.ndarray) -> np.ndarray:
        homog = np.concatenate([index_coords, np.ones((index_coords.shape[0], 1))], axis=1)
        return (self.affine @ homog.T).T[:, :3]

    # -- public API ----------------------------------------------------------

    def distance(self, points) -> np.ndarray:
        """Signed distances (mm, positive outside the mask) for an (N, 3)
        array of finite RAS-mm points. Raises ValueError for malformed
        points or queries outside the sampled voxel-center grid."""
        pts = np.asarray(points, dtype=float)
        if pts.ndim != 2 or pts.shape[1] != 3:
            raise ValueError("points must have shape (N, 3)")
        if pts.size and not np.isfinite(pts).all():
            raise ValueError("points must be finite")
        if pts.shape[0] == 0:
            return np.zeros(0, dtype=float)

        idx = self._to_index(pts)
        hi = np.array(self._shape, dtype=float) - 1.0
        tol = _DOMAIN_ATOL + _DOMAIN_ATOL * hi
        if np.any(idx < -tol) or np.any(idx > hi + tol):
            raise ValueError(
                "query point is out of the source grid domain: the "
                "voxel-center sample grid does not cover it; refusing to "
                "clamp or extrapolate (source-grid voxel-center bounds in "
                f"RAS mm: {self.source_grid_bounds_ras_mm()})"
            )
        return np.asarray(
            ndimage.map_coordinates(self._signed, idx.T, order=1, mode="nearest"),
            dtype=float,
        )

    def __call__(self, points) -> np.ndarray:
        """Mechanical wall convention: positive inward clearance in mm.

        RodModel subtracts the rod radius from this value. The separate
        distance() geometry API retains its negative-inside convention.
        """
        return -self.distance(points)

    def source_grid_bounds_ras_mm(self) -> np.ndarray:
        """Eight RAS corners of the oriented voxel-center sample box.

        For rotated affines the true (fail-closed) query domain is the
        transformed box, not its world-axis-aligned bounding box.
        """
        return self._corners_world.copy()

    @property
    def metadata(self) -> dict:
        corners = self._corners_world
        return {
            "spatial_units": "mm",
            "shape": self._shape,
            "voxel_spacing_mm": self._spacing.copy(),
            "affine_voxel_to_ras_mm": self.affine.copy(),
            "bounds_voxel_centers_ras_mm": corners.copy(),
            "max_voxels": MAX_VOXELS,
            "geometric_error_bound_mm": None,
            "spatial_plausibility_validated": False,
            "domain_roundoff_tolerance_voxels": _DOMAIN_ATOL * np.array(self._shape),
            "sign_convention": ("negative inside the mask (lumen interior), positive outside"),
            "mechanical_callable_sign_convention": "positive inside, negative outside",
            "sampling_model": (
                "voxel-center sampled Euclidean distance transform with "
                "per-axis physical spacing, evaluated by trilinear "
                "interpolation through the inverse voxel-to-RAS affine"
            ),
            "limitation": (
                "not an exact signed distance to any reconstructed surface: "
                "no geometric error bound is established; inter-sample values "
                "are trilinear, not Euclidean; substantive out-of-domain "
                "queries fail closed; endpoint sampling within the declared "
                "roundoff tolerance is not an extrapolation model"
            ),
        }


def build_lumen_wall_field(mask, affine, spatial_units: str = "mm") -> LumenWallField:
    """Validate inputs and build a :class:`LumenWallField`."""
    return LumenWallField(mask, affine, spatial_units=spatial_units)
