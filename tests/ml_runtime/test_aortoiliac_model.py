"""Synthetic tests for the aorta and iliac model proposal.

`propose_aortoiliac_model` turns one binary mask of the aorta and the iliac
arteries into named centerlines with radii: the aorta down to its
bifurcation and the right and left iliac arteries below it. The phantoms
here are tubes at known places, so each test states where the model must
lie. The result is a proposal the operator confirms.
"""

import os
from itertools import pairwise

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

from planner.aortoiliac_model import METHOD, propose_aortoiliac_model

BIFURCATION = (0.0, 0.0, 0.0)
AORTA_TOP = (0.0, 0.0, 150.0)
RIGHT_END = (42.0, 10.0, -110.0)  # RAS: +x is the patient's right
LEFT_END = (-42.0, 10.0, -110.0)
AORTA = (AORTA_TOP, BIFURCATION, 9.0)
RIGHT = (BIFURCATION, RIGHT_END, 5.0)
LEFT = (BIFURCATION, LEFT_END, 5.0)
RENALS = [((0.0, 0.0, 90.0), (38.0, 0.0, 84.0), 3.0), ((0.0, 0.0, 96.0), (-38.0, 0.0, 88.0), 3.0)]
INTERNALS = [
    ((25.2, 6.0, -66.0), (30.0, -22.0, -100.0), 2.8),
    ((-25.2, 6.0, -66.0), (-30.0, -22.0, -100.0), 2.8),
]


def grid(
    spacing=(1.5, 1.5, 1.5), signs=(1, 1, 1), low=(-62.0, -40.0, -128.0), high=(62.0, 30.0, 166.0)
):
    """A grid over the phantom's box and its voxel-to-RAS affine. A negative
    sign runs that index axis against its RAS axis, as an LPS scan does."""
    shape = tuple(int(np.ceil((high[i] - low[i]) / spacing[i])) + 1 for i in range(3))
    affine = np.eye(4)
    for i in range(3):
        affine[i, i] = signs[i] * spacing[i]
        affine[i, 3] = low[i] if signs[i] > 0 else low[i] + spacing[i] * (shape[i] - 1)
    return shape, affine


def tubes(shape, affine, capsules):
    """The mask of a set of round-ended tubes, built a slab at a time so a
    fine grid stays small in memory."""
    mask = np.zeros(shape, dtype=np.uint8)
    matrix, origin = affine[:3, :3].astype(np.float32), affine[:3, 3].astype(np.float32)
    j, k = np.indices(shape[1:], dtype=np.float32).reshape(2, -1)
    for i in range(shape[0]):
        index = np.stack([np.full_like(j, i), j, k])
        points = (matrix @ index).T + origin
        inside = np.zeros(points.shape[0], dtype=bool)
        for start, end, radius in capsules:
            a, b = np.asarray(start, np.float32), np.asarray(end, np.float32)
            along = np.clip(((points - a) @ (b - a)) / float((b - a) @ (b - a)), 0, 1)
            inside |= np.linalg.norm(points - (a + along[:, None] * (b - a)), axis=1) <= radius
        mask[i] = inside.reshape(shape[1:])
    return mask


def off_axis(path, capsule):
    """How far each point lies from a tube's axis. The axis is carried on
    past the bifurcation: the lumens part a little below where the three
    axes cross, and the lines meet there."""
    a, b = np.asarray(capsule[0]), np.asarray(capsule[1])
    p = np.asarray(path)
    along = ((p - a) @ (b - a)) / float((b - a) @ (b - a))
    low, high = (
        (-0.2, 1)
        if np.allclose(a, BIFURCATION)
        else (0, 1.2)
        if np.allclose(b, BIFURCATION)
        else (0, 1)
    )
    along = np.clip(along, low, high)
    return np.linalg.norm(p - (a + along[:, None] * (b - a)), axis=1)


def branch(model, name):
    return next(b for b in model["branches"] if b["name"] == name)


def check_whole_model(model):
    assert model["method"] == METHOD
    assert model["operator_confirmation_required"] is True
    assert model["clinical_validation"] is False
    assert model["spatial_units"] == "mm"
    assert [b["name"] for b in model["branches"]] == ["aorta", "right_iliac", "left_iliac"]
    # The bifurcation is where the lumen divides: the two iliac tubes part
    # 13 mm below the point their axes leave from. The three lines meet above
    # it, in the middle of the aorta.
    divides = np.asarray(model["bifurcation_ras"])
    assert abs(divides[0]) < 2 and abs(divides[1] - 1.2) < 3 and -17 < divides[2] < -9
    meet = np.asarray(branch(model, "aorta")["path_ras"][-1])
    assert abs(meet[0]) < 2 and abs(meet[1]) < 3 and -9 < meet[2] < 6
    assert model["bifurcation_below_meeting_mm"] == pytest.approx(meet[2] - divides[2], abs=3)
    for name, capsule, end in (
        ("aorta", AORTA, AORTA_TOP),
        ("right_iliac", RIGHT, RIGHT_END),
        ("left_iliac", LEFT, LEFT_END),
    ):
        b = branch(model, name)
        path, radius = np.asarray(b["path_ras"]), np.asarray(b["radius_mm"])
        assert path.shape == (len(radius), 3) and len(radius) >= 4
        away = off_axis(path, capsule)
        assert np.median(away) < 0.5 and away.max() < 2.5, name
        assert abs(np.median(radius) - capsule[2]) < 0.5, name
        steps = np.linalg.norm(np.diff(path, axis=0), axis=1)
        assert b["length_mm"] == pytest.approx(steps.sum(), abs=1e-6)
        assert 1.8 < steps.min() and steps.max() < 2.2
        # The aorta runs down to the bifurcation; an iliac artery runs away from it.
        far, near = (path[0], path[-1]) if name == "aorta" else (path[-1], path[0])
        assert near.tolist() == meet.tolist(), name
        assert np.linalg.norm(far - end) < capsule[2] + 4, name


def test_names_the_aorta_and_both_iliac_arteries_with_their_radii():
    shape, affine = grid()
    model = propose_aortoiliac_model(tubes(shape, affine, [AORTA, RIGHT, LEFT]), affine)
    check_whole_model(model)
    assert branch(model, "aorta")["length_mm"] == pytest.approx(150, abs=12)


def test_side_branches_do_not_take_the_place_of_the_bifurcation():
    shape, affine = grid()
    mask = tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS, *INTERNALS])
    check_whole_model(propose_aortoiliac_model(mask, affine))


@pytest.mark.parametrize("signs", [(-1, -1, 1), (1, -1, -1), (-1, 1, -1)])
def test_right_and_left_follow_the_patient_not_the_index_order(signs):
    shape, affine = grid(signs=signs)
    mask = tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS])
    check_whole_model(propose_aortoiliac_model(mask, affine))


def test_thick_slices_and_a_fine_grid_are_read_on_the_same_working_grid():
    for spacing in ((0.8, 0.8, 3.0), (0.6, 0.6, 0.6), (0.74, 0.74, 5.0)):
        shape, affine = grid(spacing=spacing)
        model = propose_aortoiliac_model(
            tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS]), affine
        )
        check_whole_model(model)
        assert model["working_spacing_mm"] == [1.5, 1.5, 1.5]


def test_an_aorta_with_an_arch_is_followed_round_to_its_root():
    arch = [((0.0, 0.0, 150.0), (0.0, 0.0, 250.0), 11.0)]
    centre, radius = np.array([0.0, 30.0, 250.0]), 30.0
    turn = np.linspace(np.pi, 0, 9)
    bend = [centre + radius * np.array([0.0, np.cos(t), np.sin(t)]) for t in turn]
    arch += [(tuple(a), tuple(b), 12.0) for a, b in pairwise(bend)]
    arch += [((0.0, 60.0, 250.0), (0.0, 60.0, 190.0), 14.0)]  # ascending aorta, down to the root
    neck = [
        ((0.0, 30.0, 280.0), (0.0, 28.0, 335.0), 5.5),
        ((0.0, 12.0, 274.0), (-8.0, 8.0, 335.0), 4.0),
    ]
    shape, affine = grid(high=(62.0, 80.0, 340.0))
    mask = tubes(shape, affine, [AORTA, RIGHT, LEFT, *RENALS, *arch, *neck])
    model = propose_aortoiliac_model(mask, affine)
    assert [b["name"] for b in model["branches"]] == ["aorta", "right_iliac", "left_iliac"]
    aorta = np.asarray(branch(model, "aorta")["path_ras"])
    assert np.linalg.norm(aorta[0] - (0.0, 60.0, 190.0)) < 18
    assert aorta[-1].tolist() == branch(model, "right_iliac")["path_ras"][0]
    assert -17 < model["bifurcation_ras"][2] < -9
    assert branch(model, "aorta")["length_mm"] == pytest.approx(250 + np.pi * 30 + 60, abs=25)


def test_a_fork_whose_every_arm_runs_toward_the_feet_is_not_the_bifurcation():
    # A chest scan: the arch, the ascending and the descending aorta, and a
    # third wide channel that leaves the arch downward, as a false lumen
    # does. Two of the three could pass for iliac arteries; the aorta above
    # them could not, since it runs down as well.
    centre, radius = np.array([0.0, 30.0, 250.0]), 30.0
    bend = [
        centre + radius * np.array([0.0, np.cos(t), np.sin(t)]) for t in np.linspace(np.pi, 0, 9)
    ]
    chest = [((0.0, 0.0, 120.0), (0.0, 0.0, 250.0), 11.0)]
    chest += [
        (tuple(a), tuple(b), 11.0 if k < 4 else 15.0) for k, (a, b) in enumerate(pairwise(bend))
    ]
    chest += [((0.0, 60.0, 250.0), (0.0, 60.0, 190.0), 15.0)]
    chest += [((0.0, 30.0, 278.0), (40.0, 30.0, 200.0), 9.0)]
    shape, affine = grid(low=(-62.0, -40.0, 120.0), high=(62.0, 80.0, 300.0))
    model = propose_aortoiliac_model(tubes(shape, affine, chest), affine)
    assert [b["name"] for b in model["branches"]] == ["aorta"]
    assert model["bifurcation_ras"] is None


def test_in_a_wide_aorta_the_bifurcation_is_still_where_the_lumen_divides():
    # An aneurysm that runs down to the bifurcation: the iliac lines come
    # together high in the sac, and the lumen divides where it did before.
    sac = ((0.0, 0.0, 60.0), (0.0, 0.0, 12.0), 22.0)
    shape, affine = grid()
    model = propose_aortoiliac_model(tubes(shape, affine, [AORTA, RIGHT, LEFT, sac]), affine)
    assert [b["name"] for b in model["branches"]] == ["aorta", "right_iliac", "left_iliac"]
    divides = np.asarray(model["bifurcation_ras"])
    assert abs(divides[0]) < 3 and -20 < divides[2] < -9
    meet = np.asarray(branch(model, "aorta")["path_ras"][-1])
    assert meet[2] > divides[2] + 8
    assert model["bifurcation_below_meeting_mm"] > 8


def test_a_scan_that_ends_above_the_pelvis_gives_the_aorta_alone():
    shape, affine = grid(low=(-62.0, -40.0, 20.0))
    model = propose_aortoiliac_model(tubes(shape, affine, [AORTA, *RENALS]), affine)
    assert [b["name"] for b in model["branches"]] == ["aorta"]
    assert model["bifurcation_ras"] is None and model["bifurcation_below_meeting_mm"] is None
    path = np.asarray(model["branches"][0]["path_ras"])
    assert path[0][2] > path[-1][2]  # head to foot
    # The scan cuts the aorta flat at z = 20: the line runs down the middle
    # to within a radius of the cut.
    assert off_axis(path, AORTA).max() < 3.5
    assert 20 < path[-1][2] < 29
    assert abs(np.median(model["branches"][0]["radius_mm"]) - 9) < 0.5


def test_a_piece_apart_from_the_aorta_is_left_out_and_counted():
    shape, affine = grid()
    apart = ((50.0, -30.0, 100.0), (50.0, -30.0, 130.0), 3.0)
    model = propose_aortoiliac_model(tubes(shape, affine, [AORTA, RIGHT, LEFT, apart]), affine)
    check_whole_model(model)
    assert 600 < model["volume_apart_from_the_model_mm3"] < 1400  # the tube holds about 960
    whole = propose_aortoiliac_model(tubes(shape, affine, [AORTA, RIGHT, LEFT]), affine)
    assert whole["volume_apart_from_the_model_mm3"] == 0


def test_what_is_not_a_mask_on_a_scan_grid_is_refused():
    shape, affine = grid()
    mask = tubes(shape, affine, [AORTA, RIGHT, LEFT])
    with pytest.raises(ValueError, match="binary"):
        propose_aortoiliac_model(mask * 2, affine)
    with pytest.raises(ValueError, match="three-dimensional"):
        propose_aortoiliac_model(mask[0], affine)
    with pytest.raises(ValueError, match="empty"):
        propose_aortoiliac_model(np.zeros(shape, np.uint8), affine)
    with pytest.raises(ValueError, match="affine"):
        propose_aortoiliac_model(mask, np.zeros((4, 4)))
    sheared = affine.copy()
    sheared[0, 1] = 0.7
    with pytest.raises(ValueError, match="affine"):
        propose_aortoiliac_model(mask, sheared)
    with pytest.raises(ValueError, match="units"):
        propose_aortoiliac_model(mask, affine, spatial_units="cm")
    speck = np.zeros(shape, np.uint8)
    speck[5:8, 5:8, 5:8] = 1
    with pytest.raises(ValueError, match="too small"):
        propose_aortoiliac_model(speck, affine)
