"""Typed inputs and deterministic composition for the territory workspace."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt

from planner.territory_geometry import (
    MAX_CONTOUR_POINTS,
    dot,
    point3,
    section_metrics,
    subtract,
    unit,
)

CALCULATION_VERSION = "territory-traced-geometry-v1"
Mode = Literal["tavr", "coronary_pci", "aortic_peripheral"]
Coordinate = Annotated[StrictFloat, Field(ge=-1e6, le=1e6, allow_inf_nan=False)]
Point = tuple[Coordinate, Coordinate, Coordinate]
Station = Annotated[StrictInt, Field(ge=0, le=127)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Section(StrictModel):
    origin: Point
    normal: Point
    contour: Annotated[list[Point], Field(min_length=3, max_length=MAX_CONTOUR_POINTS)]


class Profile(StrictModel):
    station: Station
    section: Section
    outer_wall: Section | None = None
    thrombus: Annotated[list[Section], Field(max_length=8)] | None = None
    calcification: Annotated[list[Section], Field(max_length=8)] | None = None


Path = Annotated[list[Point], Field(min_length=2, max_length=128)]
Profiles = Annotated[list[Profile], Field(min_length=1, max_length=32)]


class TAVRInputs(StrictModel):
    annulus: Section
    left_ostium: Point
    right_ostium: Point


class Bifurcation(StrictModel):
    carina: Point
    daughter_a: Point
    daughter_b: Point


class CoronaryInputs(StrictModel):
    path: Path
    lesion_start: Station
    lesion_end: Station
    proximal_reference: Station
    distal_reference: Station
    profiles: Profiles
    bifurcation: Bifurcation | None = None


class AccessInputs(StrictModel):
    path: Path
    profiles: Profiles


class AorticInputs(StrictModel):
    path: Path
    suprarenal_index: Station
    neck_start: Station
    neck_end: Station
    sac_index: Station
    profiles: Profiles
    left_access: AccessInputs | None = None
    right_access: AccessInputs | None = None


MODELS = {"tavr": TAVRInputs, "coronary_pci": CoronaryInputs, "aortic_peripheral": AorticInputs}


def validate_inputs(mode, data):
    if mode not in MODELS:
        raise ValueError("Unknown territory workflow")
    return MODELS[mode].model_validate(data).model_dump(mode="json")


def input_points(inputs):
    """Yield annotation positions, never direction vectors or scalar indices."""
    if "annulus" in inputs:
        sections = [inputs["annulus"]]
        yield inputs["left_ostium"]
        yield inputs["right_ostium"]
    else:
        sections = []
        paths = [inputs] + [inputs[k] for k in ("left_access", "right_access") if inputs.get(k)]
        for entry in paths:
            yield from entry["path"]
            for profile in entry["profiles"]:
                sections.append(profile["section"])
                if profile.get("outer_wall"):
                    sections.append(profile["outer_wall"])
                for key in ("thrombus", "calcification"):
                    sections.extend(profile.get(key) or [])
        if inputs.get("bifurcation"):
            yield from inputs["bifurcation"].values()
    for section in sections:
        yield section["origin"]
        yield from section["contour"]


def compute_tavr(inputs):
    annulus = inputs["annulus"]
    metrics = section_metrics(**annulus)
    direction = unit(annulus["normal"])
    origin = point3(annulus["origin"])
    return {
        **metrics,
        **{
            name + "_coronary_height_mm": dot(
                subtract(point3(inputs[name + "_ostium"]), origin), direction
            )
            for name in ("left", "right")
        },
    }


def compute_workflow(mode, inputs):
    # The other composition module is imported only when needed.
    if mode == "tavr":
        result = compute_tavr(inputs)
    else:
        from planner.territory_profiles import compute_aortic, compute_coronary

        result = (compute_coronary if mode == "coronary_pci" else compute_aortic)(inputs)
    return result | {
        "calculation_version": CALCULATION_VERSION,
        "annotation_source": "operator_traced",
    }
