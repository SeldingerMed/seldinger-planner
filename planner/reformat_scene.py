"""Immutable source-bound, operator-confirmed path and rigid-registration scenes."""

import hashlib
import json
import math
import secrets
from contextlib import closing
from typing import Annotated, Literal

from pydantic import Field, StrictInt, field_validator

from planner.physics_contract import encoded
from planner.territory_geometry import path_distances
from planner.territory_workflows import Point, StrictModel
from planner.workspace import _connect

VERSION = "phase4-native-scene-v1"
Finite = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e6, le=1e6)]


class Secondary(StrictModel):
    source_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    image_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    secondary_to_primary_ras: list[list[Finite]] = Field(min_length=4, max_length=4)


class SceneInputs(StrictModel):
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def require_actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit operator confirmation required")
        return value

    path: list[Point] = Field(min_length=2, max_length=128)
    secondary: Secondary | None = None


class SceneRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    scene_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: SceneInputs


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def validate_rigid(matrix):
    if len(matrix) != 4 or any(len(row) != 4 for row in matrix):
        raise ValueError("Rigid matrix must be 4x4")
    if matrix[3] != [0, 0, 0, 1]:
        raise ValueError("Rigid matrix requires homogeneous row")
    r = [row[:3] for row in matrix[:3]]
    for i in range(3):
        for j in range(3):
            if not math.isclose(
                sum(r[k][i] * r[k][j] for k in range(3)), float(i == j), abs_tol=1e-6, rel_tol=0
            ):
                raise ValueError("Rotation must be orthonormal")
    a, b, c = r
    det = (
        a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
    )
    if not math.isclose(det, 1, abs_tol=1e-6, rel_tol=0):
        raise ValueError("Rotation must preserve handedness")


def validate_scene(inputs):
    value = SceneInputs.model_validate(inputs).model_dump(mode="json")
    distances = path_distances(value["path"])
    if distances[-1] > 10000:
        raise ValueError("Path exceeds length bound")
    if value["secondary"] is not None:
        validate_rigid(value["secondary"]["secondary_to_primary_ras"])
    return value


def summarize(inputs):
    return {
        "version": VERSION,
        "path_source": "operator_confirmed",
        "path_point_count": len(inputs["path"]),
        "path_length_mm": path_distances(inputs["path"])[-1],
        "registration_method": "operator_confirmed_rigid_ras" if inputs["secondary"] else None,
    }


class SceneConflict(ValueError):
    pass


class SceneLedger:
    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS reformat_scenes (scene_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(case_id),scene_revision INTEGER NOT NULL,dependencies TEXT NOT NULL,inputs TEXT NOT NULL,input_sha256 TEXT NOT NULL,result TEXT NOT NULL, UNIQUE(case_id,scene_revision))"
            )

    @staticmethod
    def _latest(conn, case_id):
        return conn.execute(
            "SELECT * FROM reformat_scenes WHERE case_id=? ORDER BY scene_revision DESC LIMIT 1",
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
            raise SceneConflict("Case changed")

    def current(self, identity):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            self._case_matches(conn, identity)
            row = self._latest(conn, identity["case_id"])
        if row is None:
            return 0, {"status": "not_confirmed"}
        revision = row["scene_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid scene revision")
        deps = {**identity, "version": VERSION}
        if json.loads(row["dependencies"]) != deps:
            return revision, {
                "status": "stale",
                "scene_id": row["scene_id"],
                "inputs": None,
                "result": None,
            }
        inputs = validate_scene(json.loads(row["inputs"]))
        result = json.loads(row["result"])
        if digest(inputs) != row["input_sha256"] or summarize(inputs) != result:
            raise ValueError("Scene failed integrity checks")
        return revision, {
            "status": "current",
            "scene_id": row["scene_id"],
            "dependencies": deps,
            "input_sha256": row["input_sha256"],
            "inputs": inputs,
            "result": result,
        }

    def save(self, identity, expected_revision, inputs):
        inputs = validate_scene(inputs)
        scene_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            self._case_matches(conn, identity)
            prior = self._latest(conn, identity["case_id"])
            revision = prior["scene_revision"] if prior else 0
            if revision != expected_revision:
                raise SceneConflict("Scene changed")
            conn.execute(
                "INSERT INTO reformat_scenes VALUES (?,?,?,?,?,?,?)",
                (
                    scene_id,
                    identity["case_id"],
                    revision + 1,
                    encoded({**identity, "version": VERSION}),
                    encoded(inputs),
                    digest(inputs),
                    encoded(summarize(inputs)),
                ),
            )
        return scene_id, revision + 1
