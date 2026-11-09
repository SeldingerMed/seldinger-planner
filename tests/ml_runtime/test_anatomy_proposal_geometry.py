"""Real geometry-producer and physical-diagnostic checks on synthetic anatomy."""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires optional imaging runtime", allow_module_level=True)

import numpy as np
from test_anatomy_proposals import _green_masks

from planner.anatomy_proposals import propose_aneurysm_inputs


def test_proposal_can_feed_the_actual_native_geometry_producer_without_retyping():
    from planner.geometry_worker import compute_native_geometry

    vessel, sac = _green_masks()
    proposal = propose_aneurysm_inputs(vessel, sac, np.eye(4), spatial_units="mm")
    result = compute_native_geometry(sac, vessel, np.eye(4), proposal["inputs"])
    assert result["spatial_units"] == "mm"
    for role in ("neck", "proximal_parent", "distal_parent"):
        assert result[role]["area"] > 0
    assert result["sac"]["volume"] > 0


def test_reported_plane_rms_is_distance_along_the_reported_normal():
    from scipy import ndimage

    vessel, sac = _green_masks()
    proposal = propose_aneurysm_inputs(vessel, sac, np.eye(4), spatial_units="mm")
    interface = (sac == 1) & ndimage.binary_dilation(
        (vessel == 1) & (sac == 0), structure=np.ones((3, 3, 3), bool)
    )
    points = np.argwhere(interface)
    inputs = proposal["inputs"]
    residuals = (points - inputs["neck_origin"]) @ np.asarray(inputs["neck_normal"])
    expected = float(np.sqrt(np.mean(residuals**2)))
    assert proposal["diagnostics"]["neck_plane_rms_residual_mm"] == pytest.approx(expected)


def test_proposal_requires_explicit_mm_units():
    vessel, sac = _green_masks()
    with pytest.raises(TypeError, match="spatial_units"):
        propose_aneurysm_inputs(vessel, sac, np.eye(4))


def test_edt_based_seed_rejects_sheared_affine_instead_of_claiming_physical_distance():
    vessel, sac = _green_masks()
    affine = np.eye(4)
    affine[0, 1] = 0.5
    with pytest.raises(ValueError, match="orthogonal"):
        propose_aneurysm_inputs(vessel, sac, affine, spatial_units="mm")
