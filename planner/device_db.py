"""Unified SQLite device catalog & multi-territory seed database.

Consolidates the idempotent SQLite device schema and seed catalog from
`seldinger-app/data/devices/build_seed_db.py`, `seldinger-app/apps/agent/devices.py`,
and `seldinger-ml/ml/seldinger_ml/devices/db.py` with the frontend 3D catalog
(`web/src/devices/catalog.json`).
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_CATALOG_PATH = REPO_ROOT / "web" / "src" / "devices" / "catalog.json"

CATEGORIES = (
    "flow_diverter",
    "intrasaccular",
    "neuro_stent",
    "coil",
    "thrombectomy",
    "carotid",
    "coronary_des",
    "tavr",
    "peripheral",
)

TERRITORIES = (
    "neurovascular",
    "coronary",
    "structural_heart",
    "peripheral_vascular",
)

CATEGORY_TO_TERRITORY = {
    "flow_diverter": "neurovascular",
    "intrasaccular": "neurovascular",
    "neuro_stent": "neurovascular",
    "coil": "neurovascular",
    "thrombectomy": "neurovascular",
    "carotid": "neurovascular",
    "coronary_des": "coronary",
    "tavr": "structural_heart",
    "peripheral": "peripheral_vascular",
}

FRONTEND_CATEGORY_MAP = {
    "flow-diverter": "flow_diverter",
    "intrasaccular": "intrasaccular",
    "coil": "coil",
}

SCHEMA_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS device_model (
  id                  TEXT PRIMARY KEY,
  dedup_key           TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  vendor              TEXT NOT NULL,
  vendor_norm         TEXT NOT NULL,
  category            TEXT NOT NULL,
  territory           TEXT NOT NULL,
  mechanism           TEXT DEFAULT '',
  sizing_basis        TEXT DEFAULT '',
  sizing_range_min_mm REAL,
  sizing_range_max_mm REAL,
  spec_json           TEXT DEFAULT '{}',
  delivery_json       TEXT DEFAULT '{}',
  regulatory_json     TEXT DEFAULT '{}',
  indications         TEXT DEFAULT '',
  status              TEXT DEFAULT 'active',
  source_hash         TEXT DEFAULT '',
  version             INTEGER DEFAULT 1,
  first_seen          TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_sku (
  di              TEXT PRIMARY KEY,
  model_id        TEXT NOT NULL REFERENCES device_model(id) ON DELETE CASCADE,
  catalog_number  TEXT,
  diameter_mm     REAL,
  length_mm       REAL,
  height_mm       REAL,
  secondary_shape TEXT,
  catheter_name   TEXT,
  min_catheter_id_in REAL,
  primary_diameter_mm REAL,
  source_hash     TEXT DEFAULT '',
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sku_model ON device_sku(model_id);

CREATE TABLE IF NOT EXISTS source_record (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  source_key   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  UNIQUE(source, source_key)
);
"""

# Supplemental category scaffolding. Only Neuroform identity is migrated from
# seldinger-app; other entries are explicitly non-product placeholders.
# No invented SKU, delivery or regulatory identifiers are seeded.
MULTI_TERRITORY_SUPPLEMENTAL_MODELS: tuple[dict[str, Any], ...] = (
    {
        "id": "neuroform-atlas",
        "name": "Neuroform Atlas",
        "vendor": "Stryker",
        "category": "neuro_stent",
        "territory": "neurovascular",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Migrated model identity from seldinger-app/apps/agent/devices.py; no current IFU or SKU verification.",
        },
        "skus": (),
    },
    {
        "id": "seed-thrombectomy",
        "name": "Thrombectomy device catalog placeholder",
        "vendor": "Unspecified",
        "category": "thrombectomy",
        "territory": "neurovascular",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Illustrative category placeholder, not a commercial product.",
        },
        "skus": (),
    },
    {
        "id": "seed-carotid",
        "name": "Carotid stent catalog placeholder",
        "vendor": "Unspecified",
        "category": "carotid",
        "territory": "neurovascular",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Illustrative category placeholder, not a commercial product.",
        },
        "skus": (),
    },
    {
        "id": "seed-coronary-des",
        "name": "Coronary DES catalog placeholder",
        "vendor": "Unspecified",
        "category": "coronary_des",
        "territory": "coronary",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Illustrative category placeholder, not a commercial product.",
        },
        "skus": (),
    },
    {
        "id": "seed-tavr",
        "name": "TAVR catalog placeholder",
        "vendor": "Unspecified",
        "category": "tavr",
        "territory": "structural_heart",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Illustrative category placeholder, not a commercial product.",
        },
        "skus": (),
    },
    {
        "id": "seed-peripheral",
        "name": "Peripheral device catalog placeholder",
        "vendor": "Unspecified",
        "category": "peripheral",
        "territory": "peripheral_vascular",
        "status": "unverified_seed",
        "regulatory": {
            "verification": "not_verified",
            "note": "Illustrative category placeholder, not a commercial product.",
        },
        "skus": (),
    },
)


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (s or "").lower()).strip("_")


def content_hash(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, ensure_ascii=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def dedup_key(vendor: str, model_name: str, category: str = "") -> str:
    raw = f"{norm(vendor)}|{norm(model_name)}|{norm(category)}"
    return hashlib.sha1(raw.encode()).hexdigest()


def connect(db_path: Path | str = ":memory:") -> sqlite3.Connection:
    if db_path != ":memory:":
        path = Path(db_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path))
    else:
        conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    return conn


def load_frontend_catalog(path: Path | None = None) -> dict[str, Any]:
    target = path or FRONTEND_CATALOG_PATH
    return json.loads(target.read_text(encoding="utf-8"))


def upsert_model(conn: sqlite3.Connection, model: dict[str, Any]) -> tuple[str, bool]:
    model_id = model.get("id") or norm(model["name"])
    category = model["category"]
    if category not in CATEGORY_TO_TERRITORY:
        raise ValueError("Unknown device category")
    territory = model.get("territory") or CATEGORY_TO_TERRITORY[category]
    if territory not in TERRITORIES:
        raise ValueError("Unknown device territory")
    dkey = dedup_key(model["vendor"], model["name"], category)
    payload = {
        "id": model_id,
        "name": model["name"],
        "vendor": model["vendor"],
        "category": category,
        "territory": territory,
        "mechanism": model.get("mechanism", ""),
        "sizing_basis": model.get("sizing_basis", ""),
        "sizing_range_min_mm": model.get("sizing_range_min_mm"),
        "sizing_range_max_mm": model.get("sizing_range_max_mm"),
        "spec": model.get("spec", {}),
        "delivery": model.get("delivery", {}),
        "regulatory": model.get("regulatory", {}),
        "indications": model.get("indications", ""),
        "status": model.get("status", "active"),
    }
    shash = content_hash(payload)
    matches = conn.execute(
        "SELECT id, dedup_key, source_hash, version FROM device_model WHERE dedup_key=? OR id=?",
        (dkey, model_id),
    ).fetchall()
    if len(matches) > 1 or any(
        row["id"] != model_id or row["dedup_key"] != dkey for row in matches
    ):
        raise ValueError("Device model identity collision")
    existing = matches[0] if matches else None
    now = _now_iso()
    if existing and existing["source_hash"] == shash:
        conn.execute("UPDATE device_model SET last_seen=? WHERE id=?", (now, existing["id"]))
        conn.commit()
        return existing["id"], False

    if existing:
        model_id = existing["id"]
        conn.execute(
            """UPDATE device_model SET
               name=?, vendor=?, vendor_norm=?, category=?, territory=?, mechanism=?,
               sizing_basis=?, sizing_range_min_mm=?, sizing_range_max_mm=?,
               spec_json=?, delivery_json=?, regulatory_json=?, indications=?,
               status=?, source_hash=?, version=?, last_seen=?
               WHERE id=?""",
            (
                payload["name"],
                payload["vendor"],
                norm(payload["vendor"]),
                payload["category"],
                payload["territory"],
                payload["mechanism"],
                payload["sizing_basis"],
                payload["sizing_range_min_mm"],
                payload["sizing_range_max_mm"],
                json.dumps(payload["spec"], sort_keys=True),
                json.dumps(payload["delivery"], sort_keys=True),
                json.dumps(payload["regulatory"], sort_keys=True),
                payload["indications"],
                payload["status"],
                shash,
                existing["version"] + 1,
                now,
                model_id,
            ),
        )
    else:
        conn.execute(
            """INSERT INTO device_model (
               id, dedup_key, name, vendor, vendor_norm, category, territory, mechanism,
               sizing_basis, sizing_range_min_mm, sizing_range_max_mm,
               spec_json, delivery_json, regulatory_json, indications, status,
               source_hash, version, first_seen, last_seen
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
            (
                model_id,
                dkey,
                payload["name"],
                payload["vendor"],
                norm(payload["vendor"]),
                payload["category"],
                payload["territory"],
                payload["mechanism"],
                payload["sizing_basis"],
                payload["sizing_range_min_mm"],
                payload["sizing_range_max_mm"],
                json.dumps(payload["spec"], sort_keys=True),
                json.dumps(payload["delivery"], sort_keys=True),
                json.dumps(payload["regulatory"], sort_keys=True),
                payload["indications"],
                payload["status"],
                shash,
                now,
                now,
            ),
        )
    conn.commit()
    return model_id, True


def upsert_sku(conn: sqlite3.Connection, sku: dict[str, Any]) -> bool:
    di = (
        sku.get("di")
        or f"{sku['model_id']}:{sku.get('catalog_number') or sku.get('sku') or ''}:{sku.get('diameter_mm')}:{sku.get('length_mm')}:{sku.get('height_mm')}"
    )
    shash = content_hash(sku)
    row = conn.execute("SELECT model_id, source_hash FROM device_sku WHERE di=?", (di,)).fetchone()
    if row and row["model_id"] != sku["model_id"]:
        raise ValueError("Device SKU identity collision")
    now = _now_iso()
    if row and row["source_hash"] == shash:
        conn.execute("UPDATE device_sku SET last_seen=? WHERE di=?", (now, di))
        return False
    conn.execute(
        """INSERT INTO device_sku (
             di, model_id, catalog_number, diameter_mm, length_mm, height_mm,
             secondary_shape, catheter_name, min_catheter_id_in, primary_diameter_mm,
             source_hash, last_seen
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(di) DO UPDATE SET
             catalog_number=excluded.catalog_number,
             diameter_mm=excluded.diameter_mm,
             length_mm=excluded.length_mm,
             height_mm=excluded.height_mm,
             secondary_shape=excluded.secondary_shape,
             catheter_name=excluded.catheter_name,
             min_catheter_id_in=excluded.min_catheter_id_in,
             primary_diameter_mm=excluded.primary_diameter_mm,
             source_hash=excluded.source_hash,
             last_seen=excluded.last_seen""",
        (
            di,
            sku["model_id"],
            sku.get("catalog_number") or sku.get("sku"),
            sku.get("diameter_mm"),
            sku.get("length_mm"),
            sku.get("height_mm"),
            sku.get("secondary_shape"),
            sku.get("catheter_name") or sku.get("catheter"),
            sku.get("min_catheter_id_in")
            if sku.get("min_catheter_id_in") is not None
            else sku.get("minimumIdInch"),
            sku.get("primary_diameter_mm")
            if sku.get("primary_diameter_mm") is not None
            else sku.get("primaryDiameterMm"),
            shash,
            now,
        ),
    )
    return True


def seed_default_catalog(
    conn: sqlite3.Connection, *, frontend_path: Path | None = None
) -> dict[str, int]:
    """Idempotently seed all frontend 3D catalog devices and multi-territory models."""
    frontend = load_frontend_catalog(frontend_path)
    models_total = 0
    models_changed = 0
    skus_total = 0
    skus_changed = 0

    for dev in frontend.get("devices", []):
        # Snapshot the actual local listing and its evidence limits. fetched_at
        # means read locally, never independently reverified against an IFU.
        conn.execute(
            "INSERT INTO source_record(source,source_key,payload_json,content_hash,fetched_at) "
            "VALUES ('frontend_catalog',?,?,?,?) ON CONFLICT(source,source_key) DO UPDATE SET "
            "payload_json=excluded.payload_json,content_hash=excluded.content_hash,fetched_at=excluded.fetched_at",
            (dev["id"], json.dumps(dev, sort_keys=True), content_hash(dev), _now_iso()),
        )
        raw_cat = str(dev.get("category") or "")
        cat = FRONTEND_CATEGORY_MAP.get(raw_cat, raw_cat)
        sizes = dev.get("sizes", [])
        diameters = [s["diameterMm"] for s in sizes if s.get("diameterMm") is not None]
        status = "recalled" if "RECALLED" in (dev.get("usStatus") or "").upper() else "active"
        model_payload = {
            "id": dev["id"],
            "name": dev["name"],
            "vendor": dev["manufacturer"],
            "category": cat,
            "territory": CATEGORY_TO_TERRITORY[cat],
            "mechanism": dev.get("construction", ""),
            "sizing_basis": (
                "parent_vessel_diameter"
                if cat == "flow_diverter"
                else "aneurysm_sac_width_and_height"
                if cat == "intrasaccular"
                else "aneurysm_sac_diameter"
            ),
            "sizing_range_min_mm": min(diameters) if diameters else None,
            "sizing_range_max_mm": max(diameters) if diameters else None,
            "spec": {
                "shape": dev.get("shape"),
                "wireCount": dev.get("wireCount"),
                "displayWireCount": dev.get("displayWireCount"),
                "primaryDiameterMm": dev.get("primaryDiameterMm"),
                "appearance": dev.get("appearance"),
                "modelLimits": dev.get("modelLimits"),
                "sizeCoverage": dev.get("sizeCoverage"),
            },
            "delivery": {},
            "regulatory": {
                "us_status": dev.get("usStatus"),
                "warning": dev.get("warning"),
                "sources": dev.get("sources", []),
            },
            "indications": dev.get("construction", ""),
            "status": status,
        }
        model_id, changed = upsert_model(conn, model_payload)
        models_total += 1
        if changed:
            models_changed += 1
        for s in sizes:
            sku_changed = upsert_sku(
                conn,
                {
                    "model_id": model_id,
                    "catalog_number": s.get("sku"),
                    "diameter_mm": s.get("diameterMm"),
                    "length_mm": s.get("lengthMm"),
                    "height_mm": s.get("heightMm"),
                    "catheter_name": s.get("catheter"),
                    "min_catheter_id_in": s.get("minimumIdInch"),
                    "primary_diameter_mm": s.get("primaryDiameterMm")
                    if s.get("primaryDiameterMm") is not None
                    else dev.get("primaryDiameterMm"),
                },
            )
            skus_total += 1
            if sku_changed:
                skus_changed += 1

    for supp in MULTI_TERRITORY_SUPPLEMENTAL_MODELS:
        model_id, changed = upsert_model(conn, supp)
        models_total += 1
        if changed:
            models_changed += 1
        for s in supp.get("skus", ()):
            sku_changed = upsert_sku(
                conn,
                {
                    "model_id": model_id,
                    "catalog_number": s.get("sku"),
                    "diameter_mm": s.get("diameter_mm"),
                    "length_mm": s.get("length_mm"),
                    "height_mm": s.get("height_mm"),
                    "catheter_name": s.get("catheter"),
                    "min_catheter_id_in": s.get("min_catheter_id_in"),
                    "primary_diameter_mm": s.get("primary_diameter_mm"),
                },
            )
            skus_total += 1
            if sku_changed:
                skus_changed += 1

    conn.commit()
    return {
        "models_total": models_total,
        "models_changed": models_changed,
        "skus_total": skus_total,
        "skus_changed": skus_changed,
    }


def query_devices(
    conn: sqlite3.Connection,
    *,
    territory: str | None = None,
    category: str | None = None,
    model_id: str | None = None,
    include_recalled: bool = False,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if territory is not None:
        clauses.append("territory = ?")
        params.append(territory)
    if category is not None:
        clauses.append("category = ?")
        params.append(category)
    if model_id is not None:
        clauses.append("id = ?")
        params.append(model_id)
    if not include_recalled and model_id is None:
        clauses.append("status != 'recalled'")

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM device_model {where} ORDER BY territory, category, name",
        params,
    ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        skus = conn.execute(
            """SELECT di, catalog_number, diameter_mm, length_mm, height_mm,
                      catheter_name, min_catheter_id_in, primary_diameter_mm
               FROM device_sku WHERE model_id=?
               ORDER BY diameter_mm, COALESCE(length_mm, height_mm, 0), catalog_number""",
            (row["id"],),
        ).fetchall()
        results.append(
            {
                "id": row["id"],
                "name": row["name"],
                "vendor": row["vendor"],
                "category": row["category"],
                "territory": row["territory"],
                "mechanism": row["mechanism"],
                "sizing_basis": row["sizing_basis"],
                "sizing_range_min_mm": row["sizing_range_min_mm"],
                "sizing_range_max_mm": row["sizing_range_max_mm"],
                "spec": json.loads(row["spec_json"] or "{}"),
                "delivery": json.loads(row["delivery_json"] or "{}"),
                "regulatory": json.loads(row["regulatory_json"] or "{}"),
                "indications": row["indications"],
                "status": row["status"],
                "skus": [dict(s) for s in skus],
            }
        )
    return results
