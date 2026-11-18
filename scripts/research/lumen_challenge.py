"""Blind staging CLI for the Lumen registration challenge.

Protocol 1/2/4 of ``docs/research/lumen-registration-protocol.md``. Reads the
pinned pack ``79fd14d10acb96c123b37e1077214e6dbef960e4`` exclusively through
``git show PIN:path`` (never a working tree), stages only the whitelisted
problem members, decodes the frame to raw grayscale, runs the evaluator one
case at a time, and seals a digest manifest over every staged byte after all
five cases finish. Truth is read only by ``reveal``, and only after the
mandatory exact manifest and all digests verify.

Commands:
  blind <lumen_git> <new_run>   stage + evaluate + seal (run must not exist
                                and must lie outside every repository)
  reveal <lumen_git> <run>      verify seal digests, then release truth poses
                                into scripts.research.lumen_reveal.reveal

Case order is fixed: full-tree-v1, selective-a-v1, selective-b-v1,
overlap-a-v1, then overlap-b-v1 (its calibration.json is read only after
overlap-a-v1's result.json exists).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

PIN = "79fd14d10acb96c123b37e1077214e6dbef960e4"
PACK = "lumen/registration_pack"
PROBLEM_MEMBERS = ("problem/problem.json", "problem/image.png", "problem/geometry.json")
CASES = ("full-tree-v1", "selective-a-v1", "selective-b-v1", "overlap-a-v1", "overlap-b-v1")
CALIBRATED_CASE = "overlap-b-v1"
CALIBRATION_GATED_ON = "overlap-a-v1"
LABELS = ("base", "depth+20")

VITEST_ARGS = [
    "run",
    "--config",
    "vitest.research.config.ts",
    "src/research/lumenChallenge.eval.ts",
]

SEAL_FORMAT = "lumen_challenge_seal"

# Injection points for tests (and a lazy-Pillow default for the decoder).
IMAGE_DECODER = None


class ChallengeError(Exception):
    pass


# ---------------------------------------------------------------- pinned input


def _git_show(lumen_git, path):
    """Read one pinned blob; the working tree is never touched."""
    result = subprocess.run(
        ["git", "-C", str(lumen_git), "show", f"{PIN}:{path}"],
        check=False,
        capture_output=True,
    )
    if result.returncode != 0:
        raise ChallengeError(
            f"git show {PIN}:{path} failed: {result.stderr.decode(errors='replace').strip()}"
        )
    return result.stdout


def _member_path(case, member):
    return f"{PACK}/{case}/{member}"


def _decode_gray(png_bytes):
    """512x512 8-bit grayscale PNG -> raw row-major bytes (lazy Pillow)."""
    try:
        from PIL import Image
    except ImportError as error:  # pragma: no cover - physics runtime provides PIL
        raise ChallengeError(
            "decoding the frame needs Pillow (or an injected _decode_gray)"
        ) from error
    with Image.open(io.BytesIO(png_bytes)) as image:
        if image.size != (512, 512):
            raise ChallengeError(f"expected 512x512 frame, got {image.size}")
        if image.mode != "L":
            raise ChallengeError(f"expected 8-bit grayscale frame, got mode {image.mode}")
        return image.tobytes()


# ------------------------------------------------------------------ run layout


def _repo_roots(lumen_git):
    roots = [REPO_ROOT.resolve(), Path(lumen_git).resolve()]
    discovered = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "--show-toplevel"],
        check=False,
        capture_output=True,
    )
    if discovered.returncode == 0:
        roots.append(Path(discovered.stdout.decode().strip()).resolve())
    return roots


def _validate_run_dir(lumen_git, run):
    run = Path(run).resolve()
    if run.exists():
        raise ChallengeError(f"run directory already exists: {run}")
    for root in _repo_roots(lumen_git):
        if run == root or root in run.parents:
            raise ChallengeError(f"run directory must be outside the repo: {run} is under {root}")
    return run


def _read_json(path, what):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError) as error:
        raise ChallengeError(f"{what} at {path}: {error}") from error


def _verify_result(run, case):
    result = _read_json(run / case / "result.json", "result.json")
    if result.get("case_id") != case:
        raise ChallengeError(f"{case}: result.json case_id {result.get('case_id')!r} != {case!r}")
    labels = [entry.get("label") for entry in result.get("runs", [])]
    if sorted(labels) != sorted(LABELS):
        raise ChallengeError(
            f"{case}: result.json labels {labels} != {sorted(LABELS)} (base and depth+20 required)"
        )
    return result


# ----------------------------------------------------------------------- blind


def _stage_case(lumen_git, run, case):
    """Copy whitelisted pinned members into run/<case>/, flat."""
    case_dir = run / case
    case_dir.mkdir(parents=True)
    members = list(PROBLEM_MEMBERS)
    if case == CALIBRATED_CASE:
        if not (run / CALIBRATION_GATED_ON / "result.json").exists():
            raise ChallengeError(
                f"{CALIBRATED_CASE} calibration may only be read after "
                f"{CALIBRATION_GATED_ON} saved its result.json"
            )
        members.append("problem/calibration.json")
    for member in members:
        blob = _git_show(lumen_git, _member_path(case, member))
        (case_dir / Path(member).name).write_bytes(blob)
    # Record the pinned frame before any inference runs on it.
    (case_dir / "gray.bin").write_bytes(_decode_gray((case_dir / "image.png").read_bytes()))


def _run_vitest(case, run):
    """Production evaluation process; tests stub this."""
    web = REPO_ROOT / "web"
    env = dict(os.environ)
    env["LUMEN_RUN"] = str(run)
    env["LUMEN_CASE"] = case
    result = subprocess.run(
        [str(web / "node_modules" / ".bin" / "vitest"), *VITEST_ARGS],
        cwd=str(web),
        env=env,
        check=False,
        timeout=150,
    )
    if result.returncode != 0:
        raise ChallengeError(f"{case}: vitest exited {result.returncode}")


def blind(lumen_git, run_arg):
    lumen_git = Path(lumen_git)
    run = _validate_run_dir(lumen_git, run_arg)
    run.mkdir(parents=True)
    for case in CASES:
        _stage_case(lumen_git, run, case)
        _run_vitest(case, str(run))
        if not (run / case / "result.json").exists():
            raise ChallengeError(f"{case}: vitest did not write result.json")
        _verify_result(run, case)
    seal = {
        "format": SEAL_FORMAT,
        "version": 1,
        "pin": PIN,
        "cases": {},
    }
    for case in CASES:
        case_dir = run / case
        files = {}
        for path in sorted(case_dir.iterdir()):
            if path.is_file():
                files[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
        seal["cases"][case] = {"files": files}
    seal_path = run / "seal.json"
    if seal_path.exists():
        raise ChallengeError(f"refusing to tamper with an existing seal: {seal_path}")
    seal_path.write_text(json.dumps(seal, indent=2, sort_keys=True))
    return seal


# ---------------------------------------------------------------------- reveal


def _verify_seal(run):
    """Exact manifest over the exact case set, then every digest."""
    seal = _read_json(run / "seal.json", "seal.json")
    if seal.get("format") != SEAL_FORMAT or seal.get("version") != 1:
        raise ChallengeError(f"{run / 'seal.json'}: unrecognized seal format")
    if seal.get("pin") != PIN:
        raise ChallengeError(f"seal pin {seal.get('pin')!r} != pinned {PIN!r}")
    if sorted(seal.get("cases", {})) != sorted(CASES):
        raise ChallengeError(
            f"seal manifest cases {sorted(seal.get('cases', {}))} != exact set {sorted(CASES)}"
        )
    for case in CASES:
        case_dir = run / case
        manifest = seal["cases"][case].get("files", {})
        required = {"problem.json", "geometry.json", "image.png", "gray.bin", "result.json"}
        if case == CALIBRATED_CASE:
            required.add("calibration.json")
        if set(manifest) != required:
            raise ChallengeError(f"{case}: manifest does not list required files")
        staged = sorted(p.name for p in case_dir.iterdir())
        if sorted(manifest) != staged:
            raise ChallengeError(
                f"{case}: staged files {staged} != sealed files {sorted(manifest)}"
            )
        for name, digest in sorted(manifest.items()):
            actual = hashlib.sha256((case_dir / name).read_bytes()).hexdigest()
            if actual != digest:
                raise ChallengeError(f"{case}/{name}: digest mismatch, seal tampered")
    return seal


def reveal(lumen_git, run_arg):
    lumen_git = Path(lumen_git)
    run = Path(run_arg).resolve()
    _verify_seal(run)
    # Only now, with every digest verified, is truth opened.
    truth = {}
    for case in CASES:
        blob = _git_show(lumen_git, _member_path(case, "answer/pose.json"))
        try:
            truth[case] = json.loads(blob.decode())
        except (UnicodeDecodeError, ValueError) as error:
            raise ChallengeError(f"{case}: answer/pose.json: {error}") from error
    from scripts.research.lumen_reveal import reveal as score_sealed

    return score_sealed(run, truth)


# ------------------------------------------------------------------------- CLI


def main(argv):
    parser = argparse.ArgumentParser(description="Lumen blind registration challenge")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("blind", "reveal"):
        command = sub.add_parser(name)
        command.add_argument("lumen_git")
        command.add_argument("run")
        command.add_argument("--pin", default=PIN)
    args = parser.parse_args(argv)
    if args.pin != PIN:
        raise ChallengeError(f"pin {args.pin!r} != pinned {PIN!r}")
    if args.command == "blind":
        blind(args.lumen_git, args.run)
        return 0
    report = reveal(args.lumen_git, args.run)
    print(json.dumps(report.get("summary", {}), sort_keys=True))
    return report


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except ChallengeError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
