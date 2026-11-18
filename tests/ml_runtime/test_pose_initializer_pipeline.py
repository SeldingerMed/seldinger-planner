"""Preparing vessel models, generating frames, training and the gate, end to end
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
from pose_initializer import frames, generate, measure, prepare, provenance, storage, views

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


@pytest.fixture
def anywhere(monkeypatch):
    """Lets outputs go to the test's own temporary directory."""

    def directory(path, **_):
        path.mkdir(parents=True, exist_ok=True)
        return path.resolve()

    monkeypatch.setattr(storage, "external_directory", directory)
    monkeypatch.setattr(storage, "pin_scratch", lambda root: root)
    monkeypatch.setattr(provenance, "code_state", lambda: CODE)


def pooled(tmp_path, cases):
    """A pooled dataset folder holding the given (case id, notes, mask) cases."""
    folder = tmp_path / "pooled"
    rows = []
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


def test_preparation_writes_one_model_per_case_and_a_manifest(tmp_path, anywhere):
    source = pooled(
        tmp_path,
        [
            ("costa__a", "split=Tr", tree()),
            ("costa__b", "split=Ts", tree(4)),
            ("costa__tiny", "split=Tr", np.ones((4, 4, 4), dtype=np.uint8)),
        ],
    )
    manifest = prepare.prepare(source, tmp_path / "out")
    assert manifest == json.loads((tmp_path / "out" / "manifest.json").read_text())
    assert manifest["counts"] == {"training": 1, "validation": 0, "held_out": 1}
    assert manifest["skipped"] == 1 and manifest["code"] == CODE
    by_id = {case["case_id"]: case for case in manifest["cases"]}
    assert set(by_id) == {"costa__a", "costa__b", "costa__tiny"}
    assert "outside the supported range" in by_id["costa__tiny"]["skipped"]
    first = by_id["costa__a"]
    assert first["split"] == "training" and first["license"] == "academic-use"
    assert first["source_sha256"] == provenance.file_sha256(source / "costa__a/vessel.nii.gz")
    stored = tmp_path / "out" / first["model_file"]
    assert first["model_sha256"] == provenance.file_sha256(stored)
    with np.load(stored) as model:
        assert len(model["points"]) == first["voxels"] == int(tree().sum())
        assert len(model["inlets"]) == first["inlets"] == 2
    assert not list((tmp_path / "out" / "models").glob("*.partial"))


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
    source = pooled(tmp_path, [("costa__a", "split=Tr", tree()), ("costa__b", "split=Ts", tree(4))])
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


# Training and the gate need PyTorch, which only the local model runtime has.
torch = pytest.importorskip("torch")
from pose_initializer import gate, network, train


def frames_folder(root, split, count, seed):
    """A complete split of random inputs with random views."""
    rng = np.random.default_rng(seed)
    folder = root / split
    folder.mkdir(parents=True)
    np.savez_compressed(
        folder / "costa__a.npz",
        inputs=rng.integers(0, 255, size=(count, 2, frames.GRID, frames.GRID), dtype=np.uint8),
        views=np.stack(
            [
                rng.uniform(-120, 120, count),
                rng.uniform(-50, 50, count),
                rng.uniform(-25, 25, count),
            ],
            axis=1,
        ).astype(np.float32),
        modes=rng.integers(0, 3, size=count, dtype=np.uint8),
    )
    # A companion file macOS leaves on such volumes; it is not frames.
    (folder / "._costa__a.npz").write_bytes(b"\0\5\x16\7" + bytes(60))
    record = {"settings": {"split": split, "seed": seed}, "code": CODE, "models": 1}
    (folder / "generation.json").write_text(json.dumps({**record, "frames": count}))
    return folder


OPTIONS = {
    "epochs": 2,
    "batch": 8,
    "learning_rate": 1e-3,
    "weight_decay": 0.01,
    "seed": 5,
    "device": "cpu",
}


def test_training_keeps_the_best_checkpoint_and_stores_one_file_with_its_record(tmp_path, anywhere):
    frames_folder(tmp_path / "frames", "training", 16, seed=1)
    frames_folder(tmp_path / "frames", "validation", 6, seed=2)
    result = train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)
    run = tmp_path / "run"
    assert {path.name for path in run.iterdir()} == {
        "best.pt",
        "last.pt",
        "log.jsonl",
        "training.json",
        "view-network.bin",
    }
    rows = [json.loads(line) for line in (run / "log.jsonl").read_text().splitlines()]
    assert [row["epoch"] for row in rows] == [1, 2]
    assert all(row["validation"]["frames"] == 6 for row in rows)
    ranks = [(r["validation"]["best_within"], r["validation"]["first_within"]) for r in rows]
    assert result["chosen_epoch"] == 1 + ranks.index(max(ranks))
    data = (run / "view-network.bin").read_bytes()
    assert result["bytes"] == len(data) and result["sha256"] == provenance.file_sha256(
        run / "view-network.bin"
    )
    assert result == json.loads((run / "training.json").read_text())
    header, _ = network.read_exported(data)
    record = header["record"]
    assert "Not cleared for commercial use" in record["use"] and record["code"] == CODE
    assert record["options"] == OPTIONS and record["chosen_epoch"] == result["chosen_epoch"]
    assert record["training_frames"]["frames"] == 16
    # The stored file is the kept checkpoint, norms folded in.
    kept = network.ViewNetwork()
    kept.load_state_dict(torch.load(run / "best.pt"))
    given = torch.rand(2, 2, frames.GRID, frames.GRID)
    with torch.no_grad():
        for a, b in zip(kept.eval()(given), network.Exported(data)(given), strict=True):
            assert float((a - b).abs().max()) < 1e-4


def test_frames_that_are_not_complete_are_not_trained_on(tmp_path, anywhere):
    folder = frames_folder(tmp_path / "frames", "training", 8, seed=1)
    frames_folder(tmp_path / "frames", "validation", 4, seed=2)
    record = json.loads((folder / "generation.json").read_text())
    (folder / "generation.json").write_text(json.dumps({**record, "frames": 9}))
    with pytest.raises(ValueError, match="do not match their record"):
        train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)
    del record["frames"]
    (folder / "generation.json").write_text(json.dumps(record))
    with pytest.raises(ValueError, match="are not complete"):
        train.train(tmp_path / "frames", tmp_path / "run", OPTIONS)


@pytest.fixture
def stored_network(tmp_path):
    path = tmp_path / "view-network.bin"
    torch.manual_seed(0)
    path.write_bytes(network.export_bytes(network.ViewNetwork().eval(), {"use": "test"}))
    return path


def test_the_gate_reads_the_stored_file_on_held_out_frames(tmp_path, anywhere, stored_network):
    folder = frames_folder(tmp_path / "frames", "held_out", 12, seed=3)
    report = gate.gate(stored_network, folder, tmp_path / "gate")
    assert report == json.loads((tmp_path / "gate" / "gate.json").read_text())
    assert report["network_sha256"] == provenance.file_sha256(stored_network)
    assert report["result"]["all"]["frames"] == 12
    assert report["thresholds"] == {
        "min_frames": 2000,
        "min_best_within": 0.8,
        "min_first_within": 0.5,
    }
    # Twelve frames and an untrained network: not a pass.
    assert report["passed"] is False


def test_the_gate_reads_no_other_split(tmp_path, anywhere, stored_network):
    folder = frames_folder(tmp_path / "frames", "validation", 4, seed=3)
    with pytest.raises(ValueError, match="held-out frames only"):
        gate.gate(stored_network, folder, tmp_path / "gate")


@pytest.mark.parametrize(
    ("frames_count", "best", "first", "passed"),
    [
        (2000, 0.80, 0.50, True),
        (1999, 0.95, 0.90, False),
        (5000, 0.7999, 0.90, False),
        (5000, 0.95, 0.4999, False),
    ],
)
def test_the_gate_passes_only_when_every_threshold_is_met(frames_count, best, first, passed):
    result = {"all": {"frames": frames_count, "best_within": best, "first_within": first}}
    assert gate.verdict(result) is passed
