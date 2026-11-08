"""Synthetic tests for the RAS-mm lumen wall signed-distance approximation.

The field under test is a voxel-center-sampled Euclidean distance transform
(EDT) evaluated by trilinear interpolation through the inverse voxel-to-RAS
affine. It is NOT an exact signed distance to any reconstructed surface and
these tests only assert bounded, center-sampled behavior on synthetic masks.
"""

import math
import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner.lumen_distance import LumenWallField, build_lumen_wall_field


def _slab_mask(shape, x_lo, x_hi):
    mask = np.zeros(shape, dtype=bool)
    mask[x_lo:x_hi, :, :] = True
    return mask


def _anisotropic_affine():
    aff = np.eye(4)
    aff[:3, :3] = np.diag([2.0, 1.0, 1.0])
    aff[:3, 3] = [10.0, 20.0, 30.0]
    return aff


def _rotation_z(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def _rotation_x(theta):
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def _oblique_affine():
    """Fresh oblique fixture: physical direction columns times voxel spacing."""
    scale = np.diag([1.5, 0.75, 1.25])
    rot = _rotation_x(0.4) @ _rotation_z(0.7)
    reflect = np.diag([-1.0, 1.0, 1.0])
    aff = np.eye(4)
    aff[:3, :3] = rot @ reflect @ scale
    aff[:3, 3] = [10.0, -5.0, 2.0]
    return aff


def _rigid_transform(theta, translation):
    aff = np.eye(4)
    aff[:3, :3] = _rotation_x(theta) @ _rotation_z(theta / 2.0)
    aff[:3, 3] = translation
    return aff


def _apply(aff, points):
    pts = np.atleast_2d(np.asarray(points, dtype=float))
    homog = np.concatenate([pts, np.ones((pts.shape[0], 1))], axis=1)
    return (aff @ homog.T).T[:, :3]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,dtype",
    [
        (np.nan, np.float64),
        (np.inf, np.float64),
        (0.5, np.float32),
        (2, np.int16),
        (-1, np.int16),
        (1 + 0j, np.complex128),
        ("1", np.str_),
        (1, object),
    ],
)
def test_rejects_nonbinary_or_nonreal_mask_contents(value, dtype):
    mask = np.zeros((4, 4, 4), dtype=dtype)
    mask[1:3] = value
    with pytest.raises(ValueError, match="finite|binary|real"):
        build_lumen_wall_field(mask, np.eye(4))


@pytest.mark.parametrize("dtype", [np.bool_, np.uint8, np.int16, np.float32, np.float64])
def test_accepts_exact_real_binary_mask_encodings(dtype):
    mask = np.zeros((4, 4, 4), dtype=dtype)
    mask[1:3] = 1
    field = build_lumen_wall_field(mask, np.eye(4))
    np.testing.assert_allclose(field.distance([[0.0, 1.0, 1.0], [1.0, 1.0, 1.0]]), [1.0, -1.0])


def test_rejects_non_mm_spatial_units():
    mask = _slab_mask((6, 4, 4), 2, 5)
    with pytest.raises(ValueError, match="mm"):
        build_lumen_wall_field(mask, _anisotropic_affine(), spatial_units="voxel")


def test_rejects_shear_affine():
    mask = _slab_mask((6, 4, 4), 2, 5)
    aff = _anisotropic_affine()
    aff[0, 1] = 0.1  # shear component breaks column orthogonality
    with pytest.raises(ValueError, match="shear|orthogonal"):
        build_lumen_wall_field(mask, aff)


def test_shear_rejection_is_independent_of_axis_anisotropy():
    affine = np.eye(4)
    affine[:3, :3] = [
        [1000.0, 1e-4 / np.sqrt(2), 0.0],
        [0.0, 1e-4 / np.sqrt(2), 0.0],
        [0.0, 0.0, 1.0],
    ]
    with pytest.raises(ValueError, match="shear|orthogonal"):
        build_lumen_wall_field(_slab_mask((4, 4, 4), 1, 3), affine)


def test_exact_orthogonal_extreme_anisotropy_is_not_mistaken_for_shear():
    affine = np.diag([1000.0, 1e-4, 1.0, 1.0])
    field = build_lumen_wall_field(_slab_mask((4, 4, 4), 1, 3), affine)
    np.testing.assert_allclose(field.metadata["voxel_spacing_mm"], [1000.0, 1e-4, 1.0])


def test_rejects_singular_affine():
    mask = _slab_mask((6, 4, 4), 2, 5)
    aff = _anisotropic_affine()
    aff[2, 2] = 0.0
    with pytest.raises(ValueError, match="invert|singular"):
        build_lumen_wall_field(mask, aff)


def test_rejects_nonhomogeneous_affine():
    mask = _slab_mask((6, 4, 4), 2, 5)
    aff = _anisotropic_affine()
    aff[3, 0] = 0.1
    with pytest.raises(ValueError, match="homogeneous"):
        build_lumen_wall_field(mask, aff)


def test_rejects_nonfinite_affine():
    mask = _slab_mask((6, 4, 4), 2, 5)
    aff = _anisotropic_affine()
    aff[1, 1] = np.nan
    with pytest.raises(ValueError, match="finite"):
        build_lumen_wall_field(mask, aff)


def test_rejects_empty_foreground_and_background():
    aff = _anisotropic_affine()
    with pytest.raises(ValueError, match="foreground"):
        build_lumen_wall_field(np.zeros((6, 4, 4), dtype=bool), aff)
    with pytest.raises(ValueError, match="background"):
        build_lumen_wall_field(np.ones((6, 4, 4), dtype=bool), aff)


def test_rejects_non_3d_mask():
    with pytest.raises(ValueError, match="3-D"):
        build_lumen_wall_field(np.zeros((6, 4), dtype=bool), _anisotropic_affine())


def test_rejects_voxel_cap_exceeded():
    # 300^3 > 256^3 without allocating the array.
    with pytest.raises(ValueError, match="cap"):
        build_lumen_wall_field(np.broadcast_to(np.uint8(1), (300, 300, 300)), np.eye(4))


# ---------------------------------------------------------------------------
# Query-point validation and fail-closed domain handling
# ---------------------------------------------------------------------------


def _small_field():
    mask = _slab_mask((8, 4, 4), 2, 7)
    return build_lumen_wall_field(mask, _anisotropic_affine())


def test_rejects_nonfinite_and_malformed_points():
    field = _small_field()
    with pytest.raises(ValueError, match="finite"):
        field.distance(np.array([[np.nan, 0.0, 0.0]]))
    with pytest.raises(ValueError, match=r"\(N, 3\)"):
        field.distance(np.zeros(3))
    with pytest.raises(ValueError, match=r"\(N, 3\)"):
        field.distance(np.zeros((2, 4)))


def test_out_of_domain_query_fails_closed():
    field = _small_field()
    meta = field.metadata
    # Far outside the source grid: must raise, not clamp or return 0.
    outside = np.array([[1000.0, 21.0, 31.0]])
    with pytest.raises(ValueError, match="out of .*source grid|domain"):
        field.distance(outside)
    # A point that maps to index -1 in one axis (outside the parallelepiped
    # even for rotated affines) must also raise.
    idx_out = np.array([[-1.0, 1.0, 1.0]])
    world_out = _apply(field.affine, idx_out)
    with pytest.raises(ValueError, match="out of .*source grid|domain"):
        field.distance(world_out)
    assert "bounds_voxel_centers_ras_mm" in meta


def test_boundary_query_exactly_on_sample_hull_is_allowed():
    field = _small_field()
    corner = _apply(field.affine, np.array([[0.0, 0.0, 0.0]]))
    values = field.distance(corner)
    assert values.shape == (1,)
    assert np.isfinite(values).all()


# ---------------------------------------------------------------------------
# Known-value anisotropic behavior (axis-aligned affine)
# ---------------------------------------------------------------------------


def test_axis_aligned_anisotropic_slab_known_values():
    # Spacing 2mm along x, 1mm elsewhere; foreground voxel centers at
    # x-index 2..7. Sign convention: negative inside mask, positive outside.
    mask = _slab_mask((8, 4, 4), 2, 7)
    field = build_lumen_wall_field(mask, _anisotropic_affine())

    def at_index(idx):
        return float(field.distance(_apply(field.affine, np.array([idx])))[0])

    # Distances at voxel centers scale with the 2mm axis spacing.
    # Foreground centers are x-indices 2..6 (mask[2:7]).
    assert at_index([2.0, 1.0, 1.0]) == pytest.approx(-2.0, abs=1e-9)
    assert at_index([3.0, 1.0, 1.0]) == pytest.approx(-4.0, abs=1e-9)
    assert at_index([1.0, 1.0, 1.0]) == pytest.approx(+2.0, abs=1e-9)
    assert at_index([0.0, 1.0, 1.0]) == pytest.approx(+4.0, abs=1e-9)
    assert at_index([6.0, 1.0, 1.0]) == pytest.approx(-2.0, abs=1e-9)
    assert at_index([7.0, 1.0, 1.0]) == pytest.approx(+2.0, abs=1e-9)
    # Zero crossings sit midway between adjacent opposite-class centers.
    assert at_index([1.5, 1.0, 1.0]) == pytest.approx(0.0, abs=1e-9)
    assert at_index([6.5, 1.0, 1.0]) == pytest.approx(0.0, abs=1e-9)
    assert at_index([1.25, 1.0, 1.0]) == pytest.approx(+1.0, abs=1e-9)
    assert at_index([1.75, 1.0, 1.0]) == pytest.approx(-1.0, abs=1e-9)


def test_isotropic_sphere_sign_and_coarse_magnitude():
    # Radius 5 voxels, 0.5mm spacing: center sample must be negative with
    # magnitude in a coarse band around 2.5mm (center-sampled EDT).
    rng = np.random.default_rng(7)
    shape = (16, 16, 16)
    centers = np.indices(shape).astype(float) + 0.0
    radius = np.sqrt((centers[0] - 7.5) ** 2 + (centers[1] - 7.5) ** 2 + (centers[2] - 7.5) ** 2)
    mask = radius <= 5.0
    aff = np.eye(4)
    aff[:3, :3] = np.diag([0.5, 0.5, 0.5])
    field = build_lumen_wall_field(mask, aff)
    s_center = float(field.distance(_apply(aff, np.array([[7.5, 7.5, 7.5]])))[0])
    assert -3.3 < s_center < -2.0
    s_far = float(field.distance(np.array([[0.1, 0.1, 0.1]]))[0])
    assert s_far > 0.0
    # Sign agreement with an independently sampled point cloud.
    pts = rng.uniform(0.0, 7.5, size=(200, 3))
    world = _apply(aff, pts)
    values = field.distance(world)
    # Rigorous trilinear invariant: order=1 interpolation is a convex
    # combination of the 8 surrounding sample corners, so the value must lie
    # within [min8, max8] and match the corner sign when all 8 agree.
    lo = np.clip(np.floor(pts), 0, 14).astype(int)
    corner_vals = np.empty((pts.shape[0], 8))
    for c, (di, dj, dk) in enumerate([(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]):
        idx_c = lo + np.array([di, dj, dk])
        corner_vals[:, c] = field.distance(_apply(aff, idx_c.astype(float)))
    lo_v, hi_v = corner_vals.min(axis=1), corner_vals.max(axis=1)
    assert np.all(values >= lo_v - 1e-9) and np.all(values <= hi_v + 1e-9)
    assert np.all(values[lo_v > 0.0] > 0.0)
    assert np.all(values[hi_v < 0.0] < 0.0)


# ---------------------------------------------------------------------------
# Oblique mapping: rigid invariance and known crossing in world space
# ---------------------------------------------------------------------------


def test_oblique_rigid_invariance_and_sign():
    mask = _slab_mask((8, 4, 4), 2, 7)
    aff1 = _oblique_affine()
    b = _rigid_transform(0.3, [5.0, -3.0, 2.0])
    aff2 = b @ aff1  # rigid world-frame transform, not a change of index axes

    field1 = build_lumen_wall_field(mask, aff1)
    field2 = build_lumen_wall_field(mask, aff2)

    idx = np.array([[2.0, 1.0, 1.0], [1.5, 1.0, 1.0], [3.5, 2.5, 1.0], [0.0, 0.0, 0.0]])
    p1 = _apply(aff1, idx)
    p2 = _apply(aff2, idx)  # same voxel indices expressed in the moved frame
    s1 = field1.distance(p1)
    s2 = field2.distance(p2)
    assert np.allclose(s1, s2, atol=1e-9)

    # Deep interior negative, far exterior positive under the oblique map.
    assert float(field1.distance(_apply(aff1, [[4.0, 1.0, 1.0]]))[0]) < 0.0
    # far-in-domain exterior positive; known crossing survives the map.
    assert float(field1.distance(_apply(aff1, [[0.0, 1.0, 1.0]]))[0]) > 0.0
    assert float(field1.distance(_apply(aff1, [[1.5, 1.0, 1.0]]))[0]) == pytest.approx(
        0.0, abs=1e-9
    )


# ---------------------------------------------------------------------------
# Metadata and reported bounds
# ---------------------------------------------------------------------------


def test_metadata_reports_units_spacing_and_voxel_center_bounds():
    mask = _slab_mask((8, 4, 4), 2, 7)
    aff = _oblique_affine()
    field = build_lumen_wall_field(mask, aff)
    meta = field.metadata
    assert meta["spatial_units"] == "mm"
    assert meta["shape"] == (8, 4, 4)
    assert np.allclose(meta["voxel_spacing_mm"], [1.5, 0.75, 1.25])
    assert "voxel-center sampled" in meta["sampling_model"]
    assert "not an exact" in meta["limitation"]
    corners = np.array([[i, j, k] for i in (0, 7) for j in (0, 3) for k in (0, 3)], dtype=float)
    expected = _apply(aff, corners)
    reported = np.asarray(meta["bounds_voxel_centers_ras_mm"], dtype=float)
    assert np.allclose(reported.min(axis=0), expected.min(axis=0))
    assert np.allclose(reported.max(axis=0), expected.max(axis=0))


def test_callable_field_matches_rod_positive_inside_contact_convention():
    from planner.rod_contact import RodModel

    field = _small_field()
    points = _apply(field.affine, np.array([[3.0, 1.0, 1.0], [3.0, 2.0, 1.0], [3.0, 3.0, 1.0]]))
    model = RodModel(points, radius=0.1, ea=1.0, ei=0.1)
    assert np.all(field.distance(points) < 0.0)  # conventional geometry API
    assert np.all(field(points) > 0.0)  # mechanical wall callable
    assert model.contact_energy(points, field) == 0.0
    shifted = points.copy()
    shifted[:, 0] -= 4.0
    assert model.contact_energy(shifted, field) > 0.0


def test_field_snapshots_affine_and_does_not_leak_mutable_corner_metadata():
    affine = _anisotropic_affine()
    expected = affine.copy()
    field = build_lumen_wall_field(_slab_mask((8, 4, 4), 2, 7), affine)
    before = field.source_grid_bounds_ras_mm()
    affine[:3, 3] += 100.0
    assert np.array_equal(field.metadata["affine_voxel_to_ras_mm"], expected)
    field.metadata["bounds_voxel_centers_ras_mm"][:] = 0.0
    assert np.array_equal(field.source_grid_bounds_ras_mm(), before)


def test_metadata_exposes_roundoff_policy_and_unestablished_geometry_error_bound():
    field = _small_field()
    meta = field.metadata
    assert "geometric_error_bound_mm" in meta
    assert meta["geometric_error_bound_mm"] is None
    assert meta["spatial_plausibility_validated"] is False
    np.testing.assert_allclose(
        meta["domain_roundoff_tolerance_voxels"], np.array(meta["shape"]) * 1e-9
    )


def test_convenience_builder_returns_field():
    mask = _slab_mask((8, 4, 4), 2, 7)
    field = build_lumen_wall_field(mask, _anisotropic_affine())
    assert isinstance(field, LumenWallField)
