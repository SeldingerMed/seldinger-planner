"""Broader context is a distinct source, preserving earlier case/source history."""

from types import SimpleNamespace

import pytest

from planner.source_registry import ImageSourceRegistry

HASH_V3 = "88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3"
HASH_PLANNING = "26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473"


def provider(digest, shape):
    return SimpleNamespace(
        load=lambda: (
            {
                "image": {
                    "sha256": digest,
                    "affine_ras": [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
                },
                "crop": {"size_voxels": shape},
                "source_header": {"xyzt_units": 0},
            },
            "b" * 64,
            {},
        )
    )


@pytest.mark.parametrize(
    "digest,shape,units,source_id",
    [
        (HASH_V3, [56, 77, 50], "mm", "zenodo-case006-calibrated"),
        (HASH_PLANNING, [200, 200, 180], "mm", "zenodo-case006-planning-context"),
        ("a" * 64, [2, 2, 2], "unknown", "cmha-ahmu1218001-context"),
    ],
)
def test_distinct_contexts_keep_case_source_revision_bindings(digest, shape, units, source_id):
    registry = ImageSourceRegistry(
        provider("a" * 64, [2, 2, 2]),
        provider(HASH_V3, [56, 77, 50]),
        planning_store=provider(HASH_PLANNING, [200, 200, 180]),
    )
    case = {
        "case_id": "synthetic-only",
        "image_sha256": digest,
        "dimensions": shape,
        "spacing_mm": [1, 1, 1],
        "spatial_units": units,
    }
    bundle = registry.load_for_case(case)
    assert bundle[0]["source_id"] == source_id
    assert bundle[0]["image"]["sha256"] == digest
    assert bundle[1] == "b" * 64
