"""Vessel models and synthetic frames of the learned view initializer."""

import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import frames, vessels, views

from planner import carm_geometry

AFFINE = np.array([[1.0, 0, 0, -32], [0, 1, 0, -32], [0, 0, 1, 10], [0, 0, 0, 1]])


def tubes(gap=40, bridge=True, shape=(64, 64, 64)):
    """Two upright square tubes ``gap`` voxels apart, joined near the top."""
    mask = np.zeros(shape, dtype=np.uint8)
    left = 10
    mask[left : left + 5, 30:35, 2:62] = 1
    mask[left + gap : left + gap + 5, 30:35, 2:62] = 1
    if bridge:
        mask[left : left + gap + 5, 30:35, 50:55] = 1
    return mask


def test_each_tube_is_an_inlet_and_owns_its_half_of_the_bridge():
    model = vessels.vessel_model(tubes(), AFFINE)
    assert model["points"].shape == (len(model["cell"]), 3)
    assert len(model["inlets"]) == 2 and (model["cell"] >= 0).all()
    x = model["points"][:, 0]
    middle = (10 + 40 / 2 + 2) - 32
    first, second = (model["cell"] == inlet for inlet in model["inlets"])
    assert (x[first] < middle + 1).all() and (x[second] > middle - 1).all()
    assert abs(int(first.sum()) - int(second.sum())) <= 60
    assert np.isclose(model["voxel_mm3"], 1)


def test_distance_along_the_vessels_goes_up_a_tube_and_across_the_bridge():
    model = vessels.vessel_model(tubes(), AFFINE)
    points, along = model["points"], model["along"]
    own = model["cell"] == model["inlets"][0]
    bottom = points[:, 2].min()
    # Inside the slab the distance is zero; up the tube it is the height.
    assert (along[0][own & (points[:, 2] <= bottom + vessels.SLAB_MM)] == 0).all()
    top = own & (points[:, 2] == points[:, 2].max())
    height = points[:, 2].max() - bottom - vessels.SLAB_MM
    assert np.allclose(along[0][top], height, atol=3)
    # The other tube is reached over the bridge, never through the air.
    other_bottom = ~own & (points[:, 2] == bottom)
    assert along[0][other_bottom].min() > 40 + 2 * 40


def test_inlets_that_lie_close_together_count_as_one():
    model = vessels.vessel_model(tubes(gap=8), AFFINE)
    assert len(model["inlets"]) == 1 and (model["cell"] == model["inlets"][0]).all()


def test_inlets_further_apart_than_the_merge_distance_stay_separate():
    model = vessels.vessel_model(tubes(gap=14), AFFINE)
    assert vessels.MERGE_MM < 14 and len(model["inlets"]) == 2


def test_a_separate_large_piece_has_its_own_inlet_and_cannot_be_reached_from_another():
    model = vessels.vessel_model(tubes(bridge=False), AFFINE)
    assert len(model["inlets"]) == 2
    own = model["cell"] == model["inlets"][0]
    assert np.isinf(model["along"][0][~own]).all() and np.isfinite(model["along"][0][own]).all()


def test_a_small_loose_fragment_belongs_to_no_inlet():
    mask = tubes()
    mask[50:53, 5:8, 30:33] = 1
    model = vessels.vessel_model(mask, AFFINE)
    loose = model["cell"] < 0
    assert int(loose.sum()) == 27 and np.isinf(model["along"][:, loose]).all()


def test_lengths_follow_the_voxel_size():
    stretched = AFFINE.copy()
    stretched[2, 2] = 0.5
    model = vessels.vessel_model(tubes(), stretched)
    assert np.isclose(model["voxel_mm3"], 0.5)
    assert np.allclose(model["edges"], [[1, 0, 0], [0, 1, 0], [0, 0, 0.5]])
    own = model["cell"] == model["inlets"][0]
    assert model["along"][0][own].max() < 0.5 * 60 + 25


@pytest.mark.parametrize(
    ("mask", "affine", "message"),
    [
        (np.ones((4, 4, 4)), AFFINE, "outside the supported range"),
        (tubes()[0], AFFINE, "Invalid mask or affine"),
        (tubes(), AFFINE[:3], "Invalid mask or affine"),
        (tubes(), AFFINE * np.nan, "Invalid mask or affine"),
        (tubes(), np.diag([4.0, 4, 4, 1]), "Voxel size"),
    ],
)
def test_masks_that_cannot_be_a_vessel_model_are_refused(mask, affine, message):
    with pytest.raises(vessels.VesselError, match=message):
        vessels.vessel_model(mask, affine)


VIEW = {
    "primary_deg": 35.0,
    "secondary_deg": -20.0,
    "turn_deg": 0.0,
    "source_detector_mm": 1200.0,
    "source_isocenter_mm": 750.0,
    "detector_width_mm": 240.0,
    "detector_height_mm": 180.0,
    "width_px": 480,
    "height_px": 360,
}
ISOCENTER = (4.0, -3.0, 20.0)
POINTS = np.array([[4.0, -3, 20], [30, 12, -8], [-25, 40, 33], [0, 0, 0]])


def test_points_land_where_the_planners_camera_puts_them():
    column, row, depth = frames.project(POINTS, VIEW, ISOCENTER)
    numbers = {name: VIEW[name] for name in carm_geometry.VIEW_NUMBERS}
    camera = carm_geometry.camera(numbers, ISOCENTER)
    for point, found_column, found_row, found_depth in zip(POINTS, column, row, depth, strict=True):
        x_mm, y_mm, planner_depth = carm_geometry.project(camera, [float(c) for c in point])
        # The browser's detectorToPixel: x right, y down.
        assert np.isclose(found_column, (x_mm / 240 + 0.5) * 480)
        assert np.isclose(found_row, (0.5 - y_mm / 180) * 360)
        assert np.isclose(found_depth, planner_depth)
    assert np.allclose((column[0], row[0]), (240, 180))


def test_a_turned_frame_moves_a_point_on_image_right_toward_image_down():
    u, _, _ = views.view_frame(VIEW["primary_deg"], VIEW["secondary_deg"])
    point = np.array(ISOCENTER) + 20 * u
    column, row, _ = frames.project(point[None], VIEW, ISOCENTER)
    assert column[0] > 240 and np.isclose(row[0], 180)
    column, row, _ = frames.project(point[None], {**VIEW, "turn_deg": 90.0}, ISOCENTER)
    assert np.isclose(column[0], 240) and row[0] > 180


def test_the_length_image_holds_the_volume_that_was_projected():
    rng = np.random.default_rng(2)
    points = np.array(ISOCENTER) + rng.uniform(-20, 20, size=(400, 3))
    image = frames.thickness(points, np.ones(400), VIEW, ISOCENTER, voxel_mm3=0.25)
    # Length times the pixel's area at the isocenter is volume, to within perspective.
    pixel_mm = 240 / 480 * 750 / 1200
    assert np.isclose(image.sum() * pixel_mm**2, 400 * 0.25, rtol=0.06)
    assert image.shape == (360, 480) and (image >= 0).all()


def test_points_outside_the_field_or_behind_the_source_add_nothing():
    u, _, d = views.view_frame(VIEW["primary_deg"], VIEW["secondary_deg"])
    outside = np.array(ISOCENTER) + 400 * u
    behind = np.array(ISOCENTER) - 900 * d
    image = frames.thickness(np.stack([outside, behind]), np.ones(2), VIEW, ISOCENTER, 1.0)
    assert image.sum() == 0


def test_the_grid_keeps_the_total_and_centres_the_frame():
    level = np.zeros((96, 192), dtype=np.float32)
    level[40:56, 20:60] = 1
    grid = frames.to_grid(level)
    step = 192 / frames.GRID
    assert grid.shape == (frames.GRID, frames.GRID) and grid.dtype == np.float32
    assert np.isclose(grid.sum() * step**2, level.sum(), rtol=1e-6)
    # The shorter side is centred: a quarter of the grid is empty above and below.
    assert (grid[:32] == 0).all() and (grid[96:] == 0).all()
    rows, columns = np.nonzero(grid > 0.5)
    assert np.isclose(rows.mean() + 0.5, 32 + 48 / step, atol=0.5)
    assert np.isclose(columns.mean() + 0.5, 40 / step, atol=0.5)


def test_a_full_frame_fills_the_grid_whatever_its_size():
    for shape in ((64, 64), (128, 128), (300, 300), (640, 640)):
        assert np.allclose(frames.to_grid(np.ones(shape, dtype=np.float32)), 1, atol=1e-6)
    tall = frames.to_grid(np.ones((200, 100), dtype=np.float32))
    assert np.allclose(tall[:, 32:96], 1, atol=1e-6) and (tall[:, :32] == 0).all()


@pytest.fixture(scope="module")
def model():
    mask = np.zeros((96, 96, 96), dtype=np.uint8)
    mask[20:24, 46:50, 4:90] = 1
    mask[70:74, 46:50, 4:90] = 1
    mask[20:74, 46:50, 60:64] = 1
    for k in range(40):
        mask[24 + k : 27 + k, 46:49, 20 + k : 23 + k] = 1
    affine = np.array([[1.0, 0, 0, -48], [0, 1, 0, -48], [0, 0, 1, -40], [0, 0, 0, 1]])
    return vessels.vessel_model(mask, affine)


def test_a_filling_is_everything_one_inlets_voxels_or_those_and_what_lies_beyond(model):
    rng = np.random.default_rng(5)
    seen = set()
    cells = [model["cell"] == inlet for inlet in model["inlets"]]
    for _ in range(200):
        shown, weight, mode = frames.choose_filling(model, rng)
        seen.add(mode)
        assert shown.dtype == bool and weight.shape == shown.shape
        assert (weight > 0.39).all() and (weight <= 1).all()
        if mode == "cell":
            assert any((shown <= cell).all() for cell in cells)
    assert seen == set(frames.MODES)


def test_views_are_drawn_inside_the_declared_ranges_and_the_planners_limits():
    rng = np.random.default_rng(6)
    for _ in range(300):
        view = frames.choose_view(rng)
        assert abs(view["primary_deg"]) <= frames.PRIMARY_RANGE_DEG
        assert abs(view["secondary_deg"]) <= frames.SECONDARY_RANGE_DEG
        assert abs(view["turn_deg"]) <= frames.TURN_RANGE_DEG
        carm_geometry.validate_view({name: view[name] for name in carm_geometry.VIEW_NUMBERS})
        assert 240 <= min(view["width_px"], view["height_px"])
        assert max(view["width_px"], view["height_px"]) <= 640
        # Pixels are square.
        assert np.isclose(
            view["detector_width_mm"] / view["width_px"],
            view["detector_height_mm"] / view["height_px"],
        )


def test_a_drawn_frame_is_dark_where_the_vessels_project(model):
    rng = np.random.default_rng(7)
    view = {**VIEW, "primary_deg": 0.0, "secondary_deg": 0.0, "detector_height_mm": 240.0}
    view["height_px"] = 480
    shown = np.ones(len(model["points"]), dtype=bool)
    gray = frames.draw(model, shown, np.ones(len(shown)), view, rng)
    assert gray.dtype == np.uint8 and gray.shape == (480, 480)
    length = frames.thickness(
        model["points"], np.ones(len(shown)), view, model["points"].mean(axis=0), 1.0
    )
    # The isocenter is drawn up to 30 mm off, so compare loosely: the darkest
    # tenth of the frame holds far more vessel than the rest once aligned.
    assert gray.min() < 0.6 * np.median(gray)
    assert (length > 0).mean() > 0.01


def test_a_sample_is_reproducible_and_shaped_for_the_network(model):
    first = frames.sample(model, np.random.default_rng(11))
    again = frames.sample(model, np.random.default_rng(11))
    assert first is not None and first["view"] == again["view"]
    assert np.array_equal(first["input"], again["input"])
    assert first["input"].shape == (2, frames.GRID, frames.GRID)
    assert first["input"].dtype == np.uint8 and first["input"].max() > 128
    assert first["mode"] in frames.MODES
    other = frames.sample(model, np.random.default_rng(12))
    assert other["view"] != first["view"]


def test_a_model_with_nothing_to_show_gives_no_sample(model):
    empty = {**model, "points": model["points"][:100], "cell": model["cell"][:100]}
    empty["along"] = model["along"][:, :100]
    assert frames.sample(empty, np.random.default_rng(1)) is None
