"""Synthetic tests for the aneurysm worksheet domain model and evidence validator."""

import pytest
from pydantic import ValidationError

from planner.planning import AneurysmPlan, build_plan_evidence

ROLES = ("sac_height", "sac_width", "neck_width", "proximal_parent", "distal_parent")
OPTIONS = (
    "observation",
    "coiling",
    "assisted_coiling",
    "flow_diversion",
    "intrasaccular",
    "clipping",
)


# --- Defaults -------------------------------------------------------------


def test_defaults_match_contract():
    plan = AneurysmPlan()
    assert plan.lesion_label == "Target aneurysm"
    assert plan.location_note == ""
    assert plan.focus_ras is None
    assert plan.rupture_status == "unknown"
    assert plan.clinical_context == ""
    assert plan.measurement_links == {}
    assert plan.options == []
    assert plan.questions == ""


def test_extra_fields_forbidden():
    with pytest.raises(ValidationError):
        AneurysmPlan(lesion_side="left")


# --- lesion_label ---------------------------------------------------------


def test_lesion_label_strips_but_rejects_blank():
    assert AneurysmPlan(lesion_label="  Tip  ").lesion_label == "Tip"
    with pytest.raises(ValidationError):
        AneurysmPlan(lesion_label="   ")


def test_lesion_label_length_bounds():
    with pytest.raises(ValidationError):
        AneurysmPlan(lesion_label="x" * 81)
    assert len(AneurysmPlan(lesion_label="x" * 80).lesion_label) == 80


# --- location_note / clinical_context / questions -------------------------


@pytest.mark.parametrize(
    "field,limit", [("location_note", 240), ("clinical_context", 2000), ("questions", 2000)]
)
def test_text_field_limits(field, limit):
    assert getattr(AneurysmPlan(**{field: "x" * limit}), field) == "x" * limit
    with pytest.raises(ValidationError):
        AneurysmPlan(**{field: "x" * (limit + 1)})


# --- focus_ras ------------------------------------------------------------


def test_focus_ras_accepts_finite_triple():
    assert AneurysmPlan(focus_ras=[1.0, -2.0, 3.5]).focus_ras == [1.0, -2.0, 3.5]


def test_focus_ras_rejects_non_finite_and_wrong_length():
    for bad in ([1.0, float("nan"), 2.0], [1.0, float("inf"), 2.0], [1.0, 2.0], [1.0] * 4):
        with pytest.raises(ValidationError):
            AneurysmPlan(focus_ras=bad)


# --- enums ----------------------------------------------------------------


def test_rupture_status_enum():
    for value in ("unknown", "unruptured", "ruptured"):
        assert AneurysmPlan(rupture_status=value).rupture_status == value
    with pytest.raises(ValidationError):
        AneurysmPlan(rupture_status="likely")


def test_options_whitelist_duplicates_and_cap():
    assert AneurysmPlan(options=["coiling", "clipping"]).options == ["coiling", "clipping"]
    with pytest.raises(ValidationError):
        AneurysmPlan(options=["stenting"])
    with pytest.raises(ValidationError):
        AneurysmPlan(options=["coiling", "coiling"])
    with pytest.raises(ValidationError):
        AneurysmPlan(options=list(OPTIONS) + ["observation"])


def test_options_all_six_allowed():
    assert AneurysmPlan(options=list(OPTIONS)).options == list(OPTIONS)


# --- measurement_links ----------------------------------------------------


def test_measurement_links_role_whitelist_and_id_format():
    assert AneurysmPlan(measurement_links={"neck_width": "m1"}).measurement_links == {
        "neck_width": "m1"
    }
    with pytest.raises(ValidationError):
        AneurysmPlan(measurement_links={"sac_volume": "m1"})
    with pytest.raises(ValidationError):
        AneurysmPlan(measurement_links={"neck_width": ""})
    with pytest.raises(ValidationError):
        AneurysmPlan(measurement_links={"neck_width": "m" * 81})
    assert len(AneurysmPlan(measurement_links={"neck_width": "m" * 80}).measurement_links) == 1


# --- build_plan_evidence --------------------------------------------------


def make_measurements():
    return [
        {"measurement_id": "m1", "distance_mm": 4.5},
        {"measurement_id": "m2", "distance_mm": 3.2},
        {"measurement_id": "m3", "distance_mm": 2.0},
    ]


def test_evidence_accepts_actual_workspace_measurement_shape():
    plan = AneurysmPlan(measurement_links={"neck_width": "real-shape"})
    evidence = build_plan_evidence(
        plan, [{"measurement_id": "real-shape", "distance_mm": 5.0}], "mm"
    )
    assert evidence["linked_measurements"][0]["distance_mm"] == 5.0


def test_evidence_links_in_role_order():
    plan = AneurysmPlan(
        measurement_links={"neck_width": "m3", "sac_height": "m1", "sac_width": "m2"}
    )
    evidence = build_plan_evidence(plan, make_measurements(), "mm")
    assert [item["role"] for item in evidence["linked_measurements"]] == [
        "sac_height",
        "sac_width",
        "neck_width",
    ]
    item = evidence["linked_measurements"][0]
    assert item == {
        "role": "sac_height",
        "measurement_id": "m1",
        "distance_mm": 4.5,
        "method": "manual_point_pair",
        "validated_morphometry": False,
    }
    assert evidence["missing_measurements"] == ["proximal_parent", "distal_parent"]
    assert evidence["interpretation"] == (
        "User-assigned roles on manual point pairs, not validated morphometry or device sizing."
    )


def test_evidence_empty_plan_is_all_missing():
    evidence = build_plan_evidence(AneurysmPlan(), make_measurements(), "mm")
    assert evidence["linked_measurements"] == []
    assert evidence["missing_measurements"] == list(ROLES)


def test_evidence_rejects_unknown_measurement_id():
    plan = AneurysmPlan(measurement_links={"neck_width": "nope"})
    with pytest.raises(ValueError, match="not found"):
        build_plan_evidence(plan, make_measurements(), "mm")


def test_evidence_rejects_duplicate_measurement_across_roles():
    plan = AneurysmPlan(measurement_links={"sac_height": "m1", "sac_width": "m1"})
    with pytest.raises(ValueError, match="multiple roles"):
        build_plan_evidence(plan, make_measurements(), "mm")


def test_empty_plan_with_unknown_units_can_store_a_target_without_mm_evidence():
    evidence = build_plan_evidence(AneurysmPlan(focus_ras=[-12, 8, 32]), [], "unknown")
    assert evidence["linked_measurements"] == []
    assert evidence["missing_measurements"] == list(ROLES)


def test_evidence_rejects_links_when_units_not_mm():
    plan = AneurysmPlan(measurement_links={"neck_width": "m1"})
    for units in ("", "voxel", "unknown", "ras"):
        with pytest.raises(ValueError, match="millimeter"):
            build_plan_evidence(plan, make_measurements(), units)
