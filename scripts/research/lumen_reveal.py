#!/usr/bin/env python3
"""Independent reveal evaluator and HTML replay for the Lumen blind runs.

Protocol 4 of ``docs/research/lumen-registration-protocol.md``. Called only
after sealing, by the parent scoring CLI, which passes the parsed truth. It
opens no answers itself, talks to no scorer, and reads nothing outside the
given run directory plus the truth argument.

Expected run layout, one directory per case under ``run``:
  <case>/problem.json   {"case_id": str, "camera": {"width_px", "height_px",
                        "fx_px", "fy_px", "cx_px", "cy_px",
                        "source_to_detector_mm", ...}, ...}
  <case>/geometry.json  {"branches": [{"points_mm": [[x, y, z], ...], ...}]}
  <case>/image.png      the actual grayscale frame the proposal was made on
  <case>/result.json    {"case_id": str,
                         "runs": [{"label": str,
                                   "start": {"model_to_camera_mm": 4x4} | null,
                                   "pose": {"model_to_camera_mm": 4x4} | null,
                                   "native": production result | null,
                                   "gate": {"accepted": bool, "reasons": ...},
                                   "failure": ...}]}

Truth argument: ``{case_id: {"model_to_camera_mm": 4x4, ...}}`` with the
matrix as nested rows. Cases present in the run but absent from the truth are
reported as not measured; nothing is invented for them.

Metrics per trial, for ``start`` and ``pose`` independently: with the truth
pose fixed, the target error at a model point is the Euclidean distance in
camera millimetres between the point carried by the trial pose and by the
truth pose; the reprojection error is the pixel distance between the two
projections through the released intrinsics. The whole-tree RMS pools every
point of every branch of the case. A trial is *correct* iff both RMS values
are finite and target <= 5 mm and reprojection <= 5 px. A missing, non-finite
or behind-camera (depth-capped, z <= 0) result is unavailable, not wrong: it
is never counted as a measurement. Missing ``start`` and missing ``native``
are preserved as given.

Outputs, written into the run directory:
  report.json   machine-readable evaluation (format below; no absolute paths)
  replay.html   self-contained replay: per trial an uncolored raw-image panel
                beside the candidate overlay (magenta candidate, dashed blue start), gate verdict, native availability
                and failure; a separate expandable ``<details>`` holds the
                truth overlay in amber with the initial/final metrics. The
                truth never appears in the candidate panel. Overlays are SVG
                with native pixel ``viewBox="-0.5 -0.5 W H"``, the actual
                image embedded at the same box, one polyline per contiguous
                segment of each branch (points as a string; a non-projectable
                point breaks the branch instead of connecting across it). No
                remote resources; all text is HTML-escaped.

report.json format:
  {"format": "lumen_reveal_report", "version": 1,
   "run": "<run directory name>",
   "cases": {"<case_id>": {
       "truth_available": bool,
       "problem": {...as read...},
       "trials": [{"label", "start", "pose", "native", "gate", "failure",
                   "start_metrics" | null, "pose_metrics" | null}]}},
   "summary": {"pose": {correct, wrong, unavailable}, "start": {...},
               "native": {"emitted": {...}, "refused": {...}},
               "research": {"accepted": {...}, "declined": {...}}}}
Each metrics dict is {"target_mm_rms", "reprojection_px_rms", "correct"}.
"""

from __future__ import annotations

import base64
import html
import json
import math
from pathlib import Path

MAX_TARGET_MM = 5.0
MAX_REPROJECTION_PX = 5.0

_REPORT_FORMAT = "lumen_reveal_report"
_REPORT_VERSION = 1


class RevealError(Exception):
    pass


def _camera_point(pose, point):
    return [sum(pose[row][col] * point[col] for col in range(3)) + pose[row][3] for row in range(3)]


def _project(camera, pose, point):
    """Pinhole projection with the released intrinsics, or None when the
    point is behind the camera (z <= 0) or projects non-finitely."""
    if pose is None:
        return None
    p = _camera_point(pose, point)
    z = p[2]
    if not all(math.isfinite(value) for value in p) or not 0 < z <= camera["source_to_detector_mm"]:
        return None
    u = camera["fx_px"] * p[0] / z + camera["cx_px"]
    v = camera["fy_px"] * p[1] / z + camera["cy_px"]
    if not (math.isfinite(u) and math.isfinite(v)):
        return None
    return (u, v)


def _pose_metrics(camera, branches, pose, truth_pose):
    """Whole-tree RMS target (mm) and reprojection (px), or None."""
    if pose is None or truth_pose is None:
        return None
    targets, reprojections = [], []
    for branch in branches:
        for point in branch["points_mm"]:
            trial_cam = _camera_point(pose, point)
            truth_cam = _camera_point(truth_pose, point)
            if not all(math.isfinite(v) for v in trial_cam + truth_cam):
                return None
            trial_px = _project(camera, pose, point)
            truth_px = _project(camera, truth_pose, point)
            if trial_px is None or truth_px is None:
                return None
            targets.append(math.dist(trial_cam, truth_cam))
            reprojections.append(math.dist(trial_px, truth_px))
    target_rms = math.sqrt(sum(e * e for e in targets) / len(targets))
    reprojection_rms = math.sqrt(sum(e * e for e in reprojections) / len(reprojections))
    correct = (
        math.isfinite(target_rms)
        and math.isfinite(reprojection_rms)
        and target_rms <= MAX_TARGET_MM
        and reprojection_rms <= MAX_REPROJECTION_PX
    )
    return {
        "target_mm_rms": target_rms,
        "reprojection_px_rms": reprojection_rms,
        "correct": bool(correct),
    }


def _read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise RevealError(f"{path}: {error}") from error


def _escape(text):
    return html.escape(str(text), quote=True)


def _panel_svg(svg_id, camera, image_uri, mark_groups, caption):
    """Panel svg: native-pixel viewBox, embedded image, polyline strings."""
    polylines = "".join(
        '<polyline points="{}" class="{}"/>'.format(" ".join(chain), css)
        for css, chains in mark_groups
        for chain in chains
    )
    return (
        f'<svg class="panel-svg" id="{svg_id}" viewBox="-0.5 -0.5 {camera["width_px"]} {camera["height_px"]}">'
        f'<image x="-0.5" y="-0.5" width="{camera["width_px"]}" height="{camera["height_px"]}" href="{image_uri}"/>'
        f'{polylines}</svg><p class="caption">{caption}</p>'
    )


def _branch_chains(camera, pose, branch):
    """Contiguous projected runs of one branch, each a 'u,v u,v' string."""
    if pose is None:
        return []
    chains, current = [], []
    for point in branch["points_mm"]:
        projected = _project(camera, pose, point)
        if projected is None:
            if current:
                chains.append(current)
                current = []
            continue
        current.append(f"{projected[0]:.2f},{projected[1]:.2f}")
    if current:
        chains.append(current)
    return chains


def _metrics_table(trial):
    rows = []
    for stage, metrics in (
        ("initial", trial.get("start_metrics")),
        ("final", trial.get("pose_metrics")),
    ):
        if metrics is None:
            rows.append(f"<tr><td>{stage}</td><td colspan='3'>unavailable</td></tr>")
        else:
            verdict = "correct" if metrics["correct"] else "wrong"
            rows.append(
                f"<tr><td>{stage}</td><td>{metrics['target_mm_rms']:.2f} mm</td>"
                f"<td>{metrics['reprojection_px_rms']:.2f} px</td><td>{verdict}</td></tr>"
            )
    return (
        "<table><tr><th>stage</th><th>target RMS</th><th>reprojection RMS</th><th>verdict</th></tr>"
        + "".join(rows)
        + "</table><p class='caption'>thresholds: target &le; 5 mm and reprojection &le; 5 px</p>"
    )


def _trial_section(case_id, trial, camera, image_uri, geometry):
    label = _escape(trial.get("label", ""))
    gate = trial.get("gate") or {}
    reasons = ", ".join(str(reason) for reason in (gate.get("reasons") or [])) or "none"
    accepted = "accepted" if gate.get("accepted") else "declined"
    failure = _escape(trial["failure"]) if trial.get("failure") is not None else "none"
    native = "emitted" if trial.get("native") is not None else "refused"
    marks = [
        (
            "mark-candidate",
            [
                chain
                for branch in geometry["branches"]
                for chain in _branch_chains(camera, _pose(trial), branch)
            ],
        ),
        (
            "mark-start",
            [
                chain
                for branch in geometry["branches"]
                for chain in _branch_chains(camera, _pose(trial, "start"), branch)
            ],
        ),
    ]
    candidate = _panel_svg(
        f"candidate-{_escape(case_id)}-{label}",
        camera,
        image_uri,
        marks,
        "candidate (magenta); start (dashed blue)",
    )
    raw = f'<svg class="panel-svg" id="raw-{_escape(case_id)}-{label}" viewBox="-0.5 -0.5 {camera["width_px"]} {camera["height_px"]}"><image x="-0.5" y="-0.5" width="{camera["width_px"]}" height="{camera["height_px"]}" href="{image_uri}"/></svg><p class="caption">raw input frame</p>'
    truth = ""
    if trial.get("truth_pose") is not None:
        truth_marks = [
            (
                "mark-truth",
                [
                    chain
                    for branch in geometry["branches"]
                    for chain in _branch_chains(camera, trial["truth_pose"], branch)
                ],
            )
        ]
        truth_svg = _panel_svg(
            f"truth-{_escape(case_id)}-{label}",
            camera,
            image_uri,
            truth_marks,
            "revealed truth overlay (amber)",
        )
        truth = f"<details><summary>revealed truth &amp; correctness</summary>{truth_svg}{_metrics_table(trial)}</details>"
    return (
        f'<div class="trial"><h4>{label}</h4>'
        f"<p>gate: {accepted} &mdash; reasons: {_escape(reasons)}</p>"
        f"<p>native: {native} &mdash; failure: {failure}</p>"
        f'<div class="panels"><figure>{raw}</figure><figure>{candidate}</figure></div>{truth}</div>'
    )


def _pose(trial, stage="pose"):
    answer = trial.get(stage)
    return answer.get("model_to_camera_mm") if isinstance(answer, dict) else None


_CSS = """
body { font-family: -apple-system, sans-serif; margin: 1rem; background: #fafafa; }
.case { border: 1px solid #ccc; border-radius: 8px; margin: 1rem 0; padding: 0.5rem 1rem; }
.panels { display: flex; gap: 1rem; flex-wrap: wrap; }
figure { margin: 0; }
.panel-svg { width: min(320px, 85vw); background: #fff; }
.panel-svg image { image-rendering: pixelated; }
polyline { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.mark-candidate { stroke: #bd1b72; }
.mark-start { stroke: #00c; stroke-dasharray: 4 3; }
.mark-truth { stroke: #e8a013; }
table { border-collapse: collapse; margin: 0.5rem 0; }
th, td { border: 1px solid #bbb; padding: 2px 8px; font-size: 0.9rem; }
.caption { font-size: 0.75rem; color: #555; }
"""


def _replay_html(run_name, cases):
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        "<title>Lumen registration reveal replay</title>",
        f"<style>{_CSS}</style></head><body>",
        "<h1>Lumen registration reveal replay</h1>",
        f"<p>run: {_escape(run_name)} &mdash; all resources are inline.</p>",
    ]
    for case_id, case in cases.items():
        parts.append(f'<section class="case"><h2>{_escape(case_id)}</h2>')
        parts.append(
            "truth: revealed"
            if case["truth_available"]
            else "truth: not revealed &mdash; not measured"
        )
        for trial in case["trials"]:
            parts.append(
                _trial_section(
                    case_id, trial, case["camera"], case["image_data_uri"], case["geometry"]
                )
            )
        parts.append("</section>")
    parts.append("</body></html>")
    return "".join(parts)


def _verdict(metrics):
    if metrics is None:
        return "unavailable"
    return "correct" if metrics["correct"] else "wrong"


def reveal(run: Path, truth: dict[str, dict]) -> dict:
    """Evaluate a sealed run against revealed truth and write the replay."""
    run = Path(run)
    if not run.is_dir():
        raise RevealError(f"run directory not found: {run}")
    cases = {}
    stages = ("correct", "wrong", "unavailable")
    summary = {
        "pose": dict.fromkeys(stages, 0),
        "start": dict.fromkeys(stages, 0),
        "native": {key: dict.fromkeys(stages, 0) for key in ("emitted", "refused")},
        "research": {key: dict.fromkeys(stages, 0) for key in ("accepted", "declined")},
    }
    for case_dir in sorted(path for path in run.iterdir() if path.is_dir()):
        case_id = case_dir.name
        problem = _read_json(case_dir / "problem.json")
        geometry = _read_json(case_dir / "geometry.json")
        result = _read_json(case_dir / "result.json")
        camera = problem["camera"]
        revealed = truth.get(case_id)
        truth_pose = revealed.get("model_to_camera_mm") if revealed else None
        image_path = case_dir / "image.png"
        image_uri = "data:image/png;base64," + base64.b64encode(image_path.read_bytes()).decode()

        trials = []
        for trial in result.get("runs", []):
            record = {
                key: trial.get(key)
                for key in ("label", "start", "pose", "native", "gate", "failure")
            }
            record["pose_metrics"] = _pose_metrics(
                camera, geometry["branches"], _pose(trial), truth_pose
            )
            record["start_metrics"] = _pose_metrics(
                camera, geometry["branches"], _pose(trial, "start"), truth_pose
            )
            trials.append(record)
            for stage in ("pose", "start"):
                summary[stage][_verdict(record[f"{stage}_metrics"])] += 1
            native = "emitted" if trial.get("native") is not None else "refused"
            research = "accepted" if (trial.get("gate") or {}).get("accepted") else "declined"
            summary["native"][native][_verdict(record["pose_metrics"])] += 1
            summary["research"][research][_verdict(record["pose_metrics"])] += 1

        cases[case_id] = {
            "truth_available": truth_pose is not None,
            "camera": camera,
            "geometry": geometry,
            "image_data_uri": image_uri,
            "trials": [dict(trial, truth_pose=truth_pose) for trial in trials],
        }

    report = {
        "format": _REPORT_FORMAT,
        "version": _REPORT_VERSION,
        "run": run.name,
        "cases": {
            case_id: {
                "truth_available": case["truth_available"],
                "problem": {"case_id": case_id, "camera": case["camera"]},
                "trials": [
                    {key: value for key, value in trial.items() if key != "truth_pose"}
                    for trial in case["trials"]
                ],
            }
            for case_id, case in cases.items()
        },
        "summary": summary,
    }
    (run / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (run / "replay.html").write_text(_replay_html(run.name, cases))
    return report
