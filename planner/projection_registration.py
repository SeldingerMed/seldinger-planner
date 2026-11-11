"""Immutable, operator-confirmed 2D-to-3D registration proposals.

One record binds a rigid volume-to-C-arm matrix to the case source, the
accepted vessel mask it was computed from, and one admitted angiographic
frame. The matrix is a browser proposal that an operator reviewed on the
overlay and confirmed. It is not a validated registration: nothing here
measures its accuracy, and the scores stored with it are the browser's own
report of how well two automatically extracted line sets agree.

Pixels never reach this module. A record names its frame by SHA-256 only.
"""

import json
import math
import secrets
from contextlib import closing
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictFloat, StrictInt, field_validator

from planner.carm_geometry import CONVENTION, camera
from planner.frame_source import MAX_FRAME_INDEX
from planner.physics_contract import encoded
from planner.projection_plan import (
    DetectorSide,
    PlanConflict,
    PrimaryAngle,
    SecondaryAngle,
    SourceDetector,
    SourceIsocenter,
)
from planner.reformat_scene import Finite, digest, validate_rigid
from planner.territory_workflows import Point, StrictModel
from planner.workspace import _connect

VERSION = "step-c1-projection-registration-v1"
METHOD = "centerline_distance_compass_v1"
DETECTOR_SCALE_RANGE = (0.7, 1.45)
SQUARE_PIXEL_TOLERANCE = 0.02
_SHA = r"^[a-f0-9]{64}$"
Fraction = Annotated[StrictFloat, Field(ge=0, le=1, allow_inf_nan=False)]


class RegistrationView(StrictModel):
    primary_deg: PrimaryAngle
    secondary_deg: SecondaryAngle
    source_detector_mm: SourceDetector
    source_isocenter_mm: SourceIsocenter
    detector_width_mm: DetectorSide
    detector_height_mm: DetectorSide


class Score(StrictModel):
    mean_distance_mm: Annotated[StrictFloat, Field(ge=0, le=1000, allow_inf_nan=False)]
    matched_fraction: Fraction
    in_field_fraction: Fraction
    uncovered_fraction: Fraction


class RegistrationInputs(StrictModel):
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def require_actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit operator confirmation required")
        return value

    frame_source_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    frame_manifest_revision: str = Field(pattern=_SHA)
    plane: Literal["single", "a", "b"]
    frame_index: StrictInt = Field(ge=0, le=MAX_FRAME_INDEX)
    frame_sha256: str = Field(pattern=_SHA)
    mask_candidate_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    mask_sha256: str = Field(pattern=_SHA)
    geometry_source: Literal["frame_manifest", "operator_entered"]
    view: RegistrationView
    fit_detector_scale: StrictBool
    detector_scale: Annotated[
        StrictFloat,
        Field(ge=DETECTOR_SCALE_RANGE[0], le=DETECTOR_SCALE_RANGE[1], allow_inf_nan=False),
    ]
    isocenter: Point
    volume_to_carm_ras: list[list[Finite]] = Field(min_length=4, max_length=4)
    method: Literal["centerline_distance_compass_v1"]
    polarity: Literal["dark", "bright"]
    sensitivity: Fraction
    reported_score: Score
    reported_start_score: Score


class RegistrationRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    registration_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: RegistrationInputs


def validate_registration(inputs):
    value = RegistrationInputs.model_validate(inputs).model_dump(mode="json")
    validate_rigid(value["volume_to_carm_ras"])
    camera(value["view"], value["isocenter"])
    if value["fit_detector_scale"]:
        # A fitted scale means the entered field size was not trusted.
        if value["geometry_source"] != "operator_entered":
            raise ValueError("A fitted detector scale requires operator-entered geometry")
    elif value["detector_scale"] != 1:
        raise ValueError("Detector scale without a fit must be one")
    return value


def check_frame(inputs, plane):
    """Tie confirmed inputs to the admitted plane record they name."""
    view = inputs["view"]
    pitch = view["detector_width_mm"] / plane["columns"]
    if abs(view["detector_height_mm"] / plane["rows"] / pitch - 1) > SQUARE_PIXEL_TOLERANCE:
        raise ValueError("Detector pixels must be square")
    if inputs["geometry_source"] == "frame_manifest":
        geometry = plane["geometry"]
        if geometry is None or any(
            not math.isclose(view[key], geometry[key], rel_tol=1e-9, abs_tol=1e-9)
            for key in geometry
        ):
            raise ValueError("View contradicts the admitted acquisition geometry")


def summarize(inputs):
    """Server-derived scalars. The browser's scores are passed through, labelled."""
    matrix, iso = inputs["volume_to_carm_ras"], inputs["isocenter"]
    trace = matrix[0][0] + matrix[1][1] + matrix[2][2]
    moved = [sum(matrix[i][j] * iso[j] for j in range(3)) + matrix[i][3] for i in range(3)]
    return {
        "version": VERSION,
        "convention": CONVENTION,
        "method": METHOD,
        "status": "operator_confirmed_proposal",
        "validated": False,
        "geometry_source": inputs["geometry_source"],
        "rotation_deg": round(math.degrees(math.acos(max(-1.0, min(1.0, (trace - 1) / 2)))), 3),
        "isocenter_shift_mm": round(math.dist(moved, iso), 3),
        "score_source": "browser_reported_not_recomputed",
        "reported_score": inputs["reported_score"],
        "reported_start_score": inputs["reported_start_score"],
    }


class RegistrationLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS projection_registrations (registration_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(case_id),registration_revision INTEGER NOT NULL,dependencies TEXT NOT NULL,inputs TEXT NOT NULL,input_sha256 TEXT NOT NULL,result TEXT NOT NULL, UNIQUE(case_id,registration_revision))"
            )

    @staticmethod
    def _latest(conn, case_id):
        return conn.execute(
            "SELECT * FROM projection_registrations WHERE case_id=? "
            "ORDER BY registration_revision DESC LIMIT 1",
            (case_id,),
        ).fetchone()

    @staticmethod
    def _case_matches(conn, identity):
        row = conn.execute("SELECT * FROM cases WHERE case_id=?", (identity["case_id"],)).fetchone()
        if (
            row is None
            or row["image_sha256"] != identity["image_sha256"]
            or str(row["artifact_version"]) != identity["artifact_version"]
            or row["spatial_units"] != "mm"
        ):
            raise PlanConflict("Case changed")

    def current(self, identity):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            self._case_matches(conn, identity)
            row = self._latest(conn, identity["case_id"])
        if row is None:
            return 0, {"status": "not_confirmed"}
        revision = row["registration_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid registration revision")
        deps = {**identity, "version": VERSION}
        if json.loads(row["dependencies"]) != deps:
            return revision, {
                "status": "stale",
                "registration_id": row["registration_id"],
                "inputs": None,
                "result": None,
            }
        inputs = validate_registration(json.loads(row["inputs"]))
        result = json.loads(row["result"])
        if digest(inputs) != row["input_sha256"] or summarize(inputs) != result:
            raise ValueError("Projection registration failed integrity checks")
        return revision, {
            "status": "current",
            "registration_id": row["registration_id"],
            "dependencies": deps,
            "input_sha256": row["input_sha256"],
            "inputs": inputs,
            "result": result,
        }

    def save(self, identity, expected_revision, inputs):
        inputs = validate_registration(inputs)
        registration_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            self._case_matches(conn, identity)
            prior = self._latest(conn, identity["case_id"])
            revision = prior["registration_revision"] if prior else 0
            if revision != expected_revision:
                raise PlanConflict("Projection registration changed")
            conn.execute(
                "INSERT INTO projection_registrations VALUES (?,?,?,?,?,?,?)",
                (
                    registration_id,
                    identity["case_id"],
                    revision + 1,
                    encoded({**identity, "version": VERSION}),
                    encoded(inputs),
                    digest(inputs),
                    encoded(summarize(inputs)),
                ),
            )
        return registration_id, revision + 1
