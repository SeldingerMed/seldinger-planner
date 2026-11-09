"""Synthetic tests for the anatomy-to-geometry proposal helper.

``propose_aneurysm_inputs`` derives an editable operator-geometry proposal
from the accepted binary masks and the RAS-mm affine. The proposal is a
numerical starting point requiring explicit operator confirmation; nothing
here is a validated clinical measurement. A known-value straight tube with
an attached spherical sac is exercised first; bounded/degenerate negatives
are added only after that green path holds.
"""

import os

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner.anatomy_proposals import propose_aneurysm_inputs

AFFINE = np.eye(4)
TUBE_AXIS = np.array([8.0, 8.0])  # x, y of the straight tube axis
SAC_CENTER = np.array([8.0, 4.0, 12.0])  # attached on the -y side
SAC_RADIUS = 3.0
TUBE_RADIUS = 2.0
NECK_CENTER = np.array([8.0, 6.0, 12.0])  # sphere/tube overlap disc


def _green_masks():
    x, y, z = np.indices((16, 16, 24))
    tube = (x - TUBE_AXIS[0]) ** 2 + (y - TUBE_AXIS[1]) ** 2 <= TUBE_RADIUS**2
    tube = tube & (z >= 2) & (z <= 21)
    sac = (x - SAC_CENTER[0]) ** 2 + (y - SAC_CENTER[1]) ** 2 + (
        z - SAC_CENTER[2]
    ) ** 2 <= SAC_RADIUS**2
    vessel = (tube | sac).astype(np.uint8)
    aneurysm = sac.astype(np.uint8)
    return vessel, aneurysm


def _assert_axis_constrained(points, limit=TUBE_RADIUS + 1.5):
    for point in points:
        in_plane = np.linalg.norm(np.asarray(point[:2]) - TUBE_AXIS)
        assert in_plane <= limit


def test_green_tube_with_attached_sac_known_values():
    vessel, aneurysm = _green_masks()
    result = propose_aneurysm_inputs(vessel, aneurysm, AFFINE, spatial_units="mm")

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
    # Interface centroid sits on the tube-sphere overlap disc at the neck.
    assert np.linalg.norm(neck - NECK_CENTER) <= 1.5
    normal = np.asarray(inputs["neck_normal"])
    assert abs(np.linalg.norm(normal) - 1.0) <= 1e-12
    # Unit normal is outward, toward the sac, and roughly along -y.
    assert float(normal @ (SAC_CENTER - neck)) > 0.0
    assert float(normal @ np.array([0.0, -1.0, 0.0])) > 0.8

    seed = np.asarray(inputs["aneurysm_seed"])
    # Deepest interior sac voxel is near the sac centre, away from the neck.
    assert np.linalg.norm(seed - SAC_CENTER) <= 1.5
    assert np.linalg.norm(seed - neck) >= 1.5

    path = inputs["parent_path"]
    assert 4 <= len(path) <= 32
    assert 0 < inputs["proximal_index"] < len(path) - 1
    assert 0 < inputs["distal_index"] < len(path) - 1
    assert inputs["proximal_index"] != inputs["distal_index"]
    _assert_axis_constrained(path)
    assert result["diagnostics"]["interface_voxel_count"] >= 3
    assert result["diagnostics"]["target_component_selected"] is False
    assert result["diagnostics"]["aneurysm_component_voxels"] > 0


def test_green_determinism_and_scale_consistency():
    vessel, aneurysm = _green_masks()
    first = propose_aneurysm_inputs(vessel, aneurysm, AFFINE, spatial_units="mm")
    second = propose_aneurysm_inputs(vessel, aneurysm, AFFINE, spatial_units="mm")
    assert first == second

    # A pure 2mm-isotropic scaling maps the same anatomy to doubled RAS
    # coordinates: the proposal must follow the physical affine, not indices.
    scaled = np.diag([2.0, 2.0, 2.0, 1.0])
    scaled_result = propose_aneurysm_inputs(vessel, aneurysm, scaled, spatial_units="mm")
    assert np.allclose(
        np.asarray(scaled_result["inputs"]["neck_origin"]),
        np.asarray(first["inputs"]["neck_origin"]) * 2.0,
    )
    assert np.allclose(
        scaled_result["inputs"]["neck_normal"], first["inputs"]["neck_normal"], atol=1e-9
    )


def test_target_selects_requested_component_among_many():
    vessel, aneurysm = _green_masks()
    x, y, z = np.indices(vessel.shape)
    second = ((x - 8) ** 2 + (y - 12) ** 2 + (z - 6) ** 2 <= 9).astype(np.uint8)
    combined = aneurysm | second
    with pytest.raises(ValueError, match="explicit"):
        propose_aneurysm_inputs(vessel, combined, AFFINE, spatial_units="mm")
    targeted = propose_aneurysm_inputs(
        vessel, combined, AFFINE, target_ras=[8.0, 11.0, 6.0], spatial_units="mm"
    )
    assert targeted["diagnostics"]["target_component_selected"] is True
    assert targeted["diagnostics"]["aneurysm_component_voxels"] == int(np.count_nonzero(second))
    green = propose_aneurysm_inputs(vessel, aneurysm, AFFINE, spatial_units="mm")
    assert targeted["inputs"]["neck_origin"] != green["inputs"]["neck_origin"]
    assert np.allclose(np.asarray(targeted["inputs"]["neck_origin"]), [8.0, 10.0, 6.0], atol=1.5)
    assert float(np.asarray(targeted["inputs"]["neck_normal"]) @ np.array([0.0, 1.0, 0.0])) > 0.8


def test_target_must_round_onto_aneurysm_foreground():
    vessel, aneurysm = _green_masks()
    with pytest.raises(ValueError, match="round onto aneurysm foreground"):
        propose_aneurysm_inputs(
            vessel, aneurysm, AFFINE, target_ras=[1.0, 1.0, 1.0], spatial_units="mm"
        )
    with pytest.raises(ValueError, match="outside the installed image"):
        propose_aneurysm_inputs(
            vessel, aneurysm, AFFINE, target_ras=[50.0, 0.0, 0.0], spatial_units="mm"
        )
    with pytest.raises(ValueError, match="three finite coordinates"):
        propose_aneurysm_inputs(
            vessel, aneurysm, AFFINE, target_ras=[0.0, float("nan"), 0.0], spatial_units="mm"
        )


@pytest.mark.parametrize(
    ("vessel_override", "aneurysm_override", "message"),
    [
        (None, "empty", "Aneurysm mask is empty"),
        ("empty", None, "Vessel mask is empty"),
        (None, "disconnected", "interface"),
        (None, "sliver", "interface"),
        (None, "rod", "degenerate"),
    ],
)
def test_anatomy_rejections(vessel_override, aneurysm_override, message):
    vessel, aneurysm = _green_masks()
    if vessel_override == "empty":
        vessel = np.zeros_like(vessel)
    if aneurysm_override == "empty":
        aneurysm = np.zeros_like(aneurysm)
    elif aneurysm_override == "disconnected":
        aneurysm = np.zeros_like(aneurysm)
        aneurysm[2:5, 1:4, 8:11] = 1  # off the tube, never touching vessel
    elif aneurysm_override == "sliver":
        aneurysm = np.zeros_like(aneurysm)
        aneurysm[8, 4, 12] = 1  # single voxel: a point, not a neck disc
    elif aneurysm_override == "rod":
        aneurysm = np.zeros_like(aneurysm)
        aneurysm[8, 5, 5:20] = 1  # collinear filament on the tube surface
    with pytest.raises(ValueError, match=message):
        propose_aneurysm_inputs(vessel, aneurysm, AFFINE, spatial_units="mm")


def test_interface_spans_disconnected_vessel_components():
    vessel, aneurysm = _green_masks()
    split = vessel.copy()
    split[:, :, 12] = 0  # cut the parent vessel in two under the sac
    with pytest.raises(ValueError, match="disconnected vessel"):
        propose_aneurysm_inputs(split, aneurysm, AFFINE, spatial_units="mm")


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"spatial_units": "cm"}, "spatial_units"),
    ],
)
def test_units_and_affine_guards(kwargs, message):
    vessel, aneurysm = _green_masks()
    with pytest.raises(ValueError, match=message):
        propose_aneurysm_inputs(vessel, aneurysm, AFFINE, **kwargs)
    singular = AFFINE.copy()
    singular[0, 0] = 0.0
    for bad in (singular, np.eye(3), AFFINE.copy() * float("nan")):
        with pytest.raises(ValueError, match="affine"):
            propose_aneurysm_inputs(vessel, aneurysm, bad, spatial_units="mm")


def test_mask_input_guards():
    vessel, aneurysm = _green_masks()
    with pytest.raises(ValueError, match="share one grid"):
        propose_aneurysm_inputs(vessel, aneurysm[:, :, :20], AFFINE, spatial_units="mm")
    with pytest.raises(ValueError, match="three-dimensional"):
        propose_aneurysm_inputs(vessel[0], aneurysm, AFFINE, spatial_units="mm")
    with pytest.raises(ValueError, match="binary"):
        propose_aneurysm_inputs(vessel * 2, aneurysm, AFFINE, spatial_units="mm")
    with pytest.raises(ValueError, match="binary"):
        propose_aneurysm_inputs(vessel.astype(float) + 0.5, aneurysm, AFFINE, spatial_units="mm")
