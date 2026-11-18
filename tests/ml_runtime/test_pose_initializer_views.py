"""View bins of the learned view initializer: geometry, targets and proposals."""

import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import views

from planner import carm_geometry

ANGLES = [(0, 0), (90, 0), (-90, 0), (30, 20), (-117.5, 41.25), (45, -50), (120, 50)]


def test_the_bins_cover_the_declared_range_every_ten_degrees():
    assert views.BINS == 275
    assert (views.BIN_PRIMARY[0], views.BIN_SECONDARY[0]) == (-120, -50)
    assert (views.BIN_PRIMARY[24], views.BIN_SECONDARY[24]) == (120, -50)
    assert (views.BIN_PRIMARY[25], views.BIN_SECONDARY[25]) == (-120, -40)
    assert (views.BIN_PRIMARY[-1], views.BIN_SECONDARY[-1]) == (120, 50)


@pytest.mark.parametrize(("primary", "secondary"), ANGLES)
def test_the_view_frame_is_the_planners(primary, secondary):
    ours = views.view_frame(primary, secondary)
    theirs = carm_geometry.view_frame(primary, secondary)
    for mine, planner in zip(ours, theirs, strict=True):
        assert np.allclose(mine, planner, atol=1e-12)


@pytest.mark.parametrize(("primary", "secondary"), ANGLES)
def test_angles_are_read_back_from_a_direction(primary, secondary):
    direction = views.view_frame(primary, secondary)[2]
    found = views.angles_of(3.7 * direction)
    assert np.allclose(found, (primary, secondary), atol=1e-9)


@pytest.mark.parametrize("turn", [-25.0, 0.0, 10.0, 170.0])
def test_a_turned_frame_stays_right_handed_and_its_turn_is_read_back(turn):
    u, v, d = views.turned_frame(35.0, -20.0, turn)
    assert np.allclose(np.cross(u, v), d, atol=1e-12)
    assert np.isclose(views.turn_of(v, 35.0, -20.0), turn, atol=1e-9)


def test_a_positive_turn_moves_image_up_toward_image_left():
    u, v, _ = views.view_frame(0.0, 0.0)
    _, up, _ = views.turned_frame(0.0, 0.0, 90.0)
    assert np.allclose(up, -u, atol=1e-12)
    assert not np.allclose(up, v)


def test_separation_is_the_angle_between_viewing_directions():
    assert np.isclose(views.separation_deg(0, 0, 90, 0), 90)
    assert np.isclose(views.separation_deg(10, 0, 10, 35), 35)
    # Ten degrees of primary angle is less than ten degrees apart off the equator.
    assert views.separation_deg(0, 50, 10, 50) < 6.5


def test_targets_weigh_the_bins_near_the_view_and_no_others():
    weight, offsets, turn = views.targets(32.0, 18.0, 12.0)
    assert np.isclose(weight.sum(), 1, atol=1e-6)
    best = int(weight.argmax())
    assert (views.BIN_PRIMARY[best], views.BIN_SECONDARY[best]) == (30, 20)
    apart = views.separation_deg(32.0, 18.0, views.BIN_PRIMARY, views.BIN_SECONDARY)
    assert (weight[apart > views.TARGET_REACH_DEG] == 0).all()
    assert (weight[apart < 10] > 0).all()
    assert np.allclose(offsets[best], (0.2, -0.2), atol=1e-6)
    assert np.allclose(turn, 0.4)


def test_a_view_outside_every_bin_still_teaches_its_nearest_bin():
    weight, offsets, _ = views.targets(150.0, 0.0, 0.0)
    best = int(weight.argmax())
    assert weight[best] == 1 and (views.BIN_PRIMARY[best], views.BIN_SECONDARY[best]) == (120, 0)
    assert np.allclose(offsets[best], (3.0, 0.0))


def answer(peaks):
    scores = np.full(views.BINS, -9.0)
    offsets = np.zeros((views.BINS, 2))
    turns = np.zeros(views.BINS)
    for (primary, secondary), logit, offset, turn in peaks:
        index = int(
            np.argmin(np.abs(views.BIN_PRIMARY - primary) + np.abs(views.BIN_SECONDARY - secondary))
        )
        scores[index], offsets[index], turns[index] = logit, offset, turn
    return scores, offsets, turns


def test_proposals_are_ranked_and_carry_the_offsets_of_their_bins():
    found = views.proposals(
        *answer([((90, 0), 5.0, (0.3, -0.4), 0.5), ((-90, 0), 4.0, (0, 0), -0.2)])
    )
    assert len(found) == views.MAX_PROPOSALS
    first, second = found[0], found[1]
    assert np.allclose(
        (first["primary_deg"], first["secondary_deg"], first["turn_deg"]), (93, -4, 15)
    )
    assert np.allclose(
        (second["primary_deg"], second["secondary_deg"], second["turn_deg"]), (-90, 0, -6)
    )
    assert first["share"] > second["share"] > found[2]["share"]
    assert abs(sum(item["share"] for item in found)) <= 1


def test_no_two_proposals_are_closer_than_the_minimum_separation():
    found = views.proposals(
        *answer([((30, 0), 5.0, (0, 0), 0), ((40, 0), 4.9, (0, 0), 0), ((0, 30), 3.0, (0, 0), 0)])
    )
    assert [(item["primary_deg"], item["secondary_deg"]) for item in found[:2]] == [
        (30, 0),
        (0, 30),
    ]
    for i, a in enumerate(found):
        for b in found[i + 1 :]:
            assert (
                views.separation_deg(
                    a["primary_deg"], a["secondary_deg"], b["primary_deg"], b["secondary_deg"]
                )
                >= views.MIN_SEPARATION_DEG
            )


@pytest.mark.parametrize(
    "change",
    [
        lambda s, o, t: (s[:-1], o, t),
        lambda s, o, t: (s, o[:, :1], t),
        lambda s, o, t: (s, o, t[:-1]),
        lambda s, o, t: (np.where(np.arange(s.size) == 3, np.nan, s), o, t),
        lambda s, o, t: (s, o * np.inf, t),
    ],
)
def test_an_answer_of_the_wrong_shape_or_with_a_bad_number_is_refused(change):
    with pytest.raises(ValueError, match="Invalid network answer"):
        views.proposals(*change(*answer([((0, 0), 1.0, (0.1, 0.1), 0)])))
