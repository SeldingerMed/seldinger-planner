"""Immutable, operator-confirmed vessel-presence reports.

A report says, for each unnamed geometric segment of the accepted vessel
mask and each plane of one saved registration, whether the frame shows a
vessel under the segment. The browser computes it from the frame, the mask
and the registration; an operator reviews it and confirms it. This module
stores it, bound to the exact registration it was computed with.

A report asserts no cause. A segment without 2D support may be occluded,
unfilled, outside the injected territory or absent, or the registration may
be wrong: the report is only as good as that registration, which is itself
an unvalidated proposal.

The server does not see the frame or the mask and cannot recompute the
counts. It checks what it can: that the counts are possible, that each class
follows from its counts under the fixed rule, and that the report names the
registration that is current. Pixels and coordinates never reach this module.
"""

import itertools
import json
import math
import secrets
from contextlib import closing
from typing import Annotated, Literal

from pydantic import Field, StrictFloat, StrictInt, field_validator

from planner.physics_contract import encoded
from planner.projection_plan import PlanConflict
from planner.projection_registration import bound_planes, is_evidence
from planner.reformat_scene import digest
from planner.territory_workflows import StrictModel
from planner.workspace import _connect

VERSION = "step-c3-vessel-presence-v1"
METHOD = "segment_centerline_support_v1"
SEGMENT_METHOD = "mask_band_sweep_v1"
CLASSES = ("supported", "no_2d_support", "outside_field", "indeterminate")
# Mirrors the browser's rule. A change to either is a new method.
MIN_IN_FIELD = 0.5
MIN_CLEAR_SAMPLES = 3
MIN_CLEAR_FRACTION = 0.3
SUPPORTED_FRACTION = 0.7
UNSUPPORTED_FRACTION = 0.3
MIN_PIECE_MM = 5.0
MAX_SEGMENTS = 2000
MAX_UNMATCHED = 2000
MAX_SAMPLES = 100_000
_SHA = r"^[a-f0-9]{64}$"
Count = Annotated[StrictInt, Field(ge=0, le=MAX_SAMPLES)]
Length = Annotated[StrictFloat, Field(ge=0, le=10_000, allow_inf_nan=False)]


class Segment(StrictModel):
    length_mm: Annotated[StrictFloat, Field(gt=0, le=10_000, allow_inf_nan=False)]
    mean_radius_mm: Annotated[StrictFloat, Field(gt=0, le=100, allow_inf_nan=False)]
    sample_count: Count
    # The unbranched run the segment was cut from. Not a vessel name.
    run: Annotated[StrictInt, Field(ge=0, lt=MAX_SEGMENTS)]


class SegmentPresence(StrictModel):
    presence: Literal["supported", "no_2d_support", "outside_field", "indeterminate"]
    in_field: Count
    clear: Count
    supported: Count


class PlaneReport(StrictModel):
    plane: Literal["single", "a", "b"]
    frame_sha256: str = Field(pattern=_SHA)
    segments: list[SegmentPresence] = Field(min_length=1, max_length=MAX_SEGMENTS)
    # Lengths of the 2D vessel pieces with no projected segment near, longest first.
    unmatched_mm: list[Length] = Field(max_length=MAX_UNMATCHED)


class PresenceInputs(StrictModel):
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def require_actual_confirmation(cls, value):
        if value is not True:
            raise ValueError("Explicit operator confirmation required")
        return value

    registration_id: str = Field(pattern=r"^[A-Za-z0-9_-]{16,128}$")
    registration_revision: StrictInt = Field(ge=1, le=1_000_000_000)
    registration_input_sha256: str = Field(pattern=_SHA)
    method: Literal["segment_centerline_support_v1"]
    segment_method: Literal["mask_band_sweep_v1"]
    pooling: StrictInt = Field(ge=1, le=8)
    unassigned_fraction: Annotated[StrictFloat, Field(ge=0, le=1, allow_inf_nan=False)]
    segments: list[Segment] = Field(min_length=1, max_length=MAX_SEGMENTS)
    planes: list[PlaneReport] = Field(min_length=1, max_length=2)


class PresenceRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    report_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: PresenceInputs


def classify(sample_count, in_field, clear, supported):
    """The class that follows from one segment's counts in one plane."""
    if in_field < MIN_IN_FIELD * sample_count:
        return "outside_field"
    if clear < MIN_CLEAR_SAMPLES or clear < MIN_CLEAR_FRACTION * in_field:
        return "indeterminate"
    if supported >= SUPPORTED_FRACTION * clear:
        return "supported"
    if supported <= UNSUPPORTED_FRACTION * clear:
        return "no_2d_support"
    return "indeterminate"


def validate_presence(inputs):
    value = PresenceInputs.model_validate(inputs).model_dump(mode="json")
    segments = value["segments"]
    runs = [segment["run"] for segment in segments]
    # Runs are numbered in the order their segments are listed.
    if runs[0] != 0 or any(b - a not in (0, 1) for a, b in itertools.pairwise(runs)):
        raise ValueError("Segment runs are out of order")
    names = [plane["plane"] for plane in value["planes"]]
    if names not in (["single"], ["a"], ["b"], ["a", "b"]):
        raise ValueError("A report names one plane, or plane a then plane b")
    for plane in value["planes"]:
        if len(plane["segments"]) != len(segments):
            raise ValueError("Every plane classes every segment")
        for segment, entry in zip(segments, plane["segments"], strict=True):
            if (
                not entry["supported"]
                <= entry["clear"]
                <= entry["in_field"]
                <= segment["sample_count"]
            ):
                raise ValueError("Impossible sample counts")
            if entry["presence"] != classify(
                segment["sample_count"], entry["in_field"], entry["clear"], entry["supported"]
            ):
                raise ValueError("Class contradicts its counts")
        lengths = plane["unmatched_mm"]
        if any(length < MIN_PIECE_MM for length in lengths) or any(
            b > a for a, b in itertools.pairwise(lengths)
        ):
            raise ValueError("Unmatched pieces must be listed longest first")
    return value


def binding(registration):
    """What a report must name to belong to this registration, or None.

    ``registration`` is the registration reader's envelope. Only a current
    registration by a centerline distance method can carry a report: the
    report reads the 2D line set that registration was matched to, at the
    sensitivity its record states, and a vessel evidence record has neither.
    """
    current = registration["current"]
    if current["status"] != "current" or is_evidence(current["inputs"]):
        return None
    return {
        "registration_id": current["registration_id"],
        "registration_revision": registration["registration_revision"],
        "registration_input_sha256": current["input_sha256"],
        "planes": [
            {"plane": entry["plane"], "frame_sha256": entry["frame_sha256"]}
            for entry in bound_planes(current["inputs"])
        ],
    }


def bound_to(inputs, bind):
    return bind is not None and bind == {
        **{
            key: inputs[key]
            for key in ("registration_id", "registration_revision", "registration_input_sha256")
        },
        "planes": [
            {"plane": plane["plane"], "frame_sha256": plane["frame_sha256"]}
            for plane in inputs["planes"]
        ],
    }


def summarize(inputs):
    """Server-derived scalars: counts and lengths by class, per plane."""
    segments = inputs["segments"]

    def by_class(plane):
        return {
            name: {
                "count": sum(1 for entry in plane["segments"] if entry["presence"] == name),
                "length_mm": round(
                    math.fsum(
                        segment["length_mm"]
                        for segment, entry in zip(segments, plane["segments"], strict=True)
                        if entry["presence"] == name
                    ),
                    3,
                ),
            }
            for name in CLASSES
        }

    return {
        "version": VERSION,
        "method": METHOD,
        "segment_method": SEGMENT_METHOD,
        "status": "operator_confirmed_report",
        "validated": False,
        "cause": "not_asserted",
        "counts_source": "browser_reported_not_recomputed",
        "segment_count": len(segments),
        "segment_length_mm": round(math.fsum(s["length_mm"] for s in segments), 3),
        "unassigned_fraction": inputs["unassigned_fraction"],
        "planes": [
            {
                "plane": plane["plane"],
                "classes": by_class(plane),
                "unmatched_count": len(plane["unmatched_mm"]),
                "unmatched_length_mm": round(math.fsum(plane["unmatched_mm"]), 3),
            }
            for plane in inputs["planes"]
        ],
    }


class PresenceLedger:
    """Append-only reports. Requires the registration ledger's table."""

    def __init__(self, db_path):
        self.db_path = db_path
        with closing(_connect(db_path)) as conn, conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS vessel_presence_reports (report_id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES cases(case_id),report_revision INTEGER NOT NULL,dependencies TEXT NOT NULL,inputs TEXT NOT NULL,input_sha256 TEXT NOT NULL,result TEXT NOT NULL, UNIQUE(case_id,report_revision))"
            )

    @staticmethod
    def _latest(conn, case_id):
        return conn.execute(
            "SELECT * FROM vessel_presence_reports WHERE case_id=? "
            "ORDER BY report_revision DESC LIMIT 1",
            (case_id,),
        ).fetchone()

    @staticmethod
    def _dependencies(identity, inputs):
        return {
            **identity,
            "version": VERSION,
            **{
                key: inputs[key]
                for key in (
                    "registration_id",
                    "registration_revision",
                    "registration_input_sha256",
                )
            },
        }

    def current(self, identity, bind):
        """The latest report, current only against the registration ``bind`` names."""
        with closing(_connect(self.db_path)) as conn:
            row = self._latest(conn, identity["case_id"])
        if row is None:
            return 0, {"status": "not_confirmed"}
        revision = row["report_revision"]
        if type(revision) is not int or revision < 1:
            raise ValueError("Invalid report revision")
        stale = {
            "status": "stale",
            "report_id": row["report_id"],
            "inputs": None,
            "result": None,
        }
        stored = json.loads(row["dependencies"])
        if bind is None or stored != {
            **identity,
            "version": VERSION,
            **{key: value for key, value in bind.items() if key != "planes"},
        }:
            return revision, stale
        inputs = validate_presence(json.loads(row["inputs"]))
        result = json.loads(row["result"])
        if (
            self._dependencies(identity, inputs) != stored
            or not bound_to(inputs, bind)
            or digest(inputs) != row["input_sha256"]
            or summarize(inputs) != result
        ):
            raise ValueError("Vessel presence report failed integrity checks")
        return revision, {
            "status": "current",
            "report_id": row["report_id"],
            "dependencies": stored,
            "input_sha256": row["input_sha256"],
            "inputs": inputs,
            "result": result,
        }

    def save(self, identity, expected_revision, inputs):
        inputs = validate_presence(inputs)
        report_id = secrets.token_urlsafe(16)
        with closing(_connect(self.db_path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            case = conn.execute(
                "SELECT * FROM cases WHERE case_id=?", (identity["case_id"],)
            ).fetchone()
            if (
                case is None
                or case["image_sha256"] != identity["image_sha256"]
                or str(case["artifact_version"]) != identity["artifact_version"]
            ):
                raise PlanConflict("Case changed")
            # The registration named must still be the latest one, in this
            # transaction: a newer confirmation makes the report stale at once.
            latest = conn.execute(
                "SELECT registration_id, registration_revision, input_sha256 "
                "FROM projection_registrations WHERE case_id=? "
                "ORDER BY registration_revision DESC LIMIT 1",
                (identity["case_id"],),
            ).fetchone()
            if latest is None or tuple(latest) != (
                inputs["registration_id"],
                inputs["registration_revision"],
                inputs["registration_input_sha256"],
            ):
                raise PlanConflict("Projection registration changed")
            prior = self._latest(conn, identity["case_id"])
            revision = prior["report_revision"] if prior else 0
            if revision != expected_revision:
                raise PlanConflict("Vessel presence report changed")
            conn.execute(
                "INSERT INTO vessel_presence_reports VALUES (?,?,?,?,?,?,?)",
                (
                    report_id,
                    identity["case_id"],
                    revision + 1,
                    encoded(self._dependencies(identity, inputs)),
                    encoded(inputs),
                    digest(inputs),
                    encoded(summarize(inputs)),
                ),
            )
        return report_id, revision + 1
