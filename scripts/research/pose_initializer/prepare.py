"""Prepare vessel models from the public artery masks on external storage.

Reads the pooled case list, keeps the cases of one source that carry a
whole-brain binary vessel mask, and writes one vessel model per case plus a
manifest of sources, licences and the split. Nothing is written inside the
repository.

  PYTHONPATH=scripts/research <python> -m pose_initializer.prepare \
      --pooled <pooled dataset dir> --out <dir on the external volume>

The split is fixed here and nowhere else: the source's own test cases are
held out for the synthetic gate, every eighth training case in name order is
kept for choosing a checkpoint, and the rest train the network.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

from . import provenance, storage, vessels

SOURCE = "costa"
SOURCE_RECORD = "COSTA TOF-MRA vessel masks, Zenodo record 11025761"
VALIDATION_EVERY = 8


def split_of(cases: list[dict]) -> dict[str, str]:
    """``held_out``, ``validation`` or ``training`` for every case id."""
    chosen: dict[str, str] = {}
    training = []
    for case in sorted(cases, key=lambda item: item["case_id"]):
        found = re.search(r"split=(\w+)", case.get("notes", ""))
        if found is None or found.group(1) not in ("Tr", "Ts"):
            raise ValueError(f"Case {case['case_id']} does not say which split it is in")
        if found.group(1) == "Ts":
            chosen[case["case_id"]] = "held_out"
        else:
            training.append(case["case_id"])
    for position, case_id in enumerate(training):
        last = position % VALIDATION_EVERY == VALIDATION_EVERY - 1
        chosen[case_id] = "validation" if last else "training"
    return chosen


def subject_of(case_id: str) -> str:
    """The part of a case id that names the scanned person."""
    return case_id.split("__", 1)[-1].lower()


def prepare(pooled: Path, out: Path) -> dict:
    import nibabel

    root = storage.external_directory(out)
    models = root / "models"
    models.mkdir(exist_ok=True)
    rows = [json.loads(line) for line in (pooled / "cases.jsonl").read_text().splitlines() if line]
    cases = [
        row for row in rows if row.get("source") == SOURCE and "vessel" in (row.get("labels") or {})
    ]
    subjects = [subject_of(case["case_id"]) for case in cases]
    if len(set(subjects)) != len(subjects):
        raise ValueError("A subject appears more than once; the split would leak")
    split = split_of(cases)
    entries = []
    for number, case in enumerate(sorted(cases, key=lambda item: item["case_id"])):
        source = pooled / case["labels"]["vessel"]
        entry = {
            "case_id": case["case_id"],
            "split": split[case["case_id"]],
            "license": case["license"],
            "notes": case.get("notes"),
            "source_file": case["labels"]["vessel"],
            "source_sha256": provenance.file_sha256(source),
        }
        try:
            image = nibabel.load(source)
            model = vessels.vessel_model(np.asarray(image.dataobj), image.affine)
        except vessels.VesselError as error:
            entry["skipped"] = str(error)
        else:
            target = models / f"{case['case_id']}.npz"
            partial = target.with_name(target.name + ".partial")
            with partial.open("wb") as handle:
                np.savez_compressed(handle, **model)
            partial.replace(target)
            entry.update(
                model_file=f"models/{target.name}",
                model_sha256=provenance.file_sha256(target),
                voxels=len(model["points"]),
                inlets=len(model["inlets"]),
                inlet_shares=[
                    round(float((model["cell"] == inlet).mean()), 4) for inlet in model["inlets"]
                ],
            )
        entries.append(entry)
        print(
            f"{number + 1}/{len(cases)} {case['case_id']} {entry.get('skipped', 'ok')}", flush=True
        )
    kept = [entry for entry in entries if "skipped" not in entry]
    manifest = {
        "source": SOURCE_RECORD,
        "pooled_case_list_sha256": provenance.file_sha256(pooled / "cases.jsonl"),
        "code": provenance.code_state(),
        "settings": {
            "slab_mm": vessels.SLAB_MM,
            "merge_mm": vessels.MERGE_MM,
            "min_piece_share": vessels.MIN_PIECE_SHARE,
            "min_inlet_share": vessels.MIN_INLET_SHARE,
            "validation_every": VALIDATION_EVERY,
        },
        "counts": {
            name: sum(entry["split"] == name for entry in kept)
            for name in ("training", "validation", "held_out")
        },
        "skipped": len(entries) - len(kept),
        "cases": entries,
    }
    provenance.write_json(root / "manifest.json", manifest)
    return manifest


def main(arguments=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pooled", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    options = parser.parse_args(arguments)
    try:
        manifest = prepare(options.pooled, options.out)
    except (storage.StorageError, ValueError, OSError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"counts": manifest["counts"], "skipped": manifest["skipped"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
