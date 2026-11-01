"""Public Zenodo 15697196 morphology references, not device-sizing inputs.

Keep original identifiers and measured-column semantics. Expert STL annotations
are not native voxel truth until their coordinate frame/registration is checked.
No network, model loading or application-state mutation occurs here.
"""

import argparse
import copy
import csv
import hashlib
import io
import json
import math
import re
from pathlib import Path

SOURCE_URL = "https://zenodo.org/records/15697196"
VERSION = "zenodo-15697196-reference-cohort-v1"
HEADER = (
    "ID",
    "IA(0/№_?)",
    "Sex",
    "Age, years",
    "Artery",
    "Saccular (0/1)",
    "Position",
    "Type",
    "Size",
    "Neck, mm",
    "Length, mm",
    "Width, mm",
    "Vobject, mm3",
    "Rupture (0/1)",
    "Bleb (0/1)",
    "Thrombus (0/1)",
    "Vessel (0/1)",
    "Calcification (0/1)",
    "Images count",
    "Slice Thickness, mm",
    "Head+Neck (0/1)",
    "",
    "",
)
MEASUREMENT_COLUMNS = {
    "neck_mm": "Neck, mm",
    "length_mm": "Length, mm",
    "width_mm": "Width, mm",
    "volume_mm3": "Vobject, mm3",
}


def _number(token):
    if token == "NA":
        return None
    if not re.fullmatch(r"[0-9]+(?:[,.][0-9]+)?", token):
        raise ValueError("Invalid published measurement")
    value = float(token.replace(",", "."))
    if not math.isfinite(value) or not 0 < value <= 1e9:
        raise ValueError("Invalid published measurement")
    return value


def normalize_reference_csv(raw: bytes) -> list[dict]:
    """Project exact source columns, omitting demographics and clinical history."""
    if not isinstance(raw, bytes) or not 0 < len(raw) <= 1024 * 1024:
        raise ValueError("Reference CSV exceeds the byte cap")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("cp1251")
    reader = csv.reader(io.StringIO(text), delimiter=";", strict=True)
    try:
        if tuple(next(reader)) != HEADER:
            raise ValueError("Unexpected reference CSV schema")
    except StopIteration as exc:
        raise ValueError("Reference CSV is empty") from exc
    grouped = {}
    for line, values in enumerate(reader, start=2):
        if line > 10001 or len(values) != len(HEADER) or any(values[-2:]):
            raise ValueError("Unexpected reference row width/content")
        row: dict[str, str] = dict(zip(HEADER, values, strict=True))
        case_id = row["ID"]
        token = row["IA(0/№_?)"]
        if not re.fullmatch(r"[0-9]{3}", case_id):
            raise ValueError("Invalid source case ID")
        if token == "0":
            index, total = 0, 0
        else:
            match = re.fullmatch(r"([1-9][0-9]*)_([1-9][0-9]*)", token)
            if not match:
                raise ValueError("Invalid source lesion token")
            index, total = map(int, match.groups())
            if not 1 <= index <= total <= 32:
                raise ValueError("Invalid source lesion count")
        image_token = row["Images count"]
        if image_token == "n/a":
            image_count = None
        elif re.fullmatch(r"[1-9][0-9]{0,5}", image_token):
            image_count = int(image_token)
        else:
            raise ValueError("Invalid published image count")
        shape = row["Saccular (0/1)"]
        if shape not in {"0", "1", "NA"}:
            raise ValueError("Invalid published saccular flag")
        if row["Position"] not in {"NA", "lateral", "bifurcation"}:
            raise ValueError("Invalid published position")
        if row["Size"] not in {"NA", "miliary", "middle", "large", "giant"}:
            raise ValueError("Invalid published size class")
        if row["Type"] not in {
            "NA",
            "blister-like",
            "eccentric-fusiform",
            "fusiform",
            "fusiform-saccular",
        }:
            raise ValueError("Invalid published morphology type")
        tokens = {key: row[column] for key, column in MEASUREMENT_COLUMNS.items()}
        measured = {key: _number(value) for key, value in tokens.items()}
        if total == 0 and (
            any(value is not None for value in measured.values())
            or shape != "NA"
            or any(row[k] != "NA" for k in ["Position", "Size", "Type"])
        ):
            raise ValueError("Negative case contains aneurysm annotations")
        case = grouped.setdefault(
            case_id,
            {
                "case_id": case_id,
                "case_annotation": "aneurysm_present" if total else "aneurysm_absent",
                "published_image_count": image_count,
                "lesions": [],
                "_total": total,
                "_indices": set(),
            },
        )
        if case["_total"] != total or index in case["_indices"]:
            raise ValueError("Inconsistent or duplicate case/lesion group")
        case["_indices"].add(index)
        if image_count is not None:
            if case["published_image_count"] not in (None, image_count):
                raise ValueError("Conflicting published series counts")
            case["published_image_count"] = image_count
        if total:
            suffix = "" if total == 1 else f"_{index}"
            case["lesions"].append(
                {
                    "source_row": line,
                    "source_lesion_token": token,
                    "stl_member": f"Annotations/an_{case_id}{suffix}.stl",
                    "saccular": None if shape == "NA" else shape == "1",
                    "position": row["Position"],
                    "morphology_type": row["Type"],
                    "size_class": row["Size"],
                    "published_measurements": measured,
                    "measurement_tokens": tokens,
                }
            )
    if not grouped:
        raise ValueError("Reference CSV has no cases")
    for case in grouped.values():
        total = case.pop("_total")
        indices = case.pop("_indices")
        if total and indices != set(range(1, total + 1)):
            raise ValueError("Incomplete source lesion group")
    return list(grouped.values())


def bind_archive_members(cases: list[dict], members: list[dict]) -> list[dict]:
    """Bind case/lesion identities, not mesh-to-image spatial correspondence."""
    exact = {}
    series = {}
    for member in members:
        name = member["member"]
        if name in exact:
            raise ValueError("Duplicate archive member")
        exact[name] = member
        match = re.fullmatch(r"Studies/([0-9]{3})/[^/]+\.dcm", name)
        if match:
            series.setdefault(match[1], []).append(member)
    result = copy.deepcopy(cases)
    for case in result:
        dicoms = series.get(case["case_id"], [])
        if not dicoms or (
            case["published_image_count"] is not None
            and len(dicoms) != case["published_image_count"]
        ):
            raise ValueError("Missing or inconsistent DICOM series members")
        for lesion in case["lesions"]:
            if lesion["stl_member"] not in exact:
                raise ValueError("Missing exact expert annotation member")
        for member in dicoms + [exact[r["stl_member"]] for r in case["lesions"]]:
            if any(
                type(member[k]) is not int or member[k] <= 0
                for k in ["compressed_bytes", "uncompressed_bytes"]
            ):
                raise ValueError("Invalid archive member size")
        case["archive_series"] = {
            "member_prefix": f"Studies/{case['case_id']}/",
            "dicom_count": len(dicoms),
            "compressed_bytes": sum(r["compressed_bytes"] for r in dicoms),
            "uncompressed_bytes": sum(r["uncompressed_bytes"] for r in dicoms),
        }
        case["voxel_labels_ready"] = False
        case["training_overlap"] = "unknown"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, required=True)
    parser.add_argument("--zip-index", type=Path, required=True)
    parser.add_argument("--expected-metadata-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if (
        args.metadata.stat().st_size > 1024 * 1024
        or args.zip_index.stat().st_size > 64 * 1024 * 1024
    ):
        raise ValueError("Source metadata exceeds the file byte cap")
    raw = args.metadata.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if (
        not re.fullmatch(r"[0-9a-f]{64}", args.expected_metadata_sha256)
        or digest != args.expected_metadata_sha256
    ):
        raise ValueError("Reference metadata hash mismatch")
    index_raw = args.zip_index.read_bytes()
    cases = bind_archive_members(normalize_reference_csv(raw), json.loads(index_raw))
    lesions = [lesion for case in cases for lesion in case["lesions"]]
    report = {
        "artifact_version": VERSION,
        "source_url": SOURCE_URL,
        "license": "CC-BY-4.0",
        "metadata_sha256": digest,
        "zip_index_sha256": hashlib.sha256(index_raw).hexdigest(),
        "clinical_validation": False,
        "independent_heldout": False,
        "measurement_semantics": "publisher_columns_not_device_inputs",
        "summary": {
            "cases": len(cases),
            "aneurysm_positive_cases": sum(bool(c["lesions"]) for c in cases),
            "aneurysm_negative_cases": sum(not c["lesions"] for c in cases),
            "aneurysms": len(lesions),
            "aneurysms_with_neck_measurement": sum(
                r["published_measurements"]["neck_mm"] is not None for r in lesions
            ),
            "exact_stl_members_bound": len(lesions),
        },
        "cases": cases,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps(report["summary"], indent=2))


if __name__ == "__main__":
    main()
