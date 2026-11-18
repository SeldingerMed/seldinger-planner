"""Tests for the Lumen reveal evaluator: scripts/research/lumen_reveal.py.

Invented numerical fixtures only. No real answers, no Lumen repository, no
production artifacts are touched.
"""

import base64
import importlib.util
import json
import struct
import sys
import zlib
from pathlib import Path

RESEARCH = Path(__file__).resolve().parent.parent / "scripts" / "research"


def load(name):
    spec = importlib.util.spec_from_file_location(name, RESEARCH / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lumen_reveal = load("lumen_reveal")


def tiny_png(width=4, height=4, gray=100):
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


IDENTITY = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
]


def camera(width=100, height=100, fx=100.0, fy=100.0, cx=50.0, cy=50.0):
    return {
        "width_px": width,
        "height_px": height,
        "fx_px": fx,
        "fy_px": fy,
        "cx_px": cx,
        "cy_px": cy,
        "source_to_detector_mm": 1000.0,
    }


# Two branches at depth 200 mm so a 3 mm lateral model shift projects to
# exactly 1.5 px at fx=fy=100: known target and reprojection RMS.
BRANCHES = [
    {"points_mm": [[0.0, 0.0, 200.0], [10.0, 0.0, 200.0]]},
    {"points_mm": [[0.0, 20.0, 200.0], [5.0, 25.0, 200.0]]},
]

CAMERA = camera()


def pose_with_shift_mm(dx, dy=0.0, dz=0.0):
    pose = [row[:] for row in IDENTITY]
    pose[0][3] += dx
    pose[1][3] += dy
    pose[2][3] += dz
    return pose


def answer(pose):
    return {"model_to_camera_mm": pose}


def write_case(run, case_id, runs, problem=None, geometry=None, image=True):
    case = run / case_id
    case.mkdir(parents=True)
    problem = problem or {"case_id": case_id, "camera": CAMERA}
    geometry = geometry or {"branches": BRANCHES}
    (case / "problem.json").write_text(json.dumps(problem))
    (case / "geometry.json").write_text(json.dumps(geometry))
    if image:
        (case / "image.png").write_bytes(tiny_png())
    (case / "result.json").write_text(json.dumps({"case_id": case_id, "runs": runs}))
    return case


def trial(label, start, pose, gate=None, native=None, failure=None):
    return {
        "label": label,
        "start": start,
        "pose": pose,
        "native": native,
        "gate": gate or {"accepted": True, "reasons": []},
        "failure": failure,
    }


def test_correct_trial_measures_known_target_and_reprojection_rms(tmp_path):
    run = tmp_path / "run"
    # 3 mm lateral shift: target RMS exactly 3 mm, reprojection RMS exactly 1.5 px.
    write_case(
        run,
        "case-a",
        [trial("final", answer(pose_with_shift_mm(3.0)), answer(pose_with_shift_mm(3.0)))],
    )
    report = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    case = report["cases"]["case-a"]
    metrics = case["trials"][0]["pose_metrics"]
    assert abs(metrics["target_mm_rms"] - 3.0) < 1e-9
    assert abs(metrics["reprojection_px_rms"] - 1.5) < 1e-9
    assert metrics["correct"] is True
    assert case["trials"][0]["start_metrics"] == metrics
    assert (run / "report.json").exists()
    assert (run / "replay.html").exists()


def test_correct_requires_both_thresholds(tmp_path):
    run = tmp_path / "run"
    # 6 mm lateral shift: target 6 mm fails, 3 px passes -> wrong (conjunction).
    write_case(run, "case-a", [trial("f", None, answer(pose_with_shift_mm(6.0)))])
    metrics = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})["cases"]["case-a"]["trials"][
        0
    ]["pose_metrics"]
    assert metrics["target_mm_rms"] > 5.0 and metrics["reprojection_px_rms"] <= 5.0
    assert metrics["correct"] is False
    # 2 mm vertical shift with fy=1000: 10 px reprojection fails, target passes.
    write_case(
        run,
        "case-b",
        [trial("f", None, answer(pose_with_shift_mm(0.0, 2.0)))],
        problem={"case_id": "case-b", "camera": camera(fy=1000.0)},
    )
    metrics = lumen_reveal.reveal(run, {"case-b": answer(IDENTITY)})["cases"]["case-b"]["trials"][
        0
    ]["pose_metrics"]
    assert metrics["target_mm_rms"] <= 5.0 and metrics["reprojection_px_rms"] > 5.0
    assert metrics["correct"] is False


def test_depth_cap_point_behind_camera_is_unavailable(tmp_path):
    run = tmp_path / "run"
    geometry = {"branches": [{"points_mm": [[0.0, 0.0, -50.0]]}]}
    write_case(run, "case-a", [trial("f", answer(IDENTITY), answer(IDENTITY))], geometry=geometry)
    report = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    record = report["cases"]["case-a"]["trials"][0]
    assert record["pose_metrics"] is None
    assert record["start_metrics"] is None
    assert report["summary"]["pose"]["unavailable"] == 1


def test_missing_start_null_pose_and_missing_native_preserved(tmp_path):
    run = tmp_path / "run"
    write_case(
        run,
        "case-a",
        [
            trial("no-native", answer(pose_with_shift_mm(3.0)), answer(pose_with_shift_mm(3.0))),
            trial(
                "no-start",
                None,
                None,
                gate={"accepted": False, "reasons": ["depth starts disagree"]},
                native={"emitted": True},
                failure="refused",
            ),
        ],
    )
    report = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    trials = report["cases"]["case-a"]["trials"]
    assert trials[0]["native"] is None
    assert trials[0]["pose_metrics"]["correct"] is True
    assert trials[1]["start"] is None and trials[1]["start_metrics"] is None
    assert trials[1]["pose_metrics"] is None
    assert trials[1]["gate"] == {"accepted": False, "reasons": ["depth starts disagree"]}
    assert trials[1]["failure"] == "refused"
    assert trials[1]["native"] == {"emitted": True}


def test_case_without_revealed_truth_is_reported_not_measured(tmp_path):
    run = tmp_path / "run"
    write_case(run, "case-a", [trial("final", answer(IDENTITY), answer(IDENTITY))])
    write_case(run, "case-b", [trial("final", answer(IDENTITY), answer(IDENTITY))])
    report = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    assert report["cases"]["case-b"]["truth_available"] is False
    assert report["cases"]["case-b"]["trials"][0]["pose_metrics"] is None
    assert report["cases"]["case-a"]["truth_available"] is True


def test_report_is_stable_and_has_no_absolute_paths(tmp_path):
    run = tmp_path / "run"
    write_case(run, "case-a", [trial("final", answer(IDENTITY), answer(IDENTITY))])
    report = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    assert report["format"] == "lumen_reveal_report"
    assert report["run"] == "run"
    text = (run / "report.json").read_text()
    assert str(tmp_path) not in text
    trial_keys = set(report["cases"]["case-a"]["trials"][0])
    assert {
        "label",
        "start",
        "pose",
        "native",
        "gate",
        "failure",
        "start_metrics",
        "pose_metrics",
    } <= trial_keys
    assert "truth_pose" not in trial_keys and "truth_pose" not in text


def test_summary_counts_and_crosstabs(tmp_path):
    run = tmp_path / "run"
    write_case(
        run,
        "case-a",
        [
            trial(
                "good",
                answer(pose_with_shift_mm(3.0)),
                answer(pose_with_shift_mm(3.0)),
                native={"emitted": True},
            ),
            trial(
                "bad",
                answer(pose_with_shift_mm(8.0)),
                answer(pose_with_shift_mm(8.0)),
                native={"emitted": True},
            ),
            trial("gone", answer(IDENTITY), None, native={"emitted": True}),
            trial(
                "refused-native", answer(pose_with_shift_mm(3.0)), answer(pose_with_shift_mm(3.0))
            ),
            trial(
                "declined",
                answer(pose_with_shift_mm(3.0)),
                answer(pose_with_shift_mm(3.0)),
                gate={"accepted": False, "reasons": ["unsupported branches"]},
                native={"emitted": True},
            ),
        ],
    )
    summary = lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})["summary"]
    assert summary["pose"] == {"correct": 3, "wrong": 1, "unavailable": 1}
    assert summary["native"]["emitted"]["correct"] == 2
    assert summary["native"]["emitted"]["wrong"] == 1
    assert summary["native"]["emitted"]["unavailable"] == 1
    assert summary["native"]["refused"]["correct"] == 1
    assert summary["research"]["accepted"]["wrong"] == 1
    assert summary["research"]["declined"]["correct"] == 1


def candidate_svg(html_text, case_id):
    """The candidate overlay svg block, excluding the expandable truth details."""
    start = html_text.index(f'<svg class="panel-svg" id="candidate-{case_id}')
    end = html_text.index("</svg>", start)
    return html_text[start:end]


def test_svg_native_geometry_branch_strings_and_breaks(tmp_path):
    run = tmp_path / "run"
    geometry = {
        "branches": [
            {
                "points_mm": [
                    [0.0, 0.0, 200.0],
                    [10.0, 0.0, 200.0],
                    [10.0, 0.0, -200.0],
                    [20.0, 0.0, 200.0],
                ]
            },
            {"points_mm": [[0.0, 20.0, 200.0], [5.0, 20.0, 200.0]]},
        ]
    }
    write_case(run, "case-a", [trial("f", None, answer(IDENTITY))], geometry=geometry)
    lumen_reveal.reveal(run, {"case-a": answer(IDENTITY)})
    html = (run / "replay.html").read_text()
    # Native pixel viewBox with half-pixel origin; image embedded at the same box.
    assert '<svg class="panel-svg" id="candidate-case-a-f" viewBox="-0.5 -0.5 100 100">' in html
    assert '<image x="-0.5" y="-0.5" width="100" height="100"' in html
    svg = candidate_svg(html, "case-a-f")
    # Point (10, 0, 200) projects with fx=100, cx=50 -> (55, 50); string, not list.
    assert 'points="50.00,50.00 55.00,50.00"' in svg
    # The behind-camera point caps the polyline: the branch splits, never
    # connecting (55,50) to the later (60,50) segment across the gap.
    assert 'points="60.00,50.00"' in svg
    assert svg.count("<polyline") == 3  # 1 + 1 (broken) + 1 branches
    assert 'points="50.00,50.00 55.00,50.00 60.00,50.00"' not in svg


def test_candidate_panel_excludes_truth_truth_in_expandable_details(tmp_path):
    run = tmp_path / "run"
    write_case(run, "case-a", [trial("f", None, answer(IDENTITY))])
    lumen_reveal.reveal(run, {"case-a": answer(pose_with_shift_mm(-4.0, -4.0))})
    html = (run / "replay.html").read_text()
    candidate = candidate_svg(html, "case-a-f")
    # Truth projects its shifted points at (48,48)/(48,58): absent from candidate.
    assert "48.00,48.00" not in candidate and "48.00,58.00" not in candidate
    assert "50.00,50.00" in candidate
    details = html[html.index("<details") :]
    assert "48.00,48.00" in details and "truth" in details.lower()
    assert html.index("<details") > html.index("</svg>", html.index("<svg"))
    # Raw uncolored image drawn beside the candidate, and both thresholds shown.
    assert 'id="raw-case-a-f"' in html
    assert "5 mm" in html and "5 px" in html


def test_replay_html_handles_unavailable_stages_and_escapes_text(tmp_path):
    run = tmp_path / "run"
    label = 'ev<span>&"x'
    write_case(run, 'case<"&a', [trial(label, None, None, failure="no estimate")])
    lumen_reveal.reveal(run, {'case<"&a': answer(IDENTITY)})
    html = (run / "replay.html").read_text()
    assert "case&lt;&quot;&amp;a" in html
    expected = (
        label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    )
    assert expected in html
    assert "unavailable" in html
    assert "no estimate" in html
    png = tiny_png()
    assert html.count(base64.b64encode(png).decode()) >= 2  # raw + candidate panels
    assert 'src="http' not in html and 'href="http' not in html


def test_candidate_ink_does_not_reveal_reference_verdict(tmp_path):
    run = tmp_path / "run"
    write_case(run, "same", [trial("test", answer(IDENTITY), answer(IDENTITY))])

    def candidate(ref):
        lumen_reveal.reveal(run, {"same": answer(ref)})
        return (run / "replay.html").read_text().split("<details>")[0]

    assert candidate(IDENTITY) == candidate(pose_with_shift_mm(20))
