import json
import math

import pytest
from fastapi.testclient import TestClient

from planner.occlusion_estimates import (
    SCHEMA,
    TOOL_SCHEMA,
    OcclusionModel,
    OcclusionModelError,
)
from planner.providers import Completion
from planner.server import build_app

TECHNIQUES = ["coil", "BAC", "SAC", "FD", "FD_coil", "WEB", "intrasaccular_other", "clip"]
FAMILY = {
    "coil": "coiling",
    "BAC": "coiling",
    "SAC": "coiling",
    "FD": "fd",
    "FD_coil": "fd",
    "WEB": "intrasaccular",
    "intrasaccular_other": "intrasaccular",
    "clip": "clip",
}
FAMILIES = ["coiling", "fd", "intrasaccular", "clip"]
COVS = ["ruptured", "posterior", "wide_neck", "bifurcation"]
# Gauss-Hermite (probabilists') 3-point rule: nodes 0, +-sqrt(3), weights 2/3, 1/6, 1/6.
NODES = [-math.sqrt(3), 0.0, math.sqrt(3)]
WEIGHTS = [1 / 6, 2 / 3, 1 / 6]


def synthetic_spec(**overrides):
    names = [f"int:{t}" for t in TECHNIQUES] + [f"time:{t}" for t in TECHNIQUES]
    names += [f"imm:{f}" for f in FAMILIES] + [f"log_size:{f}" for f in FAMILIES] + COVS
    beta = {n: 0.0 for n in names}
    beta.update(
        {
            "int:clip": 2.0,
            "int:FD": 1.2,
            "int:coil": 0.4,
            "int:WEB": 0.5,
            "time:FD": 0.8,
            "imm:fd": -2.0,
            "log_size:coiling": -0.9,
            "log_size:fd": -0.5,
            "ruptured": 0.2,
            "wide_neck": -0.4,
        }
    )
    imputation = {
        f: {
            "log_size": math.log(7),
            "ruptured": 0.3,
            "posterior": 0.1,
            "wide_neck": 0.5,
            "bifurcation": 0.3,
        }
        for f in FAMILIES
    }
    spec = {
        "schema": SCHEMA,
        "outcome": "complete",
        "names": names,
        "beta": [beta[n] for n in names],
        "tau": 0.5,
        "bootstrap": [
            {"beta": [beta[n] + d for n in names], "tau": 0.5} for d in (-0.2, -0.1, 0.0, 0.1, 0.2)
        ],
        "family": FAMILY,
        "ref": {
            "log_size": math.log(7),
            "ruptured": 0,
            "posterior": 0,
            "wide_neck": 0.5,
            "bifurcation": 0.3,
        },
        "t_ref_months": 12,
        "imputation_means": imputation,
        "gh_nodes": NODES,
        "gh_weights": WEIGHTS,
        "evidence": {"FD": {"studies": 40, "aneurysms_weighted": 5000}},
        "studies": 300,
        "validation": {"study_grouped_cv": {"weighted_mae": 0.1}},
        "sha256": "f" * 64,
    }
    spec.update(overrides)
    return spec


def test_estimates_follow_the_fitted_coefficients():
    model = OcclusionModel(synthetic_spec())
    out = model.estimate(
        {"max_size_mm": 7, "neck_mm": 5, "rupture_status": "unruptured", "months": 12}
    )
    by = {e["technique"]: e for e in out["estimates"]}
    assert set(by) == {
        "Coiling",
        "Balloon-assisted coiling",
        "Stent-assisted coiling",
        "Flow diverter",
        "Flow diverter with coils",
        "WEB intrasaccular device",
        "Microsurgical clipping",
    }
    # Ordered by expected complete occlusion; clipping has the largest intercept.
    assert out["estimates"][0]["technique"] == "Microsurgical clipping"
    fd = by["Flow diverter"]
    # eta = 1.2 + wide-neck (1 - 0.5) * -0.4 = 1.0, integrated over the 3-point rule.
    expected = sum(w / (1 + math.exp(-(1.0 + 0.5 * z))) for z, w in zip(NODES, WEIGHTS))
    assert fd["complete_occlusion"] == round(expected, 3)
    assert fd["ci95"][0] < fd["complete_occlusion"] < fd["ci95"][1]
    lo, hi = fd["between_centre_range95"]
    assert lo < fd["complete_occlusion"] < hi
    assert fd["published_studies"] == 40
    assert out["inputs"]["wide_neck"] is True
    assert out["set_to_published_average"] == ["circulation", "bifurcation location"]


def test_time_and_size_move_estimates_in_the_fitted_direction():
    model = OcclusionModel(synthetic_spec())

    def fd(**args):
        out = model.estimate({"treatments": ["flow_diversion"], **args})
        return next(e for e in out["estimates"] if e["technique"] == "Flow diverter")[
            "complete_occlusion"
        ]

    assert fd(months=0) < fd(months=6) < fd(months=24)
    assert fd(max_size_mm=20) < fd(max_size_mm=5)


def test_unknown_inputs_use_published_averages_and_are_listed():
    out = OcclusionModel(synthetic_spec()).estimate({"treatments": ["clipping"]})
    assert [e["treatment"] for e in out["estimates"]] == ["clipping"]
    assert out["months_after_treatment"] == 12
    assert out["set_to_published_average"] == [
        "aneurysm size",
        "rupture status",
        "circulation",
        "neck width",
        "bifurcation location",
    ]


def test_small_dome_to_neck_ratio_counts_as_wide_neck():
    out = OcclusionModel(synthetic_spec()).estimate({"max_size_mm": 5, "neck_mm": 3})
    assert out["inputs"]["wide_neck"] is True
    out = OcclusionModel(synthetic_spec()).estimate({"max_size_mm": 9, "neck_mm": 3})
    assert out["inputs"]["wide_neck"] is False


@pytest.mark.parametrize(
    "override,message",
    [
        ({"schema": "other"}, "Unsupported occlusion model schema"),
        ({"beta": [0.0]}, "beta length does not match names"),
        ({"tau": float("nan")}, "tau must contain finite numbers"),
        ({"gh_weights": [0.5, 0.5, 0.5]}, "Quadrature nodes and weights are inconsistent"),
        ({"family": {}}, "Model does not cover coil"),
    ],
)
def test_damaged_model_files_are_refused(override, message):
    with pytest.raises(OcclusionModelError, match=message):
        OcclusionModel(synthetic_spec(**override))


def test_load_returns_none_when_no_model_is_installed(tmp_path, monkeypatch):
    monkeypatch.delenv("SELDINGER_OCCLUSION_MODEL", raising=False)
    assert OcclusionModel.load(tmp_path / "absent.json") is None
    path = tmp_path / "model.json"
    path.write_text(json.dumps(synthetic_spec()))
    assert OcclusionModel.load(path).studies == 300


def _case(client):
    case = client.post(
        "/api/cases",
        json={
            "title": "Synthetic treatment-options case",
            "image_sha256": "e" * 64,
            "dimensions": [16, 16, 16],
            "spacing_mm": [1, 1, 1],
            "spatial_units": "unknown",
        },
    ).json()
    return case


def _call(step, name, args):
    return Completion(
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": f"call-{step}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)},
                }
            ],
        },
        "tool_calls",
        {},
    )


def test_discussion_offers_the_estimate_tool_and_returns_its_numbers(tmp_path):
    seen = {}

    class Model:
        def __enter__(self):
            self.step = 0
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            self.step += 1
            if self.step == 1:
                seen["tools"] = [t["function"]["name"] for t in tools]
                seen["prompt"] = messages[-1]["content"]
                return _call(1, "read_case_plan", {})
            if self.step == 2:
                return _call(2, "estimate_occlusion_by_treatment", {"max_size_mm": 8, "months": 12})
            seen["tool_result"] = json.loads(messages[-1]["content"])
            return Completion(
                {"role": "assistant", "content": "Clipping has the highest published occlusion."},
                "stop",
                {},
            )

    model = OcclusionModel(synthetic_spec())
    client = TestClient(
        build_app(tmp_path / "workspace.sqlite3", client_factory=Model, occlusion_model=model)
    )
    case = _case(client)
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": case["artifact_version"],
            "question": "What are the treatment options for this aneurysm?",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "estimate_occlusion_by_treatment" in seen["tools"]
    assert "estimate_occlusion_by_treatment" in seen["prompt"]
    assert "Do not rank or recommend" not in seen["prompt"]
    assert body["tool_names"] == ["read_case_plan", "estimate_occlusion_by_treatment"]
    assert body["occlusion_estimates"] == seen["tool_result"]
    assert body["occlusion_estimates"]["inputs"]["max_size_mm"] == 8


def test_discussion_without_an_installed_model_keeps_the_old_rules(tmp_path, monkeypatch):
    monkeypatch.setenv("SELDINGER_OCCLUSION_MODEL", str(tmp_path / "absent.json"))
    seen = {}

    class Model:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            if "tools" not in seen:
                seen["tools"] = [t["function"]["name"] for t in tools]
                seen["prompt"] = messages[-1]["content"]
                return _call(1, "read_case_plan", {})
            return Completion({"role": "assistant", "content": "No estimate."}, "stop", {})

    client = TestClient(build_app(tmp_path / "workspace.sqlite3", client_factory=Model))
    case = _case(client)
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": case["artifact_version"],
            "question": "What are the treatment options?",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 200, response.text
    assert seen["tools"] == ["read_case_plan", "read_planning_sources"]
    assert "Do not rank or recommend" in seen["prompt"]
    assert response.json()["occlusion_estimates"] is None


def test_invalid_estimate_arguments_are_rejected_before_the_tool_runs(tmp_path):
    calls = []

    class Spy(OcclusionModel):
        def estimate(self, args):
            calls.append(args)
            return super().estimate(args)

    class Model:
        def __enter__(self):
            self.step = 0
            return self

        def __exit__(self, *_):
            pass

        def complete(self, messages, tools, **limits):
            self.step += 1
            if self.step == 1:
                return _call(1, "read_case_plan", {})
            return _call(2, "estimate_occlusion_by_treatment", {"max_size_mm": 500})

    client = TestClient(
        build_app(
            tmp_path / "workspace.sqlite3",
            client_factory=Model,
            occlusion_model=Spy(synthetic_spec()),
        )
    )
    case = _case(client)
    response = client.post(
        f"/api/cases/{case['case_id']}/agent",
        json={
            "artifact_version": case["artifact_version"],
            "question": "Options?",
            "public_data_confirmed": True,
        },
    )
    assert response.status_code == 502
    assert calls == []
    assert TOOL_SCHEMA["properties"]["max_size_mm"]["exclusiveMaximum"] == 60
