"""Tests for the Lumen blind challenge staging CLI (protocol 1/2/4).

Synthetic local git repository only; process stubs for vitest; no real pack
execution, no real answers, no Lumen checkout working-tree reads.
"""

import hashlib
import importlib.util
import json
import struct
import subprocess
import sys
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RESEARCH = REPO / "scripts" / "research"

PIN = "79fd14d10acb96c123b37e1077214e6dbef960e4"
CASES = ["full-tree-v1", "selective-a-v1", "selective-b-v1", "overlap-a-v1", "overlap-b-v1"]


def load(name):
    spec = importlib.util.spec_from_file_location(name, RESEARCH / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lumen_challenge = load("lumen_challenge")

IDENTITY = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]


def png_bytes(width=512, height=512, gray=100):
    def chunk(kind, data):
        raw = struct.pack(">I", len(data)) + kind + data
        return raw + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    rows = b"".join(b"\x00" + bytes([gray]) * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def make_pack(git_dir):
    """Synthetic Lumen pack: problem members for every case, answers hidden."""
    pack = git_dir / "lumen" / "registration_pack"
    for case in CASES:
        case_dir = pack / case
        (case_dir / "problem").mkdir(parents=True)
        (case_dir / "problem" / "problem.json").write_text(
            json.dumps(
                {
                    "case_id": case,
                    "camera": {
                        "fx_px": 100.0,
                        "fy_px": 100.0,
                        "cx_px": 256.0,
                        "cy_px": 256.0,
                        "width_px": 512,
                        "height_px": 512,
                        "source_to_detector_mm": 600,
                    },
                }
            )
        )
        (case_dir / "problem" / "image.png").write_bytes(png_bytes())
        (case_dir / "problem" / "geometry.json").write_text(
            json.dumps({"branches": [{"points_mm": [[0.0, 0.0, 200.0], [10.0, 0.0, 200.0]]}]})
        )
        if case == "overlap-b-v1":
            (case_dir / "problem" / "calibration.json").write_text(json.dumps({"delta": 1.0}))
        (case_dir / "answer").mkdir(parents=True)
        (case_dir / "answer" / "pose.json").write_text(json.dumps({"model_to_camera_mm": IDENTITY}))
    subprocess.run(["git", "init", "-q"], cwd=git_dir, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], cwd=git_dir, check=True
    )
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "pack"],
        cwd=git_dir,
        check=True,
    )
    pin = (
        subprocess.run(
            ["git", "-C", str(git_dir), "rev-parse", "HEAD"], capture_output=True, check=True
        )
        .stdout.decode()
        .strip()
    )
    return pin


class Harness:
    """Instrumented blind run: counts git reads, stubs the vitest process."""

    def __init__(self, tmp_path, labels=("base", "depth+20")):
        self.git_dir = tmp_path / "lumen_git"
        self.git_dir.mkdir()
        self.pin = make_pack(self.git_dir)
        self.run_dir = tmp_path / "runs" / "new_run"
        self.reads = []
        self.vitest_calls = []
        self.labels = list(labels)
        self.result_ok = True
        real_show = lumen_challenge._git_show
        self.real_show = real_show

        def show(lumen_git, path):
            self.reads.append(path)
            if path.endswith("calibration.json"):
                a_result = self.run_dir / "overlap-a-v1" / "result.json"
                assert a_result.exists(), "calibration read before overlap-a result"
            return real_show(lumen_git, path)

        self.show = show

    def vitest_stub(self, case, run):
        run = Path(run)
        self.vitest_calls.append((case, str(run)))
        assert str(run) == str(self.run_dir)
        if not self.result_ok:
            return 1
        runs = [
            {
                "label": label,
                "start": None,
                "pose": None,
                "native": None,
                "gate": {"accepted": True, "reasons": []},
                "failure": None,
            }
            for label in self.labels
        ]
        (run / case / "result.json").write_text(json.dumps({"case_id": case, "runs": runs}))
        return 0

    def blind(self):
        return lumen_challenge.main(["blind", str(self.git_dir), str(self.run_dir)])

    def reveal(self):
        return lumen_challenge.main(["reveal", str(self.git_dir), str(self.run_dir)])


def patch_stub(monkeypatch, harness):
    monkeypatch.setattr(lumen_challenge, "PIN", harness.pin)
    monkeypatch.setattr(lumen_challenge, "_git_show", harness.show)
    monkeypatch.setattr(lumen_challenge, "_run_vitest", harness.vitest_stub)
    monkeypatch.setattr(lumen_challenge, "_decode_gray", lambda png: bytes(512 * 512))


def test_blind_seals_five_cases_with_manifest(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    assert harness.blind() == 0
    seal = json.loads((harness.run_dir / "seal.json").read_text())
    assert seal["format"] == "lumen_challenge_seal"
    assert seal["pin"] == harness.pin
    assert sorted(seal["cases"]) == sorted(CASES)
    for case in CASES:
        case_dir = harness.run_dir / case
        assert (case_dir / "gray.bin").stat().st_size == 512 * 512
        for name, digest in seal["cases"][case]["files"].items():
            actual = hashlib.sha256((case_dir / name).read_bytes()).hexdigest()
            assert actual == digest, (case, name)
    expected_members = {
        "calibration.json",
        "gray.bin",
        "geometry.json",
        "image.png",
        "problem.json",
        "result.json",
    }
    assert set(seal["cases"]["overlap-b-v1"]["files"]) == expected_members
    assert "calibration.json" not in set(seal["cases"]["full-tree-v1"]["files"])
    # Pinned-input order: overlap-b staged only after overlap-a result exists.
    assert [c for c, _ in harness.vitest_calls] == CASES


def test_blind_reads_only_whitelisted_members(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    problem_members = {"problem.json", "image.png", "geometry.json"}
    calibration_cases = {"overlap-b-v1"}
    for path in harness.reads:
        assert path.startswith("lumen/registration_pack/")
        rest = path[len("lumen/registration_pack/") :]
        case, _, member = rest.partition("/")
        assert case in CASES
        if member == "problem/calibration.json":
            assert case in calibration_cases
        else:
            assert member.startswith("problem/")
            assert member[len("problem/") :] in problem_members
    assert not any("answer/" in p for p in harness.reads), "answers read before seal"


def test_blind_refuses_existing_run_and_repo_inside_run(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.run_dir.mkdir(parents=True)
    try:
        harness.blind()
    except lumen_challenge.ChallengeError as error:
        assert "exists" in str(error)
    else:
        raise AssertionError("existing run dir accepted")
    # Run dir inside the planner repository is refused.
    inside = REPO / "build" / "lumen_run_test_tmp"
    try:
        lumen_challenge.main(["blind", str(harness.git_dir), str(inside)])
    except lumen_challenge.ChallengeError as error:
        assert "repo" in str(error)
    finally:
        if inside.exists():
            inside.rmdir()


def test_blind_refuses_tamper_of_existing_seal(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    seal_before = (harness.run_dir / "seal.json").read_text()
    harness.runs_read_count = len(harness.reads)
    try:
        harness.blind()
    except lumen_challenge.ChallengeError as error:
        # Refused before anything was re-staged: existing run dir / seal.
        assert "exists" in str(error)
    else:
        raise AssertionError("re-seal accepted")
    assert (harness.run_dir / "seal.json").read_text() == seal_before


def test_blind_refuses_bad_result_labels(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    harness.labels = ["base", "depth+19"]
    patch_stub(monkeypatch, harness)
    try:
        harness.blind()
    except lumen_challenge.ChallengeError as error:
        assert "depth+20" in str(error)
    else:
        raise AssertionError("wrong labels accepted")
    assert not (harness.run_dir / "seal.json").exists()


def test_reveal_refuses_tamper_before_reading_truth(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    # Tamper one staged file after sealing.
    (harness.run_dir / "full-tree-v1" / "geometry.json").write_text("{}")
    truth_reads = []
    real_show = lumen_challenge._git_show

    def guarded_show(lumen_git, path):
        truth_reads.append(path)
        return real_show(lumen_git, path)

    monkeypatch.setattr(lumen_challenge, "_git_show", guarded_show)
    try:
        harness.reveal()
    except lumen_challenge.ChallengeError as error:
        assert "digest" in str(error).lower()
    else:
        raise AssertionError("tampered seal accepted")
    assert not any("answer/" in p for p in truth_reads), "truth read before digest check"


def test_reveal_requires_exact_manifest(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    seal_path = harness.run_dir / "seal.json"
    seal = json.loads(seal_path.read_text())
    del seal["cases"]["selective-a-v1"]
    seal_path.write_text(json.dumps(seal))
    try:
        harness.reveal()
    except lumen_challenge.ChallengeError as error:
        assert "selective-a-v1" in str(error)
    else:
        raise AssertionError("incomplete manifest accepted")


def test_reveal_releases_truth_and_reports(tmp_path, monkeypatch):
    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    monkeypatch.setattr(lumen_challenge, "_git_show", harness.real_show)
    monkeypatch.setattr(lumen_challenge, "PIN", harness.pin)
    report = harness.reveal()
    assert isinstance(report, dict)
    assert (harness.run_dir / "report.json").exists()
    for case in CASES:
        assert report["cases"][case]["truth_available"] is True
    # Staged result poses were unavailable: never counted as measurements.
    assert report["summary"]["pose"]["correct"] == 0
    assert report["summary"]["pose"]["unavailable"] > 0


def test_missing_result_cannot_be_removed_from_the_manifest_and_scored(tmp_path, monkeypatch):
    import pytest

    harness = Harness(tmp_path)
    patch_stub(monkeypatch, harness)
    harness.blind()
    run = harness.run_dir
    seal = json.loads((run / "seal.json").read_text())
    del seal["cases"][CASES[0]]["files"]["result.json"]
    (run / CASES[0] / "result.json").unlink()
    (run / "seal.json").write_text(json.dumps(seal))
    with pytest.raises(lumen_challenge.ChallengeError, match="required files"):
        harness.reveal()
    assert not any("/answer/" in path for path in harness.reads)
