"""Immutable source-bound, operator-confirmed C-arm working views.

A plan holds an isocenter, a target path and up to eight named views in
patient RAS millimeters. The server derives every scalar it reports from the
confirmed inputs. Nothing here is registered to an acquired angiogram, and the
angle convention is the declared one in ``planner.carm_geometry``.
"""

import json
import secrets
from contextlib import closing
from typing import Annotated, Literal

from pydantic import Field, StrictFloat, StrictInt, field_validator

from planner.carm_geometry import (
    CONVENTION,
    FORESHORTENING_METHOD,
    MAX_DETECTOR_MM,
    MAX_SOURCE_DETECTOR_MM,
    MIN_DETECTOR_MM,
    MIN_SOURCE_DETECTOR_MM,
    MIN_SOURCE_ISOCENTER_MM,
    summarize_view,
)
from planner.physics_contract import encoded
from planner.reformat_scene import digest
from planner.territory_geometry import path_distances
from planner.territory_workflows import Point, StrictModel
from planner.workspace import _connect

VERSION = "step-a-carm-views-v1"
MAX_VIEWS = 8
MAX_PATH_LENGTH_MM = 10000


def _bounded(low, high):
    return Annotated[StrictFloat, Field(ge=low, le=high, allow_inf_nan=False)]


PrimaryAngle = _bounded(-180, 180)
SecondaryAngle = _bounded(-90, 90)
SourceDetector = _bounded(MIN_SOURCE_DETECTOR_MM, MAX_SOURCE_DETECTOR_MM)
SourceIsocenter = _bounded(MIN_SOURCE_ISOCENTER_MM, MAX_SOURCE_DETECTOR_MM)
DetectorSide = _bounded(MIN_DETECTOR_MM, MAX_DETECTOR_MM)


class View(StrictModel):
    # Letters, digits, spaces, hyphens and underscores only: the name is
    # rendered into an exported Markdown brief.
    name: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
    primary_deg: PrimaryAngle
    secondary_deg: SecondaryAngle
    source_detector_mm: SourceDetector
    source_isocenter_mm: SourceIsocenter
    detector_width_mm: DetectorSide
    detector_height_mm: DetectorSide


class PlanInputs(StrictModel):
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def require_actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit operator confirmation required")
        return value

    isocenter: Point
    target_path: list[Point] = Field(min_length=2, max_length=128)
    views: list[View] = Field(min_length=1, max_length=MAX_VIEWS)


class PlanRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    plan_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: PlanInputs


def validate_plan(inputs):
    value = PlanInputs.model_validate(inputs).model_dump(mode="json")
    if path_distances(value["target_path"])[-1] > MAX_PATH_LENGTH_MM:
        raise ValueError("Target path exceeds length bound")
    names = [view["name"] for view in value["views"]]
    if len(set(names)) != len(names):
        raise ValueError("View names must be unique")
    summarize(value)  # Every view must project the whole target path.
    return value


def summarize(inputs):
    path = inputs["target_path"]
    return {
        "version": VERSION,
        "convention": CONVENTION,
        "foreshortening_method": FORESHORTENING_METHOD,
        "view_source": "operator_confirmed",
        "target_point_count": len(path),
        "target_length_mm": path_distances(path)[-1],
        "views": [
            {
                "name": view["name"],
                **summarize_view(view, inputs["isocenter"], path),
            }
            for view in inputs["views"]
        ],
    }


class PlanConflict(ValueError):
    pass


class PlanLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS projection_plans (plan_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(case_id),plan_revision INTEGER NOT NULL,dependencies TEXT NOT NULL,inputs TEXT NOT NULL,input_sha256 TEXT NOT NULL,result TEXT NOT NULL, UNIQUE(case_id,plan_revision))"
            )

    @staticmethod
    def _latest(conn, case_id):
        return conn.execute(
            "SELECT * FROM projection_plans WHERE case_id=? ORDER BY plan_revision DESC LIMIT 1",
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
        revision = row["plan_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid plan revision")
        deps = {**identity, "version": VERSION}
        if json.loads(row["dependencies"]) != deps:
            return revision, {
                "status": "stale",
                "plan_id": row["plan_id"],
                "inputs": None,
                "result": None,
            }
        inputs = validate_plan(json.loads(row["inputs"]))
        result = json.loads(row["result"])
        if digest(inputs) != row["input_sha256"] or summarize(inputs) != result:
            raise ValueError("Projection plan failed integrity checks")
        return revision, {
            "status": "current",
            "plan_id": row["plan_id"],
            "dependencies": deps,
            "input_sha256": row["input_sha256"],
            "inputs": inputs,
            "result": result,
        }

    def save(self, identity, expected_revision, inputs):
        inputs = validate_plan(inputs)
        plan_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            self._case_matches(conn, identity)
            prior = self._latest(conn, identity["case_id"])
            revision = prior["plan_revision"] if prior else 0
            if revision != expected_revision:
                raise PlanConflict("Projection plan changed")
            conn.execute(
                "INSERT INTO projection_plans VALUES (?,?,?,?,?,?,?)",
                (
                    plan_id,
                    identity["case_id"],
                    revision + 1,
                    encoded({**identity, "version": VERSION}),
                    encoded(inputs),
                    digest(inputs),
                    encoded(summarize(inputs)),
                ),
            )
        return plan_id, revision + 1
