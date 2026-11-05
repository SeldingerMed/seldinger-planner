"""Aneurysm worksheet domain model and evidence validation.

Owns only domain validation and evidence derivation per
docs/plans/aneurysm-worksheet.md. No clinical classification, risk scoring
or device sizing inference.
"""

import math
from typing import Annotated, Literal

from pydantic import BaseModel, Field, field_validator

RuptureStatus = Literal["unknown", "unruptured", "ruptured"]
PlanRole = Literal["sac_height", "sac_width", "neck_width", "proximal_parent", "distal_parent"]
PlanOption = Literal[
    "observation",
    "coiling",
    "assisted_coiling",
    "flow_diversion",
    "intrasaccular",
    "clipping",
]

NonBlankLabel = Annotated[str, Field(min_length=1, max_length=80)]
MeasurementId = Annotated[str, Field(min_length=1, max_length=80)]

EVIDENCE_INTERPRETATION = (
    "User-assigned roles on manual point pairs, not validated morphometry or device sizing."
)
ROLE_ORDER: tuple[PlanRole, ...] = (
    "sac_height",
    "sac_width",
    "neck_width",
    "proximal_parent",
    "distal_parent",
)


class AneurysmPlan(BaseModel):
    """Operator-entered aneurysm planning worksheet. Discussion candidates, not endorsements."""

    model_config = {"extra": "forbid"}

    lesion_label: str = Field(default="Target aneurysm", min_length=1, max_length=80)
    location_note: str = Field(default="", max_length=240)
    focus_ras: list[float] | None = None
    rupture_status: RuptureStatus = "unknown"
    clinical_context: str = Field(default="", max_length=2000)
    measurement_links: dict[PlanRole, MeasurementId] = Field(default_factory=dict)
    options: list[PlanOption] = Field(default_factory=list, max_length=6)
    questions: str = Field(default="", max_length=2000)

    @field_validator("lesion_label")
    @classmethod
    def _strip_nonblank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("lesion_label must be nonblank")
        return stripped

    @field_validator("options")
    @classmethod
    def _unique_options(cls, value):
        if len(value) != len(set(value)):
            raise ValueError("options must be unique")
        return value

    @field_validator("focus_ras")
    @classmethod
    def _finite_triple(cls, value):
        if value is None:
            return None
        if len(value) != 3 or any(not math.isfinite(component) for component in value):
            raise ValueError("focus_ras must be a finite 3-vector")
        return value


def _measurement_index(measurements: list[dict]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for measurement in measurements:
        if isinstance(measurement, dict) and "measurement_id" in measurement:
            index[measurement["measurement_id"]] = measurement
    return index


def build_plan_evidence(plan: AneurysmPlan, measurements: list[dict], spatial_units: str) -> dict:
    """Derive evidence for user-assigned measurement roles on manual point pairs."""
    if plan.measurement_links and spatial_units != "mm":
        raise ValueError("measurement links require millimeter spatial units")
    index = _measurement_index(measurements)
    used_ids: set[str] = set()
    linked: list[dict] = []
    for role in ROLE_ORDER:
        measurement_id = plan.measurement_links.get(role)
        if measurement_id is None:
            continue
        if measurement_id in used_ids:
            raise ValueError(f"measurement {measurement_id!r} used for multiple roles")
        measurement = index.get(measurement_id)
        if measurement is None:
            raise ValueError(f"linked measurement {measurement_id!r} not found in case")
        used_ids.add(measurement_id)
        linked.append(
            {
                "role": role,
                "measurement_id": measurement_id,
                "distance_mm": measurement.get("distance_mm"),
                "method": "manual_point_pair",
                "validated_morphometry": False,
            }
        )
    missing = [role for role in ROLE_ORDER if role not in plan.measurement_links]
    return {
        "linked_measurements": linked,
        "missing_measurements": missing,
        "interpretation": EVIDENCE_INTERPRETATION,
    }
