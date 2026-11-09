"""Device-scenario catalogue identity over sizing rules and the authored catalogue.

The historical sizing catalogue alone does not bind the procedural device
rendering: web/src/devices/catalog.json carries the authored visual catalogue
that DeviceStudio renders. Scenario identity therefore hashes a canonical
combination of both, and exposes the authored renderer metadata so the
frontend can hash-check the same bytes before saving. This module performs no
clinical validation, no sizing inference, and transforms no catalogue values.
"""

import hashlib
import json
import os
import stat
from pathlib import Path

from planner.device_checks import DeviceCheckError, device_catalog, encoded

PROCEDURAL_MODEL_VERSION = "procedural-device-v2"
AUTHORED_CATALOG_PATH = (
    Path(__file__).resolve().parents[1] / "web" / "src" / "devices" / "catalog.json"
)
_MAX_AUTHORED_BYTES = 1024 * 1024


def authored_catalog_path():
    return AUTHORED_CATALOG_PATH


def _load_authored_catalog():
    """Bounded, nonsymlink, regular-file read of the repo-owned catalogue."""
    path = AUTHORED_CATALOG_PATH
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        raise DeviceCheckError("Authored device catalogue is unreadable") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_AUTHORED_BYTES:
            raise DeviceCheckError("Authored device catalogue is not a bounded file")
        raw = os.read(fd, info.st_size + 1)
    finally:
        os.close(fd)
    if len(raw) != info.st_size:
        raise DeviceCheckError("Authored device catalogue changed during read")
    try:
        data = json.loads(
            raw.decode("utf-8"),
            parse_constant=lambda token: (_ for _ in ()).throw(
                ValueError(f"Non-finite JSON constant {token}")
            ),
        )
    except (ValueError, UnicodeDecodeError) as error:
        raise DeviceCheckError("Authored device catalogue is not finite JSON") from error
    if not isinstance(data, dict) or not isinstance(data.get("catalogVersion"), str):
        raise DeviceCheckError("Authored device catalogue lacks a version string")
    devices = data.get("devices")
    if not isinstance(devices, list):
        raise DeviceCheckError("Authored device catalogue lacks devices")
    identifiers = set()
    for device in devices:
        if not isinstance(device, dict) or not isinstance(device.get("id"), str):
            raise DeviceCheckError("Authored device row lacks an identifier")
        if device["id"] in identifiers:
            raise DeviceCheckError("Authored device identifiers are not unique")
        identifiers.add(device["id"])
    return raw, data


def scenario_catalog():
    """Sizing rules plus the exact authored catalogue under one canonical hash."""
    base = device_catalog()
    base.pop("catalog_version")
    raw, authored = _load_authored_catalog()
    source_sha256 = hashlib.sha256(raw).hexdigest()
    data = {
        **base,
        "procedural_model_version": PROCEDURAL_MODEL_VERSION,
        "authored_catalog": {
            "catalog_version": authored["catalogVersion"],
            "source_sha256": source_sha256,
            "devices": authored["devices"],
        },
        "visualization": {
            "catalog_version": authored["catalogVersion"],
            "source_sha256": source_sha256,
            "procedural_model_version": PROCEDURAL_MODEL_VERSION,
        },
    }
    digest = hashlib.sha256(encoded(data).encode()).hexdigest()
    # Return an independent object; callers cannot mutate module state.
    return {**json.loads(encoded(data)), "catalog_version": digest}
