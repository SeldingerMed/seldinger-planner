"""Independent NumPy derivation of the committed C-arm geometry vectors.

The committed JSON is the shared known-value fixture for the stdlib Python
implementation and its TypeScript mirror. This module recomputes every value
with a different formulation (Rodrigues rotations of the 0/0 frame, a linear
solve for the ray/detector intersection, and in-plane segment lengths) and
requires the committed file to agree. Synthetic numbers only.

Regenerate after an intentional convention change with:
  env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
      tests/ingest_runtime/test_carm_vectors_independent.py --write
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = _REPO_ROOT / "web" / "src" / "__fixtures__" / "carm-geometry-vectors.json"
_WRITE = __name__ == "__main__" and "--write" in sys.argv

if not _WRITE:
    import pytest

    if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
        pytest.skip("Requires isolated ingest runtime", allow_module_level=True)

import numpy as np

CASES = [
    # name, primary, secondary, SID, SOD, width, height, isocenter, path
    ("ap", 0, 0, 1200, 750, 200, 200, [0, 0, 0], [[-10, 0, 0], [10, 0, 0]]),
    ("lao90", 90, 0, 1200, 750, 200, 200, [0, 0, 0], [[0, -10, 0], [0, 10, 0], [0, 10, 8]]),
    ("pa", 180, 0, 1100, 700, 300, 240, [4, -3, 2], [[4, -3, 2], [9, -3, 14]]),
    ("cranial90", 0, 90, 1000, 600, 200, 200, [0, 0, 0], [[-5, 2, 0], [5, 2, 0]]),
    ("rao30_cau20", -30, -20, 1195.5, 765.25, 180, 180, [12.5, -40, 33], None),
    ("lao45_cra25", 45, 25, 990, 720, 150, 220, [-20, 15, -60], None),
    ("steep", -117.5, 41.25, 1500, 810, 420, 380, [3, 3, 3], None),
    ("out_of_field", 10, -5, 1200, 750, 50, 50, [0, 0, 0], [[-60, 0, -60], [70, 5, 60]]),
    (
        "end_on",
        0,
        0,
        1200,
        750,
        200,
        200,
        [0, 0, 0],
        [[0, -15, 0], [0, 15, 0]],
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
    # Tilting about the rotated image-right axis by -secondary lifts the
    # detector toward the head for a positive (cranial) secondary angle.
    v, d = (_rotate(x, u, -secondary) for x in (v, d))
    return u, v, d


def _default_path(isocenter, seed):
    rng = np.random.default_rng(seed)
    steps = rng.normal(size=(4, 3)) * 6
    return (np.array(isocenter, float) + np.cumsum(steps, axis=0) - steps.sum(axis=0) / 2).tolist()


def build():
    cases = []
    for index, (name, primary, secondary, sid, sod, width, height, iso, path) in enumerate(CASES):
        iso = np.array(iso, float)
        path = path if path is not None else _default_path(iso, 100 + index)
        u, v, d = _frame(primary, secondary)
        source = iso - d * sod
        center = source + d * sid
        projected = []
        for point in np.array(path, float):
            ray = point - source
            x, y, t = np.linalg.solve(np.column_stack((u, v, -ray)), source - center)
            projected.append([float(x), float(y), float(ray @ d)])
            assert t > 0
        segments = np.diff(np.array(path, float), axis=0)
        seen = np.hypot(segments @ u, segments @ v).sum()
        true = np.linalg.norm(segments, axis=1).sum()
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
                "path": [[float(x) for x in p] for p in path],
                "frame": {"u": u.tolist(), "v": v.tolist(), "d": d.tolist()},
                "source": source.tolist(),
                "projected": projected,
                "foreshortening_percent": float(100 * (1 - seen / true)),
                "magnification_at_isocenter": float(sid / sod),
                "target_in_field": bool(
                    all(abs(x) <= width / 2 and abs(y) <= height / 2 for x, y, _ in projected)
                ),
            }
        )
    return {
        "note": "Synthetic vectors derived independently with NumPy; see tests/ingest_runtime/test_carm_vectors_independent.py",
        "convention": "dicom_xa_patient_longitude_latitude_ras_v1",
        "cases": cases,
        "labels": [
            {"primary_deg": p, "secondary_deg": s, "label": label} for p, s, label in LABELS
        ],
        "fixed": [{"value": v, "digits": d, "text": text} for v, d, text in FIXED],
    }


# Operator-facing angle text, written out by hand. A half at the first decimal
# rounds away from zero (45.25 reads 45.3), which is what the browser's toFixed
# does with these exactly representable values; 12.35 and 12.65 are not exact
# halves in binary and round to the nearer side of the stored value.
LABELS = [
    (30.0, 20.0, "LAO 30.0 / CRA 20.0"),
    (0.0, 0.0, "LAO/RAO 0.0 / CRA/CAU 0.0"),
    (0.04, -0.04, "LAO/RAO 0.0 / CRA/CAU 0.0"),
    (-45.25, -10.0, "RAO 45.3 / CAU 10.0"),
    (0.25, -0.75, "LAO 0.3 / CAU 0.8"),
    (-30.5, 20.25, "RAO 30.5 / CRA 20.3"),
    (12.35, -12.65, "LAO 12.3 / CAU 12.7"),
    (89.95, 0.125, "LAO 90.0 / CRA 0.1"),
    (-180.0, 90.0, "RAO 180.0 / CRA 90.0"),
]


# Fixed-point text shared by the exported brief (Python) and the studio
# (ECMAScript toFixed). Written by hand; checked below with exact rationals.
FIXED = [
    (45.25, 1, "45.3"),
    (-45.25, 1, "-45.3"),
    (0.125, 2, "0.13"),
    (1.005, 2, "1.00"),
    (2.5, 0, "3"),
    (1200.0, 1, "1200.0"),
    (1.6, 3, "1.600"),
    (50.94999, 1, "50.9"),
    (0.0625, 3, "0.063"),
]


def test_fixed_table_follows_exact_half_away_from_zero_rounding():
    from fractions import Fraction

    for value, digits, text in FIXED:
        scaled = Fraction(abs(value)) * 10**digits
        whole = scaled.numerator // scaled.denominator
        whole += 1 if scaled - whole >= Fraction(1, 2) else 0
        body = str(whole).rjust(digits + 1, "0")
        expected = body[: len(body) - digits] + ("." + body[len(body) - digits :] if digits else "")
        assert ("-" if value < 0 else "") + expected == text


def test_label_table_follows_exact_half_away_from_zero_rounding():
    from decimal import ROUND_HALF_UP, Decimal
    from fractions import Fraction

    for primary, secondary, label in LABELS:
        parts = []
        for value, positive, negative in ((primary, "LAO", "RAO"), (secondary, "CRA", "CAU")):
            # Exact rational arithmetic on the stored double, no float formatting.
            tenths = Fraction(abs(value)) * 10
            whole = tenths.numerator // tenths.denominator
            whole += 1 if tenths - whole >= Fraction(1, 2) else 0
            if abs(value) < 0.05:
                parts.append(f"{positive}/{negative} 0.0")
            else:
                parts.append(f"{positive if value > 0 else negative} {whole // 10}.{whole % 10}")
            assert Decimal(whole).scaleb(-1) == Decimal(abs(value)).quantize(
                Decimal("0.1"), rounding=ROUND_HALF_UP
            )
        assert " / ".join(parts) == label


def _close(actual, expected):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys()
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


def test_declared_anatomical_anchors():
    # RAS: +x right, +y anterior, +z superior.
    _, v, d = _frame(0, 0)
    assert np.allclose(d, [0, 1, 0]) and np.allclose(v, [0, 0, 1])  # detector anterior
    assert np.allclose(_frame(90, 0)[2], [-1, 0, 0])  # LAO: detector at patient left
    assert np.allclose(_frame(-90, 0)[2], [1, 0, 0])  # RAO: detector at patient right
    assert np.allclose(_frame(0, 90)[2], [0, 0, 1])  # cranial: detector toward the head
    for primary, secondary in ((33, -21), (-140, 60)):
        u, v, d = _frame(primary, secondary)
        assert np.allclose(np.cross(u, v), d)


if _WRITE:
    FIXTURE.write_text(json.dumps(build(), indent=2, allow_nan=False) + "\n")
    print("wrote", FIXTURE)
