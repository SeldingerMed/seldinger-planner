"""Server-owned image-source selection, separate from curated annotations.

The providers' identities and paths are trusted configuration, never request
inputs. Older source packages stay available for their own case histories.
"""

import math
from typing import Literal

from fastapi import HTTPException
from fastapi.responses import FileResponse

CALIBRATED_SOURCE_ID = "zenodo-case006-calibrated"
CALIBRATED_IMAGE_SHA256 = "88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3"
PLANNING_SOURCE_ID = "zenodo-case006-planning-context"
PLANNING_IMAGE_SHA256 = "26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473"
IMAGE_ONLY_HASHES = {
    CALIBRATED_IMAGE_SHA256: CALIBRATED_SOURCE_ID,
    PLANNING_IMAGE_SHA256: PLANNING_SOURCE_ID,
}
CURATED_SOURCE_ID = "cmha-ahmu1218001-context"


class ImageSourceRegistry:
    def __init__(self, references, calibrated_store=None, planning_store=None):
        self.references = references
        self._calibrated = calibrated_store
        self._planning = planning_store

    def calibrated(self):
        if self._calibrated is None:
            from planner.image_source import CalibratedSourceStore

            self._calibrated = CalibratedSourceStore()
        return self._calibrated

    def planning(self):
        if self._planning is None:
            from planner.image_source import PlanningSourceStore

            self._planning = PlanningSourceStore()
        return self._planning

    def provider(self, source_id):
        if source_id == CALIBRATED_SOURCE_ID:
            return self.calibrated()
        if source_id == PLANNING_SOURCE_ID:
            return self.planning()
        raise HTTPException(404, "Unknown installed image source")

    def load_public(self, source_id):
        try:
            bundle = self.provider(source_id).load()
            expected = (
                CALIBRATED_IMAGE_SHA256
                if source_id == CALIBRATED_SOURCE_ID
                else PLANNING_IMAGE_SHA256
            )
            if bundle[0]["image"]["sha256"] != expected:
                raise ValueError("Unexpected registered image identity")
            return bundle
        except FileNotFoundError:
            raise HTTPException(404, "Calibrated public image not installed") from None
        except (OSError, ValueError, TypeError, KeyError):
            raise HTTPException(503, "Calibrated public image failed integrity checks") from None

    def load_calibrated(self):
        return self.load_public(CALIBRATED_SOURCE_ID)

    def load_for_case(self, case):
        source_id = IMAGE_ONLY_HASHES.get(case["image_sha256"])
        image_only = source_id is not None
        bundle = self.load_public(source_id) if image_only else self.references.load()
        data, revision, paths = bundle
        if case["image_sha256"] != data["image"]["sha256"]:
            raise HTTPException(404, "No reference-bound installed image source for this case")
        units = "mm" if image_only else "unknown"
        if not image_only and data.get("source_header", {}).get("xyzt_units") != 0:
            raise HTTPException(503, "Public reference assets failed integrity checks")
        if case.get("spatial_units") != units:
            raise HTTPException(409, "Case units do not match the installed image source")
        if case.get("dimensions") != data["crop"]["size_voxels"]:
            raise HTTPException(409, "Case dimensions do not match the installed source")
        if image_only:
            affine = data["image"]["affine_ras"]
            spacing = [
                math.sqrt(sum(affine[row][col] ** 2 for row in range(3))) for col in range(3)
            ]
            declared = case.get("spacing_mm", [])
            if len(declared) != 3 or any(
                not math.isclose(actual, expected, rel_tol=1e-6, abs_tol=1e-7)
                for actual, expected in zip(declared, spacing, strict=True)
            ):
                raise HTTPException(409, "Case spacing does not match the calibrated image")
        return (
            {**data, "source_id": source_id or CURATED_SOURCE_ID, "spatial_units": units},
            revision,
            paths,
        )

    def calibrated_metadata_for_case(self, case):
        source_id = IMAGE_ONLY_HASHES.get(case["image_sha256"])
        if source_id is None:
            raise HTTPException(404, "No calibrated image source for this case")
        bundle = self.load_for_case(case)
        return self.provider(source_id).metadata(bundle, case["case_id"])


def register_image_source_routes(app, sources, read_case):
    @app.get("/api/image-sources/{source_id}")
    def metadata(
        source_id: Literal["zenodo-case006-calibrated", "zenodo-case006-planning-context"],
    ):
        bundle = sources.load_public(source_id)
        return sources.provider(source_id).metadata(bundle)

    @app.get("/api/image-sources/{source_id}/volume")
    def volume(source_id: Literal["zenodo-case006-calibrated", "zenodo-case006-planning-context"]):
        bundle = sources.load_public(source_id)
        return FileResponse(
            bundle[2]["image"], media_type="application/octet-stream", filename="context-cta.nii.gz"
        )

    @app.get("/api/cases/{case_id}/image-source")
    def case_source(case_id: str):
        return sources.calibrated_metadata_for_case(read_case(case_id))
