"""Fixed local public-reference endpoints. Never accept paths or arbitrary URLs."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

SOURCE = "https://doi.org/10.6084/m9.figshare.26965450.v1"
LICENSE = "https://creativecommons.org/licenses/by/4.0/"
CITATION = "Song et al., CMHA (2024). Original case AHMU1218001. Context crop and coordinate-transformed curated references."
MATRIX = [[-1, 0, 0], [0, -1, 0], [0, 0, 1]]


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


class ReferenceStore:
    def __init__(self, root: Path):
        self.root = root

    def _file(self, name: str, expected: str, cap: int) -> Path:
        path = self.root / name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= cap:
            raise ValueError("Invalid reference asset")
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected:
            raise ValueError("Reference hash mismatch")
        return path

    def load(self):
        path = self.root / "manifest.json"
        if not path.exists():
            raise HTTPException(404, "Public reference not installed")
        try:
            if self.root.is_symlink() or path.is_symlink() or path.stat().st_size > 65536:
                raise ValueError("Invalid reference manifest")
            raw = path.read_bytes()
            data = json.loads(raw)
            if not isinstance(data, dict) or data["schema_version"] != 1:
                raise ValueError("Unsupported reference manifest")
            if (
                data["case_label"] != "CMHA AHMU1218001"
                or data["source_url"] != SOURCE
                or data["license_url"] != LICENSE
            ):
                raise ValueError("Unexpected source")
            if data["source_header"]["xyzt_units"] != 0:
                raise ValueError("Unexpected unit declaration for this source")
            if not all(
                type(data["source_header"][key]) in (int, float)
                and math.isfinite(data["source_header"][key])
                for key in ("scl_slope", "scl_inter")
            ):
                raise ValueError("Non-finite source intensity scaling")
            if data["transform"] != {"matrix": MATRIX, "status": "candidate_image_consistent"}:
                raise ValueError("Unexpected reference transform")
            focus = data["focus_ras"]
            if (
                not isinstance(focus, list)
                or len(focus) != 3
                or not all(type(x) in (int, float) and math.isfinite(x) for x in focus)
            ):
                raise ValueError("Invalid focus")
            sources = data["source_sha256"]
            if set(sources) != {"cta", "aneurysm", "artery"} or not all(
                _sha(x) for x in sources.values()
            ):
                raise ValueError("Invalid source receipt")
            image = data["image"]
            if image["filename"] != "reference-cta.nii.gz" or not _sha(image["sha256"]):
                raise ValueError("Invalid image identity")
            paths = {"image": self._file(image["filename"], image["sha256"], 100 * 1024**2)}
            annotations = data["annotations"]
            if len(annotations) != 2 or {a["id"] for a in annotations} != {"aneurysm", "artery"}:
                raise ValueError("Invalid annotation set")
            for asset in annotations:
                if asset["filename"] != f"reference-{asset['id']}.stl" or not _sha(asset["sha256"]):
                    raise ValueError("Invalid annotation identity")
                if (
                    type(asset["triangle_count"]) is not int
                    or not 0 < asset["triangle_count"] <= 50000
                ):
                    raise ValueError("Invalid annotation size")
                paths[asset["id"]] = self._file(asset["filename"], asset["sha256"], 2 * 1024**2)
            return data, hashlib.sha256(raw).hexdigest(), paths
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise HTTPException(503, "Public reference assets failed integrity checks") from None

    def metadata(self, bundle, case_id: str | None = None):
        data, revision, _ = bundle
        result = {
            "case_label": "CMHA AHMU1218001",
            "source_url": SOURCE,
            "license_url": LICENSE,
            "citation": CITATION,
            "image_sha256": data["image"]["sha256"],
            "image_url": "/api/reference-volume",
            "reference_revision": revision,
            "spatial_units": "unknown",
            "alignment_status": "candidate_image_consistent",
            "method": "curated_dataset_annotation",
            "transform": MATRIX,
            "source_sha256": dict(data["source_sha256"]),
            "focus_ras": list(data["focus_ras"]),
        }
        if case_id is not None:
            result["case_id"] = case_id
            result["annotations"] = [
                {
                    "id": a["id"],
                    "sha256": a["sha256"],
                    "triangle_count": a["triangle_count"],
                    "url": f"/api/cases/{case_id}/reference/{revision}/{a['id']}.stl",
                }
                for a in data["annotations"]
            ]
        return result

    def optional_for_case(self, case):
        try:
            bundle = self.load()
        except HTTPException as exc:
            if exc.status_code in (404, 503):
                return None
            raise
        return (
            self.metadata(bundle, case["case_id"])
            if case["image_sha256"] == bundle[0]["image"]["sha256"]
            else None
        )


def register_reference_routes(app: FastAPI, store: ReferenceStore, read_case: Callable):
    @app.get("/api/reference")
    def reference_metadata():
        return store.metadata(store.load())

    @app.get("/api/reference-volume")
    def reference_volume():
        bundle = store.load()
        return FileResponse(
            bundle[2]["image"],
            media_type="application/octet-stream",
            filename="reference-cta.nii.gz",
        )

    def bound(case_id):
        case = read_case(case_id)
        bundle = store.load()
        if case["image_sha256"] != bundle[0]["image"]["sha256"]:
            raise HTTPException(404, "No reference for this image")
        return bundle

    @app.get("/api/cases/{case_id}/reference")
    def case_reference(case_id: str):
        return store.metadata(bound(case_id), case_id)

    @app.get("/api/cases/{case_id}/reference/{revision}/{asset_id}.stl")
    def reference_surface(case_id: str, revision: str, asset_id: Literal["aneurysm", "artery"]):
        bundle = bound(case_id)
        if revision != bundle[1]:
            raise HTTPException(409, "Reference revision changed")
        return FileResponse(
            bundle[2][asset_id],
            media_type="application/octet-stream",
            filename=f"reference-{asset_id}.stl",
        )
