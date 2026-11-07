"""Server-owned image-source selection, separate from curated annotations.

The providers' identities and paths are trusted configuration, never request
inputs. Older source packages stay available for their own case histories.
"""

import json
import math
import re
from pathlib import Path

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
_SOURCE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")


class ImageSourceRegistry:
    def __init__(
        self,
        references,
        calibrated_store=None,
        planning_store=None,
        installed_sources_root: Path | None = None,
    ):
        self.references = references
        self._calibrated = calibrated_store
        self._planning = planning_store
        self._installed_root = installed_sources_root

    def installed_root(self) -> Path:
        if self._installed_root is None:
            from planner.image_source import INSTALLED_SOURCES_ROOT

            self._installed_root = INSTALLED_SOURCES_ROOT
        return self._installed_root

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

    def _installed_provider(self, source_id: str):
        if not isinstance(source_id, str) or not _SOURCE_ID_RE.fullmatch(source_id):
            return None
        root = self.installed_root() / source_id
        if root.is_symlink() or not (root / "manifest.json").is_file():
            return None
        from planner.image_source import InstalledNiftiSourceStore

        return InstalledNiftiSourceStore(root, source_id=source_id)

    def find_installed_source_by_hash(self, image_sha256: str) -> str | None:
        if source_id := IMAGE_ONLY_HASHES.get(image_sha256):
            return source_id
        root = self.installed_root()
        if root.is_symlink() or not root.is_dir():
            return None
        matches = []
        for child in sorted(root.iterdir()):
            if not child.is_dir() or child.is_symlink() or not _SOURCE_ID_RE.fullmatch(child.name):
                continue
            manifest_path = child / "manifest.json"
            if not manifest_path.is_file() or manifest_path.is_symlink():
                continue
            try:
                from planner.image_source import MAX_MANIFEST_BYTES

                with manifest_path.open("rb") as stream:
                    raw = stream.read(MAX_MANIFEST_BYTES + 1)
                if len(raw) > MAX_MANIFEST_BYTES:
                    continue
                manifest = json.loads(raw)
            except (OSError, ValueError):
                continue
            image = manifest.get("image") if isinstance(manifest, dict) else None
            if isinstance(image, dict) and image.get("sha256") == image_sha256:
                matches.append(child.name)
        if len(matches) > 1:
            raise HTTPException(503, "Installed image source identity is ambiguous")
        return matches[0] if matches else None

    def provider(self, source_id):
        if source_id == CALIBRATED_SOURCE_ID:
            return self.calibrated()
        if source_id == PLANNING_SOURCE_ID:
            return self.planning()
        if custom := self._installed_provider(source_id):
            return custom
        raise HTTPException(404, "Unknown installed image source")

    def load_public(self, source_id):
        try:
            provider = self.provider(source_id)
            bundle = provider.load()
            if source_id in (CALIBRATED_SOURCE_ID, PLANNING_SOURCE_ID):
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
        source_id = self.find_installed_source_by_hash(case["image_sha256"])
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
        source_id = self.find_installed_source_by_hash(case["image_sha256"])
        if source_id is None:
            raise HTTPException(404, "No calibrated image source for this case")
        bundle = self.load_for_case(case)
        return self.provider(source_id).metadata(bundle, case["case_id"])


def register_image_source_routes(app, sources, read_case):
    @app.get("/api/image-sources/{source_id}")
    def metadata(source_id: str):
        bundle = sources.load_public(source_id)
        return sources.provider(source_id).metadata(bundle)

    @app.get("/api/image-sources/{source_id}/volume")
    def volume(source_id: str):
        bundle = sources.load_public(source_id)
        return FileResponse(
            bundle[2]["image"],
            media_type="application/octet-stream",
            filename=bundle[2]["image"].name,
        )

    @app.get("/api/cases/{case_id}/image-source")
    def case_source(case_id: str):
        return sources.calibrated_metadata_for_case(read_case(case_id))
