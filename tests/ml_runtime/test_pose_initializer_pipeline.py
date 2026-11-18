"""Preparing vessel models, generating frames and measuring answers, end to end
on small generated masks. Storage checks are replaced: no volume is touched."""

import json
import os
import sys
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires isolated imaging runtime", allow_module_level=True)
import nibabel
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "research"))
from pose_initializer import (
    frames,
    generate,
    measure,
    orientation,
    prepare,
    provenance,
    storage,
    vessels,
    views,
)

AFFINE = np.array([[1.0, 0, 0, -48], [0, 1, 0, -48], [0, 0, 1, -40], [0, 0, 0, 1]])
CODE = {"commit": "0" * 40, "uncommitted_changes": False}


def tree(shift=0):
    mask = np.zeros((96, 96, 96), dtype=np.uint8)
    mask[20:24, 46:50, 4:90] = 1
    mask[70:74, 46:50, 4:90] = 1
    mask[20:74, 46:50, 60 + shift : 64 + shift] = 1
    for k in range(40):
        mask[24 + k : 27 + k, 46:49, 20 + k : 23 + k] = 1
    return mask


def head(shift=0, named=False):
    """A head-like artery tree: two carotids, a basilar artery behind them and
    anterior arteries that run forward and over the top at the midline. With
    ``named`` the arteries carry the labels of the reference masks."""
    a = np.zeros((96, 96, 96), dtype=np.uint8)
    a[62:66, 50:54, 4:50] = 4  # right carotid: +x is the patient's right
    a[30:34, 50:54, 4:50] = 6  # left carotid
    a[46:50, 30:34, 4:50] = 1  # basilar, behind
    a[30:66, 50:54, 46:50] = 10  # across the front of the circle
    a[46:50, 30:54, 46:50] = 2  # from the basilar forward
    a[66 : 86 + shift, 50:54, 46:50] = 5  # right middle cerebral
    a[10 - shift : 30, 50:54, 46:50] = 7  # left middle cerebral
    a[46:50, 54:80, 46:50] = 11  # anterior cerebral: forward,
    a[46:50, 76:80, 50 : 85 - shift] = 11  # up,
    a[46:50, 40:80, 81 - shift : 85 - shift] = 12  # and back over the top
    return a if named else (a > 0).astype(np.uint8)


def world(mask):
    return nibabel.affines.apply_affine(AFFINE, np.argwhere(mask))


@pytest.fixture
def anywhere(monkeypatch):
    """Lets outputs go to the test's own temporary directory."""

    def directory(path, **_):
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    monkeypatch.setattr(storage, "external_directory", directory)
    monkeypatch.setattr(storage, "pin_scratch", lambda root: root)
    monkeypatch.setattr(provenance, "code_state", lambda: CODE)


def pooled(tmp_path, cases, references=(1, 2, 3), turn=lambda labels: labels):
    """A pooled dataset folder holding the given (case id, notes, mask) cases
    and reference masks of other people with named arteries."""
    folder = tmp_path / "pooled"
    rows = []
    for number in references:
        case_id = f"ixi__IXI90{number}-HH-MRA"
        (folder / case_id).mkdir(parents=True)
        labels = turn(head(number, named=True))
        for name, volume in (("named", labels), ("vessel", (labels > 0).astype(np.uint8))):
            nibabel.save(nibabel.Nifti1Image(volume, AFFINE), folder / case_id / f"{name}.nii.gz")
        rows.append(
            {
                "case_id": case_id,
                "source": "ixi",
                "license": "research-use",
                "labels": {name: f"{case_id}/{name}.nii.gz" for name in ("named", "vessel")},
            }
        )
    rows.append({"case_id": "ixi__IXI999-unnamed", "source": "ixi", "labels": {"vessel": "x"}})
    for case_id, notes, mask in cases:
        (folder / case_id).mkdir(parents=True)
        nibabel.save(nibabel.Nifti1Image(mask, AFFINE), folder / case_id / "vessel.nii.gz")
        rows.append(
            {
                "case_id": case_id,
                "source": "costa",
                "license": "academic-use",
                "labels": {"vessel": f"{case_id}/vessel.nii.gz"},
                "notes": notes,
            }
        )
    rows.append({"case_id": "other__1", "source": "other", "labels": {"vessel": "x"}})
    rows.append({"case_id": "costa__unlabelled", "source": "costa", "labels": {}})
    (folder / "cases.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    return folder


def test_the_split_holds_out_the_sources_test_cases_and_every_eighth_training_case():
    cases = [{"case_id": f"costa__{k:02d}", "notes": "split=Tr"} for k in range(20)]
    cases += [{"case_id": f"costa__t{k}", "notes": "center=X, split=Ts"} for k in range(3)]
    chosen = prepare.split_of(cases[::-1])
    assert [name for name, split in chosen.items() if split == "held_out"] == [
        "costa__t0",
        "costa__t1",
        "costa__t2",
    ]
    assert sorted(name for name, split in chosen.items() if split == "validation") == [
        "costa__07",
        "costa__15",
    ]
    assert sum(split == "training" for split in chosen.values()) == 18


@pytest.mark.parametrize("notes", ["", "split=Va", "center=IXI"])
def test_a_case_that_does_not_say_its_split_stops_the_preparation(notes):
    with pytest.raises(ValueError, match="does not say which split"):
        prepare.split_of([{"case_id": "costa__a", "notes": notes}])


def test_the_midline_arteries_say_where_the_front_is():
    assert orientation.midline_mm(world(head())) > 5
    assert orientation.midline_mm(world(head()[:, ::-1])) < -5
    # A tree that is the same front and back says nothing clear,
    assert abs(orientation.midline_mm(world(tree()))) < orientation.MIN_MIDLINE_MM
    # and nor does one with nothing on its midline.
    sides = np.zeros((96, 96, 96), dtype=np.uint8)
    sides[20:24, 30:60, 4:90] = sides[70:74, 30:60, 4:90] = 1
    assert orientation.midline_mm(world(sides)) == 0


def test_other_peoples_arteries_say_where_the_front_is():
    others = orientation.references([world(head(k)) for k in (1, 2, 3)])
    right = orientation.likeness(world(head()), others)
    assert max(right, key=right.get) == "as_labelled"
    turned = orientation.likeness(world(head()[:, ::-1]), others)
    assert max(turned, key=turned.get) == "back_to_front"
    assert turned["back_to_front"] == pytest.approx(right["as_labelled"], abs=0.05)
    assert turned["back_to_front"] - turned["as_labelled"] > 0.05
    over = orientation.likeness(world(head()[:, :, ::-1]), others)
    assert max(over, key=over.get) == "upside_down"
    with pytest.raises(ValueError, match="No reference"):
        orientation.likeness(world(head()), [])


LIKE = {
    "as_labelled": 0.5,
    "back_to_front": 0.4,
    "upside_down": 0.3,
    "upside_down_back_to_front": 0.3,
}


@pytest.mark.parametrize(
    ("midline", "change", "expected"),
    [
        (12.0, {}, "as_labelled"),
        (-12.0, {"as_labelled": 0.4, "back_to_front": 0.5}, "back_to_front"),
        # The two disagree.
        (-12.0, {}, None),
        (12.0, {"as_labelled": 0.4, "back_to_front": 0.5}, None),
        # One of the two is not clear.
        (2.9, {}, None),
        (12.0, {"back_to_front": 0.495}, None),
        # Upside down fits better than either way up.
        (12.0, {"upside_down": 0.6}, None),
        (12.0, {"upside_down_back_to_front": 0.6}, None),
    ],
)
def test_a_mask_is_used_only_when_both_indicators_are_clear_and_agree(midline, change, expected):
    assert orientation.decide(midline, {**LIKE, **change}) == expected


def test_a_reference_must_have_its_named_arteries_where_the_names_say():
    named = head(named=True)
    assert orientation.named_as_labelled(named, AFFINE) is True
    assert orientation.named_as_labelled(named[:, ::-1], AFFINE) is False
    assert orientation.named_as_labelled(named[::-1], AFFINE) is False
    # Without the arteries the check reads, it says nothing.
    assert orientation.named_as_labelled(np.where(named == 5, 0, named), AFFINE) is None


def test_a_reference_is_not_compared_with_its_own_person():
    assert prepare.person("ixi__IXI012-HH-1211-MRA_LPS") == "IXI012"
    assert prepare.person("costa__IXI012-HH-1211-MRA_IXI-HH") == "IXI012"
    assert prepare.person("costa__IXI0123-Guys") == "IXI0123"
    assert prepare.person("costa__10007-TOF_ADAM") is None


def test_preparation_writes_one_model_per_case_and_a_manifest(tmp_path, anywhere):
    source = pooled(
        tmp_path,
        [
            ("costa__a", "split=Tr", head()),
            ("costa__b", "split=Ts", head(4)),
            # Stored back to front.
            ("costa__c", "split=Tr", head(2)[:, ::-1]),
            # Nothing says which way this one faces.
            ("costa__sym", "split=Tr", tree()),
            ("costa__tiny", "split=Tr", np.ones((4, 4, 4), dtype=np.uint8)),
        ],
    )
    manifest = prepare.prepare(source, tmp_path / "out")
    assert manifest == json.loads((tmp_path / "out" / "manifest.json").read_text())
    assert manifest["counts"] == {"training": 2, "validation": 0, "held_out": 1}
    assert manifest["skipped"] == 2 and manifest["code"] == CODE
    assert manifest["references"] == [
        {"case_id": f"ixi__IXI90{k}-HH-MRA", "license": "research-use"} for k in (1, 2, 3)
    ]
    assert manifest["settings"]["min_midline_mm"] == orientation.MIN_MIDLINE_MM
    by_id = {case["case_id"]: case for case in manifest["cases"]}
    assert set(by_id) == {"costa__a", "costa__b", "costa__c", "costa__sym", "costa__tiny"}
    assert "outside the supported range" in by_id["costa__tiny"]["skipped"]
    assert "which way" in by_id["costa__sym"]["skipped"]
    assert "facing" not in by_id["costa__sym"] and "model_file" not in by_id["costa__sym"]
    assert abs(by_id["costa__sym"]["midline_mm"]) < orientation.MIN_MIDLINE_MM
    assert set(by_id["costa__sym"]["likeness"]) == set(LIKE)
    first = by_id["costa__a"]
    assert first["split"] == "training" and first["license"] == "academic-use"
    assert first["facing"] == "as_labelled" and first["midline_mm"] > 5
    assert first["source_sha256"] == provenance.file_sha256(source / "costa__a/vessel.nii.gz")
    stored = tmp_path / "out" / first["model_file"]
    assert first["model_sha256"] == provenance.file_sha256(stored)
    with np.load(stored) as model:
        assert len(model["points"]) == first["voxels"] == int(head().sum())
        assert len(model["inlets"]) == first["inlets"] == 3
    # The mask stored back to front is turned: its model is the model of the
    # same mask stored right, one voxel along (the mirror of a voxel grid).
    turned = by_id["costa__c"]
    assert turned["facing"] == "back_to_front" and turned["midline_mm"] < -5
    with np.load(tmp_path / "out" / turned["model_file"]) as model:
        found = {tuple(point) for point in model["points"].tolist()}
        assert len(model["inlets"]) == 3
    right = vessels.vessel_model(head(2), AFFINE)["points"] + np.array([0, 1, 0], dtype=np.float32)
    assert found == {tuple(point) for point in right.tolist()}
    assert not list((tmp_path / "out" / "models").glob("*.partial"))


def test_a_reference_stored_the_wrong_way_stops_the_preparation(tmp_path, anywhere):
    source = pooled(
        tmp_path, [("costa__a", "split=Tr", head())], turn=lambda labels: labels[:, ::-1]
    )
    with pytest.raises(ValueError, match="not oriented as its labels say"):
        prepare.prepare(source, tmp_path / "out")


def test_too_few_references_stop_the_preparation(tmp_path, anywhere):
    source = pooled(tmp_path, [("costa__a", "split=Tr", head())], references=(1, 2))
    with pytest.raises(ValueError, match="Too few reference masks"):
        prepare.prepare(source, tmp_path / "out")


def test_a_subject_listed_twice_stops_the_preparation(tmp_path, anywhere):
    source = pooled(tmp_path, [("costa__a", "split=Tr", tree())])
    with (source / "cases.jsonl").open("a") as handle:
        handle.write(
            json.dumps(
                {
                    "case_id": "COSTA__A",
                    "source": "costa",
                    "labels": {"vessel": "costa__a/vessel.nii.gz"},
                    "notes": "split=Ts",
                }
            )
            + "\n"
        )
    with pytest.raises(ValueError, match="more than once"):
        prepare.prepare(source, tmp_path / "out")


@pytest.fixture
def prepared(tmp_path, anywhere):
    source = pooled(tmp_path, [("costa__a", "split=Tr", head()), ("costa__b", "split=Ts", head(4))])
    prepare.prepare(source, tmp_path / "prepared")
    return tmp_path / "prepared"


def test_the_random_stream_of_a_case_depends_on_seed_split_and_case():
    draw = lambda *key: generate.stream(*key).random(3).tolist()
    assert draw(1, "training", "a") == draw(1, "training", "a")
    assert draw(1, "training", "a") != draw(2, "training", "a")
    assert draw(1, "training", "a") != draw(1, "held_out", "a")
    assert draw(1, "training", "a") != draw(1, "training", "b")


def test_generation_writes_the_frames_of_one_split_and_can_be_repeated(prepared, tmp_path):
    summary = generate.generate(prepared, tmp_path / "frames", "training", 5, seed=3, workers=1)
    assert summary["models"] == 1 and summary["frames"] == 5 and summary["code"] == CODE
    assert summary["settings"]["split"] == "training" and summary["settings"]["seed"] == 3
    folder = tmp_path / "frames" / "training"
    assert sorted(path.name for path in folder.iterdir()) == ["costa__a.npz", "generation.json"]
    with np.load(folder / "costa__a.npz") as stored:
        first = {name: stored[name] for name in stored.files}
    assert first["inputs"].shape == (5, 2, frames.GRID, frames.GRID)
    assert first["inputs"].dtype == np.uint8 and first["views"].shape == (5, 3)
    assert (np.abs(first["views"][:, 0]) <= frames.PRIMARY_RANGE_DEG).all()
    assert set(first["modes"].tolist()) <= {0, 1, 2}
    # A second run keeps what is there; a fresh one makes the same frames.
    before = (folder / "costa__a.npz").stat().st_mtime_ns
    generate.generate(prepared, tmp_path / "frames", "training", 5, seed=3, workers=1)
    assert (folder / "costa__a.npz").stat().st_mtime_ns == before
    generate.generate(prepared, tmp_path / "again", "training", 5, seed=3, workers=1)
    with np.load(tmp_path / "again" / "training" / "costa__a.npz") as stored:
        assert all(np.array_equal(stored[name], first[name]) for name in first)


def test_frames_made_with_other_settings_are_not_mixed_in(prepared, tmp_path):
    generate.generate(prepared, tmp_path / "frames", "training", 2, seed=3, workers=1)
    for change in ({"count": 3, "seed": 3}, {"count": 2, "seed": 4}):
        with pytest.raises(ValueError, match="other settings"):
            generate.generate(prepared, tmp_path / "frames", "training", workers=1, **change)


def answers_for(true_views, miss=(0.0, 0.0)):
    """Network answers that put the first proposal ``miss`` degrees off."""
    count = len(true_views)
    scores = np.full((count, views.BINS), -9.0)
    offsets = np.zeros((count, views.BINS, 2))
    turns = np.zeros((count, views.BINS))
    for row, (primary, secondary, turn) in enumerate(true_views):
        weight, offset, _ = views.targets(primary + miss[0], secondary + miss[1], turn)
        best = int(weight.argmax())
        scores[row, best] = 5
        offsets[row, best] = offset[best]
        turns[row, best] = turn / views.TURN_UNIT_DEG
    return scores, offsets, turns


TRUE = np.array([(30.0, 10.0, 5.0), (-80.0, -20.0, -10.0), (0.0, 0.0, 0.0), (100.0, 40.0, 20.0)])


def test_a_right_answer_measures_as_zero_and_a_wrong_one_as_its_miss():
    right = measure.measure(*answers_for(TRUE), TRUE)
    assert np.allclose(right["first_deg"], 0, atol=1e-4) and (right["best_rank"] == 0).all()
    assert np.allclose(right["best_turn_error_deg"], 0, atol=1e-4)
    off = measure.measure(*answers_for(TRUE, miss=(0.0, 25.0)), TRUE)
    assert np.allclose(off["first_deg"], 25, atol=1e-4)
    assert (off["best_deg"] <= off["first_deg"] + 1e-9).all()


def test_the_best_proposal_can_be_a_later_one():
    scores, offsets, turns = answers_for(TRUE[:1], miss=(60.0, 0.0))
    weight, offset, _ = views.targets(*TRUE[0])
    second = int(weight.argmax())
    scores[0, second], offsets[0, second] = 3, offset[second]
    found = measure.measure(scores, offsets, turns, TRUE[:1])
    assert found["first_deg"][0] > 50 and found["best_deg"][0] < 1e-4
    assert found["best_rank"][0] == 1


def test_the_summary_counts_frames_within_fifteen_degrees_overall_and_by_mode():
    scores, offsets, turns = answers_for(TRUE)
    wrong = answers_for(TRUE, miss=(0.0, 25.0))
    for part, other in zip((scores, offsets, turns), wrong, strict=True):
        part[2:] = other[2:]
    result = measure.summary(
        measure.measure(scores, offsets, turns, TRUE), modes=np.array([0, 1, 1, 1])
    )
    assert result["within_deg"] == 15 and result["all"]["frames"] == 4
    assert result["all"]["first_within"] == 0.5
    assert result["all"]["best_within"] >= result["all"]["first_within"]
    # The filling mode named "all" does not overwrite the overall result.
    assert set(result["by_mode"]) == {"all", "cell"}
    assert result["by_mode"]["all"]["frames"] == 1 and result["by_mode"]["cell"]["frames"] == 3
    assert result["by_mode"]["cell"]["first_within"] == round(1 / 3, 4)
