"""The measurement of the aorta and iliac model: what the labels alone say a
case holds, and how a model is scored against them. Phantoms only."""

import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))
import aortoiliac_eval as measure
from test_aortoiliac_model import AORTA, LEFT, RIGHT, grid, tubes

from planner.aortoiliac_model import propose_aortoiliac_model


def labelled(shape, affine, left=LEFT, right=RIGHT, aorta=AORTA):
    """Three labels as the set stores them: the aorta, and each iliac artery
    where the aorta label does not already hold the voxel."""
    aorta = tubes(shape, affine, [aorta])
    labels = {"aorta": aorta}
    for name, capsule in (("left", left), ("right", right)):
        tube = tubes(shape, affine, [capsule]) if capsule else np.zeros(shape, np.uint8)
        labels[f"iliac_artery_{name}"] = tube * (aorta == 0)
    labels["iliac_artery_left"] = labels["iliac_artery_left"] * (labels["iliac_artery_right"] == 0)
    return labels


def joined(labels):
    return (sum(labels.values()) > 0).astype(np.uint8)


def test_the_labels_alone_say_where_the_fork_is_and_how_far_each_iliac_runs():
    shape, affine = grid()
    ref = measure.reference(labelled(shape, affine), affine)
    assert ref["expected"] == "both"
    # The iliac labels begin where the aorta label ends: a radius below the
    # point where the axes cross.
    assert abs(ref["bifurcation_ras"][0]) < 2 and -14 < ref["bifurcation_ras"][2] < 0
    for side, end in (("left", LEFT[1]), ("right", RIGHT[1])):
        assert ref["sides"][side]["span_mm"] == pytest.approx(np.linalg.norm(end), abs=16)
    assert ref["station"]["equal_area_radius_mm"] == pytest.approx(9.0, abs=0.4)
    assert ref["aorta_mm3"] == pytest.approx(np.pi * 81 * 150 + 4 / 3 * np.pi * 729, rel=0.03)


def test_a_case_is_scored_only_when_the_labels_say_what_it_holds():
    shape, affine = grid()
    short = ((0.0, 0.0, 0.0), (11.0, 3.0, -30.0), 5.0)
    assert measure.reference(labelled(shape, affine, right=short), affine)["expected"] == "partial"
    assert measure.reference(labelled(shape, affine, right=None), affine)["expected"] == "partial"
    none = measure.reference(labelled(shape, affine, left=None, right=None), affine)
    assert (
        none["expected"] == "none" and none["bifurcation_ras"] is None and none["station"] is None
    )
    apart = ((40.0, 0.0, -60.0), (50.0, 0.0, -125.0), 4.0)  # labelled, not touching the aorta
    assert measure.reference(labelled(shape, affine, right=apart), affine)["expected"] == "partial"
    # A scan that ends 25 mm above the bifurcation shows a stump of the aorta.
    stump = measure.reference(
        labelled(shape, affine, aorta=((0.0, 0.0, 25.0), (0.0, 0.0, 0.0), 9.0)), affine
    )
    assert stump["expected"] == "partial" and 25 < stump["aorta_span_mm"] < 50
    assert measure.reference(labelled(shape, affine), affine)["aorta_span_mm"] > 150


def test_a_model_is_scored_against_the_labels():
    shape, affine = grid()
    labels = labelled(shape, affine)
    ref = measure.reference(labels, affine)
    model = propose_aortoiliac_model(joined(labels), affine)
    scored = measure.score(model, ref, labels, affine)
    assert measure.as_expected("both", scored) is True
    assert scored["points_in_lumen"] == 1.0
    assert scored["bifurcation_off_mm"] < 12
    for side in ("left", "right"):
        assert scored["sides"][side]["in_own_label"] > 0.95
        assert scored["sides"][side]["in_other_label"] == 0.0
        assert abs(scored["sides"][side]["short_of_label_end_mm"]) < 8
    assert all(share > 0.97 for share in scored["label_in_tubes"].values())
    assert (
        abs(scored["station"]["model_radius_mm"] - scored["station"]["equal_area_radius_mm"]) < 0.6
    )

    # The same model with its two iliac lines named the wrong way round.
    swapped = {**model, "branches": [dict(b) for b in model["branches"]]}
    swapped["branches"][1]["name"], swapped["branches"][2]["name"] = "left_iliac", "right_iliac"
    wrong = measure.score(swapped, ref, labels, affine)
    assert wrong["sides"]["left"]["in_other_label"] > 0.95
    assert measure.as_expected("both", wrong) is False


def test_a_refusal_and_a_missing_or_extra_fork_are_not_as_expected():
    shape, affine = grid()
    labels = labelled(shape, affine, left=None, right=None)
    ref = measure.reference(labels, affine)
    alone = measure.score(propose_aortoiliac_model(joined(labels), affine), ref, labels, affine)
    assert alone["names"] == ["aorta"] and alone["sides"] == {}
    assert measure.as_expected("none", alone) is True
    assert measure.as_expected("both", alone) is False
    assert measure.as_expected("both", None) is False
    assert measure.as_expected("none", None) is False
    assert measure.as_expected("partial", alone) is None
    whole = labelled(shape, affine)
    three = measure.score(
        propose_aortoiliac_model(joined(whole), affine),
        measure.reference(whole, affine),
        whole,
        affine,
    )
    assert measure.as_expected("none", three) is False


def test_the_summary_counts_each_kind_of_case_apart():
    shape, affine = grid()
    runs = []
    for left, right in ((LEFT, RIGHT), (None, None), (LEFT, None)):
        labels = labelled(shape, affine, left=left, right=right)
        ref = measure.reference(labels, affine)
        scored = measure.score(
            propose_aortoiliac_model(joined(labels), affine), ref, labels, affine
        )
        runs.append(
            {
                "expected": ref["expected"],
                "scored": scored,
                "seconds": 1.0,
                "as_expected": measure.as_expected(ref["expected"], scored),
            }
        )
    runs.append({"expected": "both", "refused": "too small", "as_expected": False})
    runs.append({"expected": "no_aorta"})
    summary = measure.summarize(runs)
    assert summary["cases"] == 5 and summary["no_aorta_label"] == 1
    assert summary["both"]["cases"] == 2 and summary["both"]["as_expected"] == 1
    assert summary["both"]["refused"] == 1 and summary["both"]["iliac_lines"] == 2
    assert summary["both"]["bifurcation_within_10mm"] == 1
    assert summary["none"] == {**summary["none"], "cases": 1, "as_expected": 1, "refused": 0}
    assert summary["partial"]["cases"] == 1 and "as_expected" not in summary["partial"]


def stored(tmp_path, labels, affines):
    """A prepared set of one case, written as the format step writes it."""
    import gzip
    import hashlib
    import zipfile

    import nibabel

    case = {"subject": "s0001", "meta": {"split": "train"}, "sha256": {}}
    with zipfile.ZipFile(tmp_path / "labels.zip", "w") as lifted:
        for name, affine in zip(measure.LABELS, affines, strict=True):
            data = gzip.compress(nibabel.Nifti1Image(labels[name], affine).to_bytes())
            lifted.writestr(f"s0001/{name}.nii.gz", data)
            case["sha256"][f"{name}.nii.gz"] = hashlib.sha256(data).hexdigest()
    return zipfile.ZipFile(tmp_path / "labels.zip"), case


def test_a_case_is_read_as_the_box_that_holds_its_labels(tmp_path):
    shape, affine = grid(
        signs=(-1, -1, 1), low=(-150.0, -120.0, -128.0), high=(150.0, 120.0, 166.0)
    )
    whole = labelled(shape, affine)
    lifted, case = stored(tmp_path, whole, [affine] * 3)
    labels, boxed = measure.load_case(lifted, case)
    # The box is far smaller than the scan and says the same of the case.
    assert labels["aorta"].size < whole["aorta"].size / 5
    assert {label.shape for label in labels.values()} == {labels["aorta"].shape}
    assert sum(int(label.sum()) for label in labels.values()) == sum(
        int(label.sum()) for label in whole.values()
    )
    ref, boxed_ref = measure.reference(whole, affine), measure.reference(labels, boxed)
    assert boxed_ref["expected"] == ref["expected"] == "both"
    assert boxed_ref["bifurcation_ras"] == pytest.approx(ref["bifurcation_ras"], abs=1e-6)
    assert boxed_ref["station"] == pytest.approx(ref["station"], abs=1e-6)
    assert boxed_ref["sides"]["left"]["span_mm"] == pytest.approx(
        ref["sides"]["left"]["span_mm"], abs=1e-6
    )


def test_labels_on_grids_that_differ_are_refused_and_a_rounded_header_is_not(tmp_path):
    shape, affine = grid()
    whole = labelled(shape, affine)
    rounded = affine.copy()
    rounded[0, 1] += 1e-4  # the last digit of a stored header: 0.02 mm across this grid
    lifted, case = stored(tmp_path, whole, [affine, rounded, rounded])
    labels, boxed = measure.load_case(lifted, case)
    assert measure.reference(labels, boxed)["expected"] == "both"
    # One scan's labels can be stored a small turn apart: a tenth of a
    # millimetre at the far corner, well inside a voxel.
    turned = affine.copy()
    turned[2, 1] += 0.12 / (shape[1] * abs(affine[1, 1])) * abs(affine[1, 1])
    (tmp_path / "turned").mkdir()
    lifted, case = stored(tmp_path / "turned", whole, [affine, turned, turned])
    assert measure.reference(*measure.load_case(lifted, case))["expected"] == "both"
    moved = affine.copy()
    moved[0, 3] += 1.5
    (tmp_path / "moved").mkdir()
    lifted, case = stored(tmp_path / "moved", whole, [affine, moved, affine])
    with pytest.raises(measure.CaseError, match="different grids"):
        measure.load_case(lifted, case)
    # Such a case is set aside with its reason and the run goes on.
    assert measure.run_case(lifted, case) == {
        "subject": "s0001",
        "meta": {"split": "train"},
        "left_out": "Labels on different grids: s0001",
    }
    assert measure.summarize([measure.run_case(lifted, case)])["left_out"] == 1
    case["sha256"]["aorta.nii.gz"] = "0" * 64
    with pytest.raises(measure.PrepareError, match="Not the prepared file"):
        measure.load_case(lifted, case)


def test_a_case_with_nothing_labelled_is_read_as_empty(tmp_path):
    shape, affine = grid()
    nothing = {name: np.zeros(shape, np.uint8) for name in measure.LABELS}
    lifted, case = stored(tmp_path, nothing, [affine] * 3)
    labels, _ = measure.load_case(lifted, case)
    assert not any(label.any() for label in labels.values())
    assert measure.run_case(lifted, case)["expected"] == "no_aorta"


def test_a_run_scores_its_set_and_the_held_back_set_is_run_whole(tmp_path, monkeypatch, capsys):
    import gzip
    import hashlib
    import json
    import zipfile

    import nibabel

    shape, affine = grid()
    prepared = tmp_path / "prepared"
    prepared.mkdir()
    cases = []
    with zipfile.ZipFile(prepared / "labels.zip", "w") as lifted:
        for subject, split, right in (
            ("s1", "train", RIGHT),
            ("s2", "val", RIGHT),
            ("s3", "test", None),
            ("s4", "train", None),
        ):
            labels = labelled(shape, affine, right=right, left=LEFT if right else None)
            case = {"subject": subject, "meta": {"split": split}, "sha256": {}}
            for name in measure.LABELS:
                data = gzip.compress(nibabel.Nifti1Image(labels[name], affine).to_bytes())
                lifted.writestr(f"{subject}/{name}.nii.gz", data)
                case["sha256"][f"{name}.nii.gz"] = hashlib.sha256(data).hexdigest()
            cases.append(case)
    (prepared / "set.json").write_text(json.dumps({"cases": cases}))
    monkeypatch.setattr(measure, "outside_repository", lambda path: path)
    monkeypatch.setattr(
        measure, "created_outside", lambda path: (path.mkdir(parents=True, exist_ok=True), path)[1]
    )

    assert (
        measure.main([str(prepared), str(tmp_path / "held"), "--set", "held_back", "--first", "1"])
        == 1
    )
    assert "run whole" in capsys.readouterr().err
    assert not (tmp_path / "held").exists()

    assert measure.main([str(prepared), str(tmp_path / "held"), "--set", "held_back"]) == 0
    runs = [
        json.loads(line) for line in (tmp_path / "held" / "runs.jsonl").read_text().splitlines()
    ]
    assert [(r["subject"], r["expected"], r["as_expected"]) for r in runs] == [
        ("s2", "both", True),
        ("s3", "none", True),
    ]
    summary = json.loads((tmp_path / "held" / "summary.json").read_text())
    assert summary["set"] == "held_back" and summary["summary"]["cases"] == 2
    assert summary["summary"]["both"]["as_expected"] == 1
    assert 20 < summary["peak_worker_mb"] < 2000
    # Each case says which code scored it and what its own process came to.
    assert len(summary["code"]) == 64 and {r["code"] for r in runs} == {summary["code"]}
    assert all(20 < r["peak_mb"] <= summary["peak_worker_mb"] for r in runs)

    # A run whose code is edited under it stops; it does not write a summary.
    monkeypatch.setattr(measure, "code_digest", lambda *files: "0" * 64)
    assert measure.main([str(prepared), str(tmp_path / "edited"), "--set", "held_back"]) == 1
    assert "changed during the run" in capsys.readouterr().err
    assert not (tmp_path / "edited" / "summary.json").exists()
    monkeypatch.undo()
    monkeypatch.setattr(measure, "outside_repository", lambda path: path)
    monkeypatch.setattr(
        measure, "created_outside", lambda path: (path.mkdir(parents=True, exist_ok=True), path)[1]
    )

    # A finished run is not run over.
    assert measure.main([str(prepared), str(tmp_path / "held"), "--set", "held_back"]) == 1
    assert "finished run" in capsys.readouterr().err
    assert (
        measure.main([str(prepared), str(tmp_path / "one"), "--set", "design", "--case", "s4"]) == 0
    )
    assert (
        json.loads((tmp_path / "one" / "summary.json").read_text())["summary"]["none"]["cases"] == 1
    )
