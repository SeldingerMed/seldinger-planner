"""Synthetic API proof of server-selected existing-mask correction inputs."""

import pytest
from test_segmentation_server import make_case, make_client, make_runner, post_request


@pytest.mark.parametrize(
    "state", ["preview", "rejected", "superseded", "foreign_case", "wrong_role"]
)
def test_only_current_case_owned_accepted_aneurysm_can_seed_correction(tmp_path, state):
    jobs = []
    client, _, manifest, _ = make_client(tmp_path, make_runner(job_log=jobs))
    case = make_case(client, manifest)
    if state in ("preview", "rejected"):
        base = post_request(client, case, kind="aneurysm", role="aneurysm").json()
        if state == "rejected":
            response = client.post(
                f"/api/cases/{case['case_id']}/segmentations/{base['candidate_id']}/decision",
                json={
                    "artifact_version": case["artifact_version"],
                    "reference_revision": base["reference_revision"],
                    "decision": "reject",
                },
            )
            assert response.status_code == 200
    elif state == "foreign_case":
        foreign_case = make_case(client, manifest)
        _, base = accept_base(client, foreign_case)
    elif state == "wrong_role":
        base = post_request(client, case).json()
        decision = client.post(
            f"/api/cases/{case['case_id']}/segmentations/{base['candidate_id']}/decision",
            json={
                "artifact_version": case["artifact_version"],
                "reference_revision": base["reference_revision"],
                "decision": "accept",
            },
        )
        assert decision.status_code == 200
        case = client.get(f"/api/cases/{case['case_id']}").json()
    else:
        case, base = accept_base(client, case)
        case, _ = accept_base(client, case)
    count = len(jobs)
    response = post_request(
        client,
        case,
        kind="sam2",
        role="aneurysm",
        point_ras=[1.0, 2.0, 3.0],
        base_candidate_id=base["candidate_id"],
    )
    assert response.status_code == 409, response.text
    assert len(jobs) == count


def test_tampered_base_blob_is_refused_before_the_worker(tmp_path):
    jobs = []
    client, _, manifest, results = make_client(tmp_path, make_runner(job_log=jobs))
    case, base = accept_base(client, make_case(client, manifest))
    (results / "blobs" / (base["mask_sha256"] + ".nii.gz")).write_bytes(b"tampered fixture")
    count = len(jobs)
    response = post_request(
        client,
        case,
        kind="sam2",
        role="aneurysm",
        point_ras=[1.0, 2.0, 3.0],
        base_candidate_id=base["candidate_id"],
    )
    assert response.status_code == 503
    assert len(jobs) == count


def test_unseeded_sam_cannot_replace_an_existing_accepted_aneurysm(tmp_path):
    jobs = []
    client, _, manifest, _ = make_client(tmp_path, make_runner(job_log=jobs))
    case, _ = accept_base(client, make_case(client, manifest))
    count = len(jobs)
    response = post_request(
        client,
        case,
        kind="sam2",
        role="aneurysm",
        point_ras=[1.0, 2.0, 3.0],
    )
    assert response.status_code == 422
    assert len(jobs) == count


def test_non_sam_request_cannot_claim_existing_mask_correction(tmp_path):
    jobs = []
    client, _, manifest, _ = make_client(tmp_path, make_runner(job_log=jobs))
    case, base = accept_base(client, make_case(client, manifest))
    count = len(jobs)
    response = post_request(
        client,
        case,
        kind="aneurysm",
        role="aneurysm",
        base_candidate_id=base["candidate_id"],
    )
    assert response.status_code == 422
    assert len(jobs) == count


def accept_base(client, case):
    preview = post_request(client, case, kind="aneurysm", role="aneurysm")
    assert preview.status_code == 200, preview.text
    entry = preview.json()
    decision = client.post(
        f"/api/cases/{case['case_id']}/segmentations/{entry['candidate_id']}/decision",
        json={
            "artifact_version": case["artifact_version"],
            "reference_revision": entry["reference_revision"],
            "decision": "accept",
        },
    )
    assert decision.status_code == 200, decision.text
    current_case = client.get(f"/api/cases/{case['case_id']}").json()
    return current_case, decision.json()


def test_correction_job_binds_server_selected_current_base_without_path_inputs(tmp_path):
    jobs = []
    client, _, manifest, _ = make_client(tmp_path, make_runner(job_log=jobs))
    case, base = accept_base(client, make_case(client, manifest))
    response = post_request(
        client,
        case,
        kind="sam2",
        role="aneurysm",
        point_ras=[1.0, 2.0, 3.0],
        base_candidate_id=base["candidate_id"],
        point_label=0,
    )
    assert response.status_code == 200, response.text
    job = jobs[-1]
    assert job["point_label"] == 0
    assert job["base_mask"] == {
        "candidate_id": base["candidate_id"],
        "mask_sha256": base["mask_sha256"],
        "image_sha256": case["image_sha256"],
        "reference_revision": base["reference_revision"],
        "segmentation_revision": base["segmentation_revision"],
        "producer": base["producer"],
    }
    assert not any("path" in name for name in job["base_mask"])
    assert response.json()["status"] == "preview"
    assert response.json()["producer"] == "sam2_prompted_slice"
