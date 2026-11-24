"""The CT coronary tree and its confirmed correspondence with a paired cine.

Two records, both bound to the case's scan, artifact version and reference
revision:

- The tree: named coronary branches as centerlines in the scan's RAS
  millimeters, with the CT's reconstruction phase. It is admitted only when
  its ``source_sha256`` is the case's own ``image_sha256`` and every point
  lies inside the scan. Its provenance (curated annotation, operator traced
  or trained inference) is stated, never inferred.
- The correspondence: the one proposal the browser made from this tree and
  a cine the operator stated is this patient's, and the operator confirmed.
  The pair is the operator's statement, recorded by the tree's digest and
  the cine's source and bundle digests. Nothing pairs them by name.

The cine is held in the browser and never sent here, so the server checks
the record against the tree and says so; it cannot check it against the
cine. Pixels never reach this module. The scores are the browser's own
report, not a measured accuracy.
"""

import math
from typing import Annotated, Literal

from pydantic import Field, StrictFloat, StrictInt

from planner.abdominal_registration import _Ledger
from planner.projection_registration import RegistrationView
from planner.reformat_scene import Finite, validate_rigid
from planner.territory_workflows import StrictModel

TREE_VERSION = "step-e-coronary-tree-v1"
VERSION = "step-e-coronary-correspondence-v1"
TREE_METHOD = "coronary_centerline_tree_v1"
METHOD = "ct_tree_cine_correspondence_v1"
PERIOD_METHOD = "cine_heart_period_v2"
MOTION_METHOD = "coronary_tree_tracking_v1"
MAX_CORRESPONDENCE_BYTES = 65_536
MAX_BRANCHES = 32
MAX_POINTS = 2000
# The largest tree the schema admits fits, as the browser writes it
# (JSON.stringify, no spaces): a coordinate is at most 25 characters (signed,
# 17 significant digits in fixed notation), so a point is at most 79 bytes;
# 256 bytes covers a branch's id, label and parent.
MAX_TREE_BYTES = MAX_BRANCHES * (MAX_POINTS * 80 + 256) + 4096
MAX_FRAMES = 600
# A tree point may sit this far outside the scan's voxel centers.
TREE_MARGIN_VOXELS = 1.0
_SHA = r"^[a-f0-9]{64}$"
_ID = r"^[a-z0-9][a-z0-9_]{0,31}$"
Coordinate = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e5, le=1e5)]
Phase = Annotated[StrictFloat, Field(ge=0, lt=100, allow_inf_nan=False)]
Unit = Annotated[StrictFloat, Field(ge=0, le=1, allow_inf_nan=False)]
FrameIndex = Annotated[StrictInt, Field(ge=0, lt=MAX_FRAMES)]


class TreeBranch(StrictModel):
    id: str = Field(pattern=_ID)
    label: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9 ()/,.'-]+$")
    parent: str | None = Field(pattern=_ID)
    path_ras: list[tuple[Coordinate, Coordinate, Coordinate]] = Field(
        min_length=2, max_length=MAX_POINTS
    )


class TreeEnvelope(StrictModel):
    source_sha256: str = Field(pattern=_SHA)
    method: Literal["coronary_centerline_tree_v1"]
    provenance: Literal["curated_annotation", "operator_traced", "trained_inference"]
    spatial_units: Literal["mm"]
    ct_phase_percent: Phase | None
    operator_confirmation_required: Literal[True]
    branches: list[TreeBranch] = Field(min_length=1, max_length=MAX_BRANCHES)


class TreeRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    tree_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    export: TreeEnvelope


def validate_tree(envelope, image_sha256, grid=None):
    """The tree, checked against the scan it claims to come from."""
    value = TreeEnvelope.model_validate(envelope).model_dump(mode="json")
    if value["source_sha256"] != image_sha256:
        raise ValueError("The tree was made from another scan")
    branches = value["branches"]
    ids = [branch["id"] for branch in branches]
    if len(set(ids)) != len(ids):
        raise ValueError("The tree names each branch once")
    parent = {branch["id"]: branch["parent"] for branch in branches}
    if any(p is not None and p not in parent for p in parent.values()):
        raise ValueError("A branch's parent is in the tree")
    roots = [i for i, p in parent.items() if p is None]
    for start in ids:
        seen, at = set(), start
        while at is not None:
            if at in seen:
                raise ValueError("The tree has one root and no loop")
            seen.add(at)
            at = parent[at]
    if len(roots) != 1:
        raise ValueError("The tree has one root and no loop")
    if grid is not None:
        from planner.native_grid import native_voxel

        for branch in branches:
            for point in branch["path_ras"]:
                voxel = native_voxel(grid["affine"], point)
                if any(
                    not math.isfinite(v)
                    or v < -TREE_MARGIN_VOXELS
                    or v > n - 1 + TREE_MARGIN_VOXELS
                    for v, n in zip(voxel, grid["shape"], strict=True)
                ):
                    raise ValueError("The tree leaves the scan")
    return value


class Pair(StrictModel):
    """The operator's statement that the cine is this patient's."""

    stated_by: Literal["operator"]
    tree_revision: StrictInt = Field(ge=1, le=1_000_000_000)
    tree_sha256: str = Field(pattern=_SHA)
    cine_source_sha256: str = Field(pattern=_SHA)
    cine_bundle_sha256: str = Field(pattern=_SHA)


class PhaseMatch(StrictModel):
    method: Literal["cine_heart_period_v2"]
    ct_phase_percent: Phase
    period_ms: Annotated[StrictFloat, Field(ge=333, le=1500, allow_inf_nan=False)]
    quiet_frames: list[FrameIndex] = Field(min_length=1, max_length=MAX_FRAMES)
    frame: FrameIndex


class BranchOutcome(StrictModel):
    id: str = Field(pattern=_ID)
    status: Literal["matched", "not_found", "ambiguous", "conflict"]
    reported_score: Unit


class Motion(StrictModel):
    method: Literal["coronary_tree_tracking_v1"]
    frames: Annotated[StrictInt, Field(ge=1, le=MAX_FRAMES)]
    followed: Annotated[StrictInt, Field(ge=0, le=MAX_FRAMES)]
    refused: Annotated[StrictInt, Field(ge=0, le=MAX_FRAMES)]


class CorrespondenceInputs(StrictModel):
    confirmed: Literal[True]
    method: Literal["ct_tree_cine_correspondence_v1"]
    pair: Pair
    phase: PhaseMatch
    view: RegistrationView
    ct_to_carm_ras: list[list[Finite]] = Field(min_length=4, max_length=4)
    reported_fit_score: Unit
    branches: list[BranchOutcome] = Field(min_length=1, max_length=MAX_BRANCHES)
    motion: Motion
    clinical_validation: Literal[False]


class CorrespondenceRequest(StrictModel):
    artifact_version: str = Field(pattern=r"^[0-9]{1,20}$")
    reference_revision: str = Field(pattern=_SHA)
    correspondence_revision: StrictInt = Field(ge=0, le=1_000_000_000)
    inputs: CorrespondenceInputs


def validate_correspondence(inputs):
    value = CorrespondenceInputs.model_validate(inputs).model_dump(mode="json")
    validate_rigid(value["ct_to_carm_ras"])
    phase = value["phase"]
    if phase["frame"] not in phase["quiet_frames"]:
        raise ValueError("The phase frame is one of the quiet frames")
    if sorted(set(phase["quiet_frames"])) != phase["quiet_frames"]:
        raise ValueError("Quiet frames are in order, each once")
    motion = value["motion"]
    if motion["followed"] + motion["refused"] > motion["frames"] or any(
        q >= motion["frames"] for q in phase["quiet_frames"]
    ):
        raise ValueError("Frame counts contradict the cine")
    ids = [b["id"] for b in value["branches"]]
    if len(set(ids)) != len(ids):
        raise ValueError("Each branch once")
    if not any(b["status"] == "matched" for b in value["branches"]):
        raise ValueError("At least one branch is matched")
    return value


def check_against_tree(inputs, tree_revision, tree):
    """Raise unless ``inputs`` were made from this very tree."""
    pair = inputs["pair"]
    body = tree.get("body")
    if (
        tree.get("status") != "current"
        or pair["tree_revision"] != tree_revision
        or pair["tree_sha256"] != tree.get("body_sha256")
        or [b["id"] for b in inputs["branches"]] != [b["id"] for b in body["branches"]]
        or body["ct_phase_percent"] is None
        or not math.isclose(
            inputs["phase"]["ct_phase_percent"], body["ct_phase_percent"], abs_tol=1e-9
        )
    ):
        raise ValueError("Correspondence does not match the current tree")


def summarize(inputs):
    branches = inputs["branches"]
    return {
        "branches": len(branches),
        "matched": [b["id"] for b in branches if b["status"] == "matched"],
        "not_matched": {b["id"]: b["status"] for b in branches if b["status"] != "matched"},
        "followed_frames": inputs["motion"]["followed"],
        "refused_frames": inputs["motion"]["refused"],
        "cine": "held_in_the_browser_not_verified_here",
        "clinical_validation": False,
    }


class TreeLedger(_Ledger):
    table = "coronary_trees"
    version = TREE_VERSION

    def check(self, body, identity):
        return validate_tree(body, identity["image_sha256"])


class CorrespondenceLedger(_Ledger):
    table = "coronary_correspondences"
    version = VERSION

    def check(self, body, identity):
        return validate_correspondence(body)


__all__ = [
    "MAX_CORRESPONDENCE_BYTES",
    "MAX_TREE_BYTES",
    "METHOD",
    "MOTION_METHOD",
    "PERIOD_METHOD",
    "TREE_METHOD",
    "TREE_VERSION",
    "VERSION",
    "CorrespondenceLedger",
    "CorrespondenceRequest",
    "TreeLedger",
    "TreeRequest",
    "check_against_tree",
    "summarize",
    "validate_correspondence",
    "validate_tree",
]
