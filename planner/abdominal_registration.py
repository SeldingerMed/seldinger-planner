"""The aorta and iliac model over an abdominal X-ray frame, lined up on bone.

Two records, both bound to the case's scan by its SHA-256:

- The model: the portable export of ``planner.aortoiliac_export``, made by
  the raw CTA inference from this very scan. It is admitted only when its
  ``source_sha256`` is the case's own ``image_sha256`` and every point of
  it lies inside the scan. It stays a proposal.
- The line-up: a rigid scan-to-C-arm matrix the browser's bone line-up
  proposed and the operator confirmed on the overlay, naming the model by
  its digest and each frame by its SHA-256.

One frame does not place the scan along its own beam; such a record says
so. A second frame that the browser set aside (it did not hold the bone, or
taking it would have moved the first frame's answer off its bone) is named
in the record and is not part of the pose.

Pixels and voxels never reach this module. Nothing here measures accuracy;
the scores are the browser's own report.
"""

import json
import math
import secrets
from contextlib import closing
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictFloat, StrictInt, field_validator

from planner.carm_geometry import CONVENTION, camera, view_frame
from planner.frame_source import MAX_FRAME_INDEX
from planner.physics_contract import encoded
from planner.projection_plan import PlanConflict
from planner.projection_registration import (
    SQUARE_PIXEL_TOLERANCE,
    RegistrationView,
    plane_angle_deg,
)
from planner.reformat_scene import Finite, digest, validate_rigid
from planner.territory_workflows import Point, StrictModel
from planner.workspace import _connect

MODEL_VERSION = "step-d3-aortoiliac-model-v1"
VERSION = "step-d3-bone-lineup-registration-v1"
METHOD = "bone_edge_compass_guarded_v3"
ENGINE_SINGLE = "bone_edge_compass_v2"
ENGINE_BIPLANE = "bone_edge_compass_biplane_v2"
# Each guarded method with its engine (one frame, two frames). v2 ran the
# engine the held-back protocol of 2026-11-22 read; v3 runs the engine that
# also searches the start from the finer levels. Earlier line-ups still
# validate under their own pair.
ENGINES = {
    "bone_edge_compass_guarded_v2": ("bone_edge_compass_v1", "bone_edge_compass_biplane_v1"),
    METHOD: (ENGINE_SINGLE, ENGINE_BIPLANE),
}
EXPORT_METHOD = "aortoiliac_totalsegmentator_total_v1"
MODEL_METHOD = "aortoiliac_widest_path_model_v1"
BRANCH_NAMES = ("aorta", "right_iliac", "left_iliac")
MAX_MODEL_BYTES = 1_000_000
MAX_POINTS = 4000
# Mirrors the browser engine: a lone frame is taken within this of the
# patient's front-to-back axis, and two frames this far apart.
LONE_FRAME_FROM_FRONT_DEG = 60.0
MIN_PLANE_ANGLE_DEG = 30.0
# A model point may sit this far outside the scan's voxel centers.
MODEL_MARGIN_VOXELS = 1.0
_SHA = r"^[a-f0-9]{64}$"
Score = Annotated[StrictFloat, Field(ge=-1, le=1, allow_inf_nan=False)]
Coordinate = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e5, le=1e5)]


class Branch(StrictModel):
    name: Literal["aorta", "right_iliac", "left_iliac"]
    path_ras: list[tuple[Coordinate, Coordinate, Coordinate]] = Field(
        min_length=2, max_length=MAX_POINTS
    )
    radius_mm: list[Annotated[StrictFloat, Field(gt=0, le=100, allow_inf_nan=False)]] = Field(
        min_length=2, max_length=MAX_POINTS
    )
    length_mm: Annotated[StrictFloat, Field(ge=0, le=5000, allow_inf_nan=False)]


class ModelProposal(StrictModel):
    method: Literal["aortoiliac_widest_path_model_v1"]
    branches: list[Branch] = Field(min_length=1, max_length=3)
    bifurcation_ras: tuple[Coordinate, Coordinate, Coordinate] | None
    bifurcation_below_meeting_mm: (
        Annotated[StrictFloat, Field(ge=-1000, le=1000, allow_inf_nan=False)] | None
    )
    operator_confirmation_required: Literal[True]
    clinical_validation: Literal[False]
    spatial_units: Literal["mm"]
    working_spacing_mm: list[Annotated[StrictFloat, Field(gt=0, le=50)]] = Field(
        min_length=3, max_length=3
    )
    working_grid_shape: list[Annotated[StrictInt, Field(gt=0, le=100_000)]] = Field(
        min_length=3, max_length=3
    )
    skeleton_voxel_count: StrictInt = Field(ge=0, le=100_000_000)
    volume_apart_from_the_model_mm3: Annotated[
        StrictFloat, Field(ge=0, le=1e9, allow_inf_nan=False)
    ]


class ModelEnvelope(StrictModel):
    """Exactly what ``planner.aortoiliac_export`` prints."""

    source_sha256: str = Field(pattern=_SHA)
    method: Literal["aortoiliac_totalsegmentator_total_v1"]
    spatial_units: Literal["mm"]
    operator_confirmation_required: Literal[True]
    proposal: ModelProposal


class ModelRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    model_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    export: ModelEnvelope


def validate_model(envelope, image_sha256, grid=None):
    """The export, checked against the scan it claims to come from."""
    value = ModelEnvelope.model_validate(envelope).model_dump(mode="json")
    if value["source_sha256"] != image_sha256:
        raise ValueError("The model was made from another scan")
    names = [branch["name"] for branch in value["proposal"]["branches"]]
    if len(set(names)) != len(names) or names[0] != "aorta":
        raise ValueError("The model names the aorta first and each branch once")
    for branch in value["proposal"]["branches"]:
        if len(branch["radius_mm"]) != len(branch["path_ras"]):
            raise ValueError("Each centerline point has one radius")
    if grid is not None:
        from planner.native_grid import native_voxel

        for branch in value["proposal"]["branches"]:
            for point in branch["path_ras"]:
                voxel = native_voxel(grid["affine"], point)
                if any(
                    not math.isfinite(v)
                    or v < -MODEL_MARGIN_VOXELS
                    or v > n - 1 + MODEL_MARGIN_VOXELS
                    for v, n in zip(voxel, grid["shape"], strict=True)
                ):
                    raise ValueError("The model leaves the scan")
    return value


class UsedPlane(StrictModel):
    plane: Literal["single", "a", "b"]
    frame_index: StrictInt = Field(ge=0, le=MAX_FRAME_INDEX)
    frame_sha256: str = Field(pattern=_SHA)
    geometry_source: Literal["frame_manifest", "operator_entered"]
    view: RegistrationView
    reported_score: Score


class SetAside(StrictModel):
    status: Literal["set_aside"]
    plane: Literal["single", "a", "b"]
    frame_index: StrictInt = Field(ge=0, le=MAX_FRAME_INDEX)
    frame_sha256: str = Field(pattern=_SHA)
    reason: Literal["bone_not_held", "moved_first_frame", "too_close", "lone_side_frame"]


class NotGiven(StrictModel):
    status: Literal["not_given"]


class BoneLineupInputs(StrictModel):
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def require_actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit operator confirmation required")
        return value

    method: Literal["bone_edge_compass_guarded_v2", "bone_edge_compass_guarded_v3"]
    engine_method: Literal[
        "bone_edge_compass_v1",
        "bone_edge_compass_biplane_v1",
        "bone_edge_compass_v2",
        "bone_edge_compass_biplane_v2",
    ]
    frame_source_id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{1,63}$")
    frame_manifest_revision: str = Field(pattern=_SHA)
    planes: list[UsedPlane] = Field(min_length=1, max_length=2)
    second_view: NotGiven | SetAside = Field(discriminator="status")
    depth: Literal["not_determined_single_view", "two_views"]
    model_revision: StrictInt = Field(ge=1, le=1_000_000_000)
    model_sha256: str = Field(pattern=_SHA)
    bone_threshold_hu: Annotated[StrictFloat, Field(ge=-1024, le=3000, allow_inf_nan=False)]
    # Mean over the frames used, at the start of the search.
    reported_start_score: Score
    isocenter: Point
    volume_to_carm_ras: list[list[Finite]] = Field(min_length=4, max_length=4)
    same_position: StrictBool


class BoneLineupRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    registration_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: BoneLineupInputs


def beam_from_front_deg(view, matrix):
    """Angle between the central ray and the scan's front-to-back axis as the
    pose carries it, the axis the browser engine reads."""
    _, _, d = view_frame(view["primary_deg"], view["secondary_deg"])
    along = sum(d[i] * matrix[i][1] for i in range(3))
    return math.degrees(math.acos(min(1.0, abs(along))))


def validate_lineup(inputs):
    value = BoneLineupInputs.model_validate(inputs).model_dump(mode="json")
    planes = value["planes"]
    two = len(planes) == 2
    if value["engine_method"] != ENGINES[value["method"]][1 if two else 0]:
        raise ValueError("The engine does not match the frames used")
    if value["depth"] != ("two_views" if two else "not_determined_single_view"):
        raise ValueError("One frame does not place depth along its beam")
    if two:
        if [entry["plane"] for entry in planes] != ["a", "b"]:
            raise ValueError("A two-frame line-up names plane a, then plane b")
        if planes[0]["frame_sha256"] == planes[1]["frame_sha256"]:
            raise ValueError("The two frames name identical pixels")
        if plane_angle_deg(planes[0]["view"], planes[1]["view"]) < MIN_PLANE_ANGLE_DEG - 1e-9:
            raise ValueError("The two frames are too close to determine depth")
        if value["second_view"]["status"] != "not_given":
            raise ValueError("A frame set aside is not part of the pose")
        if value["same_position"] is not True:
            raise ValueError("Two frames need the operator's word that the patient did not move")
    validate_rigid(value["volume_to_carm_ras"])
    if not two:
        if (
            beam_from_front_deg(planes[0]["view"], value["volume_to_carm_ras"])
            > LONE_FRAME_FROM_FRONT_DEG + 1e-9
        ):
            raise ValueError("A lone side frame does not place the bone")
        aside = value["second_view"]
        if aside["status"] == "set_aside" and aside["frame_sha256"] == planes[0]["frame_sha256"]:
            raise ValueError("The frame set aside is the frame used")
    for entry in planes:
        camera(entry["view"], value["isocenter"])
    return value


def check_plane(entry, plane):
    view = entry["view"]
    pitch = view["detector_width_mm"] / plane["columns"]
    if abs(view["detector_height_mm"] / plane["rows"] / pitch - 1) > SQUARE_PIXEL_TOLERANCE:
        raise ValueError("Detector pixels must be square")
    if entry["geometry_source"] == "frame_manifest":
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
    out = {
        "version": VERSION,
        "convention": CONVENTION,
        "method": inputs["method"],
        "engine_method": inputs["engine_method"],
        "status": "operator_confirmed_proposal",
        "validated": False,
        "depth": inputs["depth"],
        "second_view": inputs["second_view"]["status"],
        "rotation_deg": round(math.degrees(math.acos(max(-1.0, min(1.0, (trace - 1) / 2)))), 3),
        "isocenter_shift_mm": round(math.dist(moved, iso), 3),
        "score_source": "browser_reported_not_recomputed",
        "score_kind": "bone_edge_agreement_share",
        "planes": [
            {
                "plane": entry["plane"],
                "geometry_source": entry["geometry_source"],
                "reported_score": entry["reported_score"],
            }
            for entry in inputs["planes"]
        ],
        "reported_start_score": inputs["reported_start_score"],
    }
    if len(inputs["planes"]) == 2:
        out["plane_angle_deg"] = round(
            plane_angle_deg(inputs["planes"][0]["view"], inputs["planes"][1]["view"]), 3
        )
        out["same_position"] = "operator_attested_not_checked"
    return out


def _case_matches(conn, identity):
    row = conn.execute("SELECT * FROM cases WHERE case_id=?", (identity["case_id"],)).fetchone()
    if (
        row is None
        or row["image_sha256"] != identity["image_sha256"]
        or str(row["artifact_version"]) != identity["artifact_version"]
        or row["spatial_units"] != "mm"
    ):
        raise PlanConflict("Case changed")


class _Ledger:
    """Append-only revisions of one record kind per case."""

    table = ""
    version = ""

    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.execute(
                f"CREATE TABLE IF NOT EXISTS {self.table} (record_id TEXT PRIMARY KEY,"
                "case_id TEXT NOT NULL REFERENCES cases(case_id),revision INTEGER NOT NULL,"
                "dependencies TEXT NOT NULL,body TEXT NOT NULL,body_sha256 TEXT NOT NULL,"
                "UNIQUE(case_id,revision))"
            )

    def _latest(self, conn, case_id):
        return conn.execute(
            f"SELECT * FROM {self.table} WHERE case_id=? ORDER BY revision DESC LIMIT 1",
            (case_id,),
        ).fetchone()

    def check(self, body, identity):  # pragma: no cover - overridden
        raise NotImplementedError

    def current(self, identity):
        with closing(_connect(self.db_path)) as conn:
            conn.execute("BEGIN")
            _case_matches(conn, identity)
            row = self._latest(conn, identity["case_id"])
        if row is None:
            return 0, {"status": "not_confirmed"}
        revision = row["revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid revision")
        stored = json.loads(row["dependencies"])
        if stored != {**identity, "version": self.version}:
            return revision, {"status": "stale", "record_id": row["record_id"]}
        body = self.check(json.loads(row["body"]), identity)
        if digest(body) != row["body_sha256"]:
            raise ValueError("Record failed integrity checks")
        return revision, {
            "status": "current",
            "record_id": row["record_id"],
            "body_sha256": row["body_sha256"],
            "body": body,
        }

    def save(self, identity, expected_revision, body):
        body = self.check(body, identity)
        record_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            _case_matches(conn, identity)
            prior = self._latest(conn, identity["case_id"])
            revision = prior["revision"] if prior else 0
            if revision != expected_revision:
                raise PlanConflict("Record changed")
            conn.execute(
                f"INSERT INTO {self.table} VALUES (?,?,?,?,?,?)",
                (
                    record_id,
                    identity["case_id"],
                    revision + 1,
                    encoded({**identity, "version": self.version}),
                    encoded(body),
                    digest(body),
                ),
            )
        return record_id, revision + 1


class ModelLedger(_Ledger):
    table = "aortoiliac_models"
    version = MODEL_VERSION

    def check(self, body, identity):
        return validate_model(body, identity["image_sha256"])


class LineupLedger(_Ledger):
    table = "bone_lineup_registrations"
    version = VERSION

    def check(self, body, identity):
        return validate_lineup(body)
