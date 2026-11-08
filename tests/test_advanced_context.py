"""Tests for strict source-bound Phase3 territory context projection.

Envelope fixtures are genuine producer responses captured in
web/src/__fixtures__/territory-path-workflows.json for all three modes on one
case. Projection must expose only whitelisted finite scalars and preserve the
producer's result naming exactly.
"""

import copy
import json
import math
from pathlib import Path

import pytest

from planner.advanced_context import (
    CALCULATION_VERSION,
    project_territory_context,
    render_territory_context,
)

FIXTURES = (
    Path(__file__).resolve().parent.parent
    / "web"
    / "src"
    / "__fixtures__"
    / "territory-path-workflows.json"
)
IDENTITY_FIELDS = ("case_id", "image_sha256", "artifact_version", "reference_revision")


def load_envelopes():
    with FIXTURES.open() as handle:
        return json.load(handle)


@pytest.fixture(scope="module")
def envelopes():
    return load_envelopes()


def identity_of(mode, env):
    env = env[mode]
    return {field: env[field] for field in IDENTITY_FIELDS}


def single_mode_context(env, mode):
    """Project exactly one mode, as the parent will for a per-mode brief."""
    return project_territory_context(identity_of(mode, env), {mode: env[mode]})["modes"][mode]


# ---------------------------------------------------------------------------
# Current-data tracer (real fixture for one mode first)
# ---------------------------------------------------------------------------


def test_real_tavr_fixture_projects_whitelisted_scalars(envelopes):
    context = project_territory_context(identity_of("tavr", envelopes), envelopes)
    projection = context["modes"]["tavr"]
    assert projection["mode"] == "tavr"
    assert projection["status"] == "current"
    assert projection["result_id"] == envelopes["tavr"]["current"]["result_id"]
    assert context["calculation_version"] == CALCULATION_VERSION
    assert projection["annotation_source"] == "operator_traced"
    assert projection["input_sha256"] == envelopes["tavr"]["current"]["input_sha256"]
    assert projection["workflow_revision"] == envelopes["tavr"]["workflow_revision"]
    for field in IDENTITY_FIELDS:
        assert context[field] == envelopes["tavr"][field]
    metrics = projection["metrics"]
    assert set(metrics) == {
        "area_derived_diameter_mm",
        "area_mm2",
        "left_coronary_height_mm",
        "max_diameter_mm",
        "min_diameter_mm",
        "perimeter_derived_diameter_mm",
        "perimeter_mm",
        "right_coronary_height_mm",
    }
    assert metrics["area_mm2"] == 6.0
    assert metrics["right_coronary_height_mm"] == -2.0


def test_projection_never_contains_raw_inputs_arrays_or_contours(envelopes):
    raw = load_envelopes()
    blob = json.dumps(project_territory_context(identity_of("tavr", raw), raw))
    for forbidden in ("annulus", "contour", "inputs", "profiles", "left_ostium"):
        assert forbidden not in blob
    assert "15.0" not in blob  # left_ostium z coordinate, not a projected metric value


def test_all_three_real_modes_project(envelopes):
    for mode in ("coronary_pci", "aortic_peripheral"):
        projection = single_mode_context(envelopes, mode)
        assert projection["status"] == "current"
        assert projection["mode"] == mode
        assert all(
            isinstance(value, (int, float)) and math.isfinite(value)
            for value in projection["metrics"].values()
            if isinstance(value, (int, float))
        )
        assert "profiles" not in projection["metrics"]


def test_coronary_optional_bifurcation_angle_none_is_distinct_from_zero(envelopes):
    projection = single_mode_context(envelopes, "coronary_pci")
    assert projection["metrics"]["bifurcation_angle_deg"] is None
    assert projection["metrics"]["diameter_narrowing_pct"] > 0


def test_aortic_access_subkeys_absent_when_producer_reports_none(envelopes):
    projection = single_mode_context(envelopes, "aortic_peripheral")
    assert projection["left_access"] is None
    assert projection["right_access"] is None


def test_aortic_access_scalar_projection_when_producer_supplies_routes(envelopes):
    raw = copy.deepcopy(load_envelopes())
    result = raw["aortic_peripheral"]["current"]["result"]
    access = {
        "sampled_minimum_diameter_mm": 0.8,
        "minimum_station": 2,
        "length_mm": 12.5,
    }
    result["left_access"] = copy.deepcopy(access)
    result["right_access"] = copy.deepcopy(access)
    projection = single_mode_context(raw, "aortic_peripheral")
    assert projection["left_access"] == {
        "length_mm": 12.5,
        "minimum_station": 2,
        "sampled_minimum_diameter_mm": 0.8,
    }
    assert projection["right_access"]["minimum_station"] == 2


# ---------------------------------------------------------------------------
# Identity and dependency binding
# ---------------------------------------------------------------------------


def test_identity_must_be_exactly_four_fields(envelopes):
    for mutation in (
        lambda ident: ident.pop("case_id"),
        lambda ident: ident.update(extra_field="x"),
        lambda ident: ident.update(case_id=17),
        lambda ident: ident.update(image_sha256="deadbeef"),
        lambda ident: ident.update(reference_revision="z" * 64),
        lambda ident: ident.update(artifact_version=None),
    ):
        identity = identity_of("tavr", envelopes)
        mutation(identity)
        with pytest.raises(ValueError):
            project_territory_context(identity, load_envelopes())


def test_identity_must_match_every_envelope(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["aortic_peripheral"]["case_id"] = "other-case"
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


def test_envelope_mode_must_match_its_key(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["mode"] = "coronary_pci"
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


def test_current_dependencies_must_match_identity(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"]["dependencies"]["image_sha256"] = "9" * 64
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


def test_revision_must_be_nonnegative_integer(envelopes):
    for bad in (-1, "1", 1.0, True, None):
        raw = copy.deepcopy(load_envelopes())
        raw["tavr"]["workflow_revision"] = bad
        with pytest.raises(ValueError):
            project_territory_context(identity_of("tavr", raw), raw)


def test_unknown_mode_rejected():
    raw = load_envelopes()
    identity = identity_of("tavr", raw)
    with pytest.raises(ValueError):
        project_territory_context(identity, {"unknown_mode": {**raw["tavr"], "mode": "x"}})
    with pytest.raises(ValueError):
        project_territory_context(identity, {})


def test_malformed_envelope_shape_rejected(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"].pop("workflow_revision")
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["surprise"] = True
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


# ---------------------------------------------------------------------------
# Status handling: explicit absence, never old numbers
# ---------------------------------------------------------------------------


ABSENCE_CURRENT = {
    "not_computed": {"status": "not_computed"},
    "stale": {"status": "stale", "result_id": "abc123", "inputs": None, "result": None},
}


@pytest.mark.parametrize("status", ["not_computed", "stale"])
def test_non_current_status_projects_explicit_absence(envelopes, status):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"] = copy.deepcopy(ABSENCE_CURRENT[status])
    projection = single_mode_context(raw, "tavr")
    assert projection["status"] == status
    assert "metrics" not in projection
    assert "result" not in projection
    assert "inputs" not in projection
    assert "input_sha256" not in projection
    blob = json.dumps(projection)
    assert "area_mm2" not in blob and "diameter" not in blob


@pytest.mark.parametrize(
    "current",
    [
        {"status": "not_computed", "result_id": "abc123"},
        {"status": "not_computed", "result": None},
        {"status": "not_computed", "inputs": None},
        {"status": "stale", "result_id": "abc123"},
        {"status": "stale", "result_id": "abc123", "inputs": None, "result": {}},
        {"status": "stale", "result_id": "abc123", "inputs": {}, "result": None},
        {"status": "stale", "inputs": None, "result": None},
        {"status": "current"},
        {"status": "current", "result_id": None, "result": None},
        {"status": "current", "surprise": True},
        {"status": "future_status", "result": None},
    ],
)
def test_current_envelopes_must_match_actual_producer_shape(envelopes, current):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"] = current
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), {"tavr": raw["tavr"]})


def test_null_current_fails_closed(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"] = None
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), {"tavr": raw["tavr"]})


def test_malformed_input_sha256_rejected(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"]["input_sha256"] = "not-a-digest"
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


# ---------------------------------------------------------------------------
# Whitelist and scalar validation
# ---------------------------------------------------------------------------


def test_unknown_result_key_rejected_not_silently_dropped(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"]["result"]["private_confidence"] = 0.9
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


@pytest.mark.parametrize("bad", [[1, 2], {"a": 1}, float("nan"), float("inf"), "5", True])
def test_nonfinite_or_non_scalar_result_values_rejected(envelopes, bad):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"]["result"]["area_mm2"] = bad
    with pytest.raises(ValueError):
        project_territory_context(identity_of("tavr", raw), raw)


@pytest.mark.parametrize("bad", [2.0, "4", True, None, -1, 128])
def test_station_outputs_must_be_integer_within_range(envelopes, bad):
    raw = copy.deepcopy(load_envelopes())
    raw["coronary_pci"]["current"]["result"]["minimum_station"] = bad
    with pytest.raises(ValueError):
        project_territory_context(identity_of("coronary_pci", raw), raw)


def test_annotation_source_and_calculation_version_are_bounded(envelopes):
    for mutation in (
        {"annotation_source": "fabricated"},
        {"calculation_version": "other-v9"},
        {"annotation_source": None},
    ):
        raw = copy.deepcopy(load_envelopes())
        raw["tavr"]["current"]["result"].update(mutation)
        with pytest.raises(ValueError):
            project_territory_context(identity_of("tavr", raw), raw)


def test_bounded_enum_string_result_is_whitelisted_exactly(envelopes):
    projection = single_mode_context(envelopes, "coronary_pci")
    assert projection["metrics"]["diameter_basis"] == "area_equivalent"
    raw = copy.deepcopy(load_envelopes())
    raw["coronary_pci"]["current"]["result"]["diameter_basis"] = "operator_guess"
    with pytest.raises(ValueError):
        project_territory_context(identity_of("coronary_pci", raw), raw)


def test_projection_output_contains_no_lists_anywhere(envelopes):
    context = project_territory_context(identity_of("aortic_peripheral", envelopes), envelopes)

    def check(value):
        if isinstance(value, list):
            return False
        if isinstance(value, dict):
            return all(check(item) for item in value.values())
        return True

    assert check(context)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def test_render_current_context_lists_only_whitelisted_lines(envelopes):
    context = project_territory_context(identity_of("tavr", envelopes), envelopes)
    text = render_territory_context(context)
    assert "Status: current" in text
    assert "Area (mm2): 6" in text
    assert "Right coronary height (mm): -2" in text
    assert "Annulus" not in text and "contour" not in text.lower()


def test_render_absence_states_no_numbers(envelopes):
    raw = copy.deepcopy(load_envelopes())
    raw["tavr"]["current"] = copy.deepcopy(ABSENCE_CURRENT["not_computed"])
    context = project_territory_context(identity_of("tavr", raw), {"tavr": raw["tavr"]})
    text = render_territory_context(context)
    assert "not computed" in text.lower()
    assert not [line for line in text.splitlines() if "(mm" in line or "(%" in line]


def test_render_rejects_tampered_context(envelopes):
    context = project_territory_context(identity_of("tavr", envelopes), envelopes)
    tampered = copy.deepcopy(context)
    tampered["modes"]["tavr"]["metrics"]["mystery_metric"] = 1.0
    with pytest.raises(ValueError):
        render_territory_context(tampered)
    tampered = copy.deepcopy(context)
    tampered["modes"]["tavr"]["metrics"] = {"area_mm2": [1.0]}
    with pytest.raises(ValueError):
        render_territory_context(tampered)
    tampered = copy.deepcopy(context)
    tampered["extra"] = 1
    with pytest.raises(ValueError):
        render_territory_context(tampered)
    with pytest.raises(ValueError):
        render_territory_context({"case_id": "x"})


def test_render_is_deterministic(envelopes):
    context = project_territory_context(identity_of("aortic_peripheral", envelopes), envelopes)
    assert render_territory_context(context) == render_territory_context(context)


# ---------------------------------------------------------------------------
# Completeness and bounded-None guards (actual producer envelope hardening)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("mode", "metric"),
    [
        ("tavr", "area_mm2"),
        ("tavr", "right_coronary_height_mm"),
        ("coronary_pci", "minimum_station"),
        ("coronary_pci", "diameter_basis"),
        ("aortic_peripheral", "maximum_station"),
        ("aortic_peripheral", "alpha_deg"),
        ("aortic_peripheral", "minimum_station"),
    ],
)
def test_missing_required_metric_fails_closed(envelopes, mode, metric):
    raw = copy.deepcopy(load_envelopes())
    raw[mode]["current"]["result"].pop(metric)
    with pytest.raises(ValueError):
        project_territory_context(identity_of(mode, raw), {mode: raw[mode]})


@pytest.mark.parametrize(
    ("mode", "metric"),
    [
        ("tavr", "area_mm2"),
        ("tavr", "left_coronary_height_mm"),
        ("coronary_pci", "diameter_narrowing_pct"),
        ("aortic_peripheral", "alpha_deg"),
        ("aortic_peripheral", "neck_length_mm"),
    ],
)
def test_none_on_non_optional_metric_fails_closed(envelopes, mode, metric):
    raw = copy.deepcopy(load_envelopes())
    raw[mode]["current"]["result"][metric] = None
    with pytest.raises(ValueError):
        project_territory_context(identity_of(mode, raw), {mode: raw[mode]})


@pytest.mark.parametrize(
    ("mode", "metric"),
    [
        ("coronary_pci", "bifurcation_angle_deg"),
        ("aortic_peripheral", "calcification_burden_pct"),
        ("aortic_peripheral", "thrombus_burden_pct"),
    ],
)
def test_class_burden_and_bifurcation_none_still_accepted(envelopes, mode, metric):
    raw = copy.deepcopy(load_envelopes())
    raw[mode]["current"]["result"][metric] = None
    projection = single_mode_context(raw, mode)
    assert projection["metrics"][metric] is None


@pytest.mark.parametrize("side", ["left_access", "right_access"])
def test_access_result_missing_required_field_fails_closed(envelopes, side):
    raw = copy.deepcopy(load_envelopes())
    access = {
        "sampled_minimum_diameter_mm": 0.8,
        "minimum_station": 2,
        "length_mm": 12.5,
    }
    access.pop(min(access))
    raw["aortic_peripheral"]["current"]["result"][side] = access
    with pytest.raises(ValueError):
        project_territory_context(identity_of("aortic_peripheral", raw), raw)


# ---------------------------------------------------------------------------
# Renderer metadata binding guards
# ---------------------------------------------------------------------------


def test_render_rejects_tampered_envelope_metadata(envelopes):
    context = project_territory_context(identity_of("tavr", envelopes), envelopes)

    def render_with_mutation(mutate):
        tampered = copy.deepcopy(context)
        mutate(tampered)
        render_territory_context(tampered)

    for mutate in (
        lambda ctx: ctx.update(image_sha256="deadbeef"),
        lambda ctx: ctx.update(case_id=""),
        lambda ctx: ctx.update(artifact_version=None),
        lambda ctx: ctx.update(reference_revision="z" * 64),
        lambda ctx: ctx.update(calculation_version="other-v9"),
        lambda ctx: ctx["modes"]["tavr"].update(workflow_revision=-1),
        lambda ctx: ctx["modes"]["tavr"].update(workflow_revision="3"),
        lambda ctx: ctx["modes"]["tavr"].update(result_id="../escape"),
        lambda ctx: ctx["modes"]["tavr"].update(input_sha256="not-a-digest"),
        lambda ctx: ctx["modes"]["tavr"].update(annotation_source="fabricated"),
        lambda ctx: ctx["modes"]["tavr"].update(status="pending"),
    ):
        with pytest.raises(ValueError):
            render_with_mutation(mutate)


@pytest.mark.parametrize(
    "mode,key",
    [
        ("tavr", "minimum_station"),
        ("tavr", "maximum_station"),
        ("tavr", "diameter_basis"),
        ("coronary_pci", "maximum_station"),
        ("aortic_peripheral", "diameter_basis"),
    ],
)
def test_mode_specific_station_and_enum_keys_do_not_cross_modes(mode, key):
    envelopes = load_envelopes()
    context = project_territory_context(identity_of(mode, envelopes), envelopes)
    value = (
        envelopes["coronary_pci"]["current"]["result"]["diameter_basis"]
        if key == "diameter_basis"
        else 0
    )
    envelopes[mode]["current"]["result"][key] = value
    with pytest.raises(ValueError, match="unwhitelisted"):
        project_territory_context(identity_of(mode, envelopes), envelopes)
    context["modes"][mode]["metrics"][key] = value
    with pytest.raises(ValueError, match="unwhitelisted"):
        render_territory_context(context)
