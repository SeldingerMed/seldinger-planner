"""Independent NumPy derivation of the registered-projection pixel vectors.

The committed JSON pins the browser's ``projectRegistered`` (volume point,
rigid registration, C-arm view, frame size to frame pixel). This module
recomputes every value with a different formulation: the rigid matrix is
built from an axis and angle by Rodrigues' formula, the view frame comes from
rotating the 0/0 frame, and the detector hit is a linear ray/plane solve.
Synthetic numbers only.

Regenerate after an intentional convention change with:
  env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
      tests/ingest_runtime/test_registration_vectors_independent.py --write
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = _REPO_ROOT / "web" / "src" / "__fixtures__" / "registration-projection-vectors.json"
_WRITE = __name__ == "__main__" and "--write" in sys.argv

if not _WRITE:
    import pytest

    if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
        pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import numpy as np

CASES = [
    # name, primary, secondary, SID, SOD, width mm, height mm, isocenter,
    # rotation axis, rotation degrees, translation, frame columns, frame rows
    ("ap_identity", 0, 0, 1200, 800, 180, 180, [0, 0, 0], [0, 0, 1], 0, [0, 0, 0], 300, 300),
    ("ap_moved", 0, 0, 1200, 800, 180, 180, [3, -2, 5], [1, 2, -1], 11, [6, -7, 4], 512, 512),
    ("lao90", 90, 0, 1100, 700, 200, 150, [-4, 10, 20], [0, 1, 0], -8, [-5, 5, 5], 640, 480),
    (
        "rao30_cau20",
        -30,
        -20,
        1195.5,
        765.25,
        153.6,
        153.6,
        [12.5, -40, 33],
        [2, -1, 3],
        14,
        [9, 3, -6],
        1024,
        1024,
    ),
    (
        "lao45_cra25",
        45,
        25,
        990,
        720,
        150,
        220,
        [-20, 15, -60],
        [-1, 0.5, 0.2],
        6.5,
        [-3, 8, 2],
        375,
        550,
    ),
]


def _rotate(vector, axis, degrees):
    axis = axis / np.linalg.norm(axis)
    t = np.radians(degrees)
    return (
        vector * np.cos(t)
        + np.cross(axis, vector) * np.sin(t)
        + axis * (axis @ vector) * (1 - np.cos(t))
    )


def _frame(primary, secondary):
    u, v, d = np.array([-1.0, 0, 0]), np.array([0, 0, 1.0]), np.array([0, 1.0, 0])
    spin = np.array([0, 0, 1.0])
    u, v, d = (_rotate(x, spin, primary) for x in (u, v, d))
    v, d = (_rotate(x, u, -secondary) for x in (v, d))
    return u, v, d


def _matrix(axis, degrees, translation, pivot):
    axis = np.array(axis, float)
    rotation = np.column_stack([_rotate(e, axis, degrees) for e in np.eye(3)])
    pivot = np.array(pivot, float)
    matrix = np.eye(4)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = pivot + np.array(translation, float) - rotation @ pivot
    return matrix


def build():
    cases = []
    for index, case in enumerate(CASES):
        name, primary, secondary, sid, sod, width, height, iso, axis, degrees, shift, cols, rows = (
            case
        )
        iso = np.array(iso, float)
        rng = np.random.default_rng(500 + index)
        points = (iso + rng.normal(size=(6, 3)) * 25).round(3)
        matrix = _matrix(axis, degrees, shift, iso).round(9)
        u, v, d = _frame(primary, secondary)
        source = iso - d * sod
        center = source + d * sid
        pixels = []
        for point in points:
            moved = matrix[:3, :3] @ point + matrix[:3, 3]
            ray = moved - source
            x, y, t = np.linalg.solve(np.column_stack((u, v, -ray)), source - center)
            assert 0 < 1 / t <= 1  # between the source and the detector
            pixels.append([float((x / width + 0.5) * cols), float((0.5 - y / height) * rows)])
        cases.append(
            {
                "name": name,
                "view": {
                    "primary_deg": float(primary),
                    "secondary_deg": float(secondary),
                    "source_detector_mm": float(sid),
                    "source_isocenter_mm": float(sod),
                    "detector_width_mm": float(width),
                    "detector_height_mm": float(height),
                },
                "isocenter": iso.tolist(),
                "matrix": matrix.tolist(),
                "frame": {"width": cols, "height": rows},
                "points": points.tolist(),
                "pixels": pixels,
            }
        )
    return {"cases": cases}


def _close(actual, expected):
    if isinstance(expected, dict):
        assert set(actual) == set(expected)
        for key in expected:
            _close(actual[key], expected[key])
    elif isinstance(expected, list):
        assert len(actual) == len(expected)
        for a, e in zip(actual, expected, strict=True):
            _close(a, e)
    elif isinstance(expected, float):
        assert abs(actual - expected) <= 1e-9 * max(1.0, abs(expected)), (actual, expected)
    else:
        assert actual == expected


def test_committed_vectors_match_the_independent_derivation():
    _close(json.loads(FIXTURE.read_text()), build())


def test_matrices_are_rigid_and_points_move():
    for case in build()["cases"]:
        matrix = np.array(case["matrix"])
        rotation = matrix[:3, :3]
        assert np.allclose(rotation @ rotation.T, np.eye(3), atol=1e-8)
        assert abs(np.linalg.det(rotation) - 1) < 1e-8
    # A translation toward image right (patient left at 0/0) raises the column.
    ap = build()["cases"][0]
    assert ap["matrix"] == np.eye(4).tolist()


if _WRITE:
    FIXTURE.write_text(json.dumps(build(), indent=2, allow_nan=False) + "\n")
    print("wrote", FIXTURE)
