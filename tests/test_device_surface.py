import struct

from test_segmentation_server import _stage, post_request


def test_surface_requires_mm_case_before_any_worker(tmp_path):
    client, case, _, _ = _stage(tmp_path)
    candidate = post_request(client, case).json()
    result = client.get(
        f"/api/cases/{case['case_id']}/segmentations/{candidate['candidate_id']}/surface"
    )
    assert result.status_code == 422


def test_stl_serializer_preserves_physical_vertices_and_caps():
    from planner.device_surface import triangles_to_stl

    data = triangles_to_stl([[[10, 20, 30], [11, 20, 30], [10, 21, 30]]])
    assert len(data) == 134
    assert struct.unpack_from("<I", data, 80) == (1,)
    assert struct.unpack_from("<3f", data, 96) == (10, 20, 30)


def test_surface_roundtrip_is_bound_to_accepted_mask(tmp_path, monkeypatch):
    import hashlib

    from test_segmentation_server import make_client, make_runner
    from test_source_registry import CALIBRATED_HASH, Provider
    from test_source_registry import case as source_case

    from planner.device_surface import triangles_to_stl

    client, _, _, _ = make_client(
        tmp_path, make_runner(), calibrated_source_store=Provider(CALIBRATED_HASH, "mm")
    )
    seed = source_case()
    seed.pop("case_id")
    case = client.post("/api/cases", json={"title": "Synthetic mm scene fixture", **seed}).json()
    response = post_request(client, case, reference_revision="b" * 64)
    assert response.status_code == 200, response.text
    candidate = response.json()
    path = f"/api/cases/{case['case_id']}/segmentations/{candidate['candidate_id']}"
    assert client.get(path + "/surface").status_code == 409
    accepted = client.post(
        path + "/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": "b" * 64,
            "decision": "accept",
        },
    )
    assert accepted.status_code == 200
    data = triangles_to_stl([[[10, 20, 30], [11, 20, 30], [10, 21, 30]]])
    seen = []

    def worker(mask_path, sha):
        seen.append((mask_path.name, sha))
        return data

    monkeypatch.setattr("planner.device_surface.build_surface", worker)
    response = client.get(path + "/surface")
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["x-mask-sha256"] == candidate["mask_sha256"]
    assert response.headers["x-surface-sha256"] == hashlib.sha256(data).hexdigest()
    assert seen == [(candidate["mask_sha256"] + ".nii.gz", candidate["mask_sha256"])]

    # Simulate a same-ID metadata replacement after the producer finishes.
    from planner.segmentation_state import SegmentationLedger

    original_entry = SegmentationLedger.entry
    swapped = {"ready": False}

    def read_entry(self, *args, **kwargs):
        value = original_entry(self, *args, **kwargs)
        return {**value, "mask_sha256": "f" * 64} if swapped["ready"] else value

    def racing_worker(*args):
        swapped["ready"] = True
        return data

    monkeypatch.setattr(SegmentationLedger, "entry", read_entry)
    monkeypatch.setattr("planner.device_surface.build_surface", racing_worker)
    assert client.get(path + "/surface").status_code == 409


def test_stl_rejects_nonfinite_or_oversize_geometry():
    import pytest

    from planner.device_surface import triangles_to_stl

    with pytest.raises(ValueError):
        triangles_to_stl([[[float("nan"), 0, 0], [1, 0, 0], [0, 1, 0]]])
    with pytest.raises(ValueError):
        triangles_to_stl([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]] * 50001)
