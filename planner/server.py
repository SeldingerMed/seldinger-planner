"""Local-only workspace composition. Images are never included in model requests."""

import ipaddress
import json
import os
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from dotenv import dotenv_values
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from planner.agent import AgentError, BoundedAgent, CaseContext, ToolSpec
from planner.planning_sources import PLANNING_SOURCE_BUNDLE
from planner.providers import ModelClient, ProviderError, ProviderSettings
from planner.reference_server import ReferenceStore, register_reference_routes
from planner.source_registry import (
    ImageSourceRegistry,
    register_image_source_routes,
)
from planner.workspace import _connect, _get_case, create_app


class AgentRequest(BaseModel):
    artifact_version: str = Field(min_length=1, max_length=20)
    question: str = Field(min_length=1, max_length=4000)
    public_data_confirmed: Literal[True]


def _configured_browser_origins():
    origins = set()
    value = os.environ.get("SELDINGER_BROWSER_ORIGINS", "")
    if len(value) > 2048:
        raise ValueError("Invalid tailnet origin configuration")
    for origin in filter(None, (part.strip() for part in value.split(","))):
        try:
            parsed = urlsplit(origin)
            valid = (
                parsed.scheme in ("http", "https")
                and origin.startswith(parsed.scheme + "://")
                and ipaddress.IPv4Address(parsed.hostname) in ipaddress.IPv4Network("100.64.0.0/10")
                and parsed.port is not None
                and parsed.port > 0
                and not parsed.username
                and not parsed.password
                and not parsed.path
                and not parsed.query
                and not parsed.fragment
            )
        except (TypeError, ValueError):
            valid = False
        if not valid:
            raise ValueError("Invalid tailnet origin configuration")
        origins.add(origin)
    return origins


def build_app(
    db_path: Path,
    *,
    client_factory=None,
    sample_dir: Path | None = None,
    reference_dir: Path | None = None,
    inference_runner=None,
    inference_results_dir: Path | None = None,
    calibrated_source_store=None,
    planning_source_store=None,
    geometry_runner=None,
    anatomy_runner=None,
):
    app = create_app(db_path, planning_context_provider=lambda case: planning_for_brief(case))
    allowed_origins = {
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8765",
    } | _configured_browser_origins()
    references = ReferenceStore(
        reference_dir or Path(__file__).resolve().parents[1] / ".runtime" / "public-reference"
    )
    image_sources = ImageSourceRegistry(references, calibrated_source_store, planning_source_store)
    sample_dir = (
        sample_dir or Path(__file__).resolve().parents[1] / ".runtime" / "approved-public-sample"
    )

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin not in allowed_origins:
            return JSONResponse({"detail": "Origin not allowed"}, status_code=403)
        return await call_next(request)

    @app.get("/api/sample")
    def sample_metadata():
        path = sample_dir / "public-cta.json"
        if not path.is_file() or not (sample_dir / "public-cta.nii.gz").is_file():
            raise HTTPException(404, "Public sample not installed")
        data = json.loads(path.read_text())
        return {
            "source_url": data["source_url"],
            "filename": "public-cta.nii.gz",
            "license_url": data.get("license_url"),
            "citation": data.get("citation"),
        }

    @app.get("/api/sample-volume")
    def sample_volume():
        path = sample_dir / "public-cta.nii.gz"
        if not path.is_file():
            raise HTTPException(404, "Public sample not installed")
        return FileResponse(
            path, media_type="application/octet-stream", filename="public-cta.nii.gz"
        )

    def read_case(case_id):
        with closing(_connect(db_path)) as conn:
            case = _get_case(conn, case_id)
        if case is None:
            raise HTTPException(404, "Case not found")
        case["reference_annotation"] = references.optional_for_case(case)
        if image_sources.find_installed_source_by_hash(case["image_sha256"]) is not None:
            case["image_source"] = image_sources.calibrated_metadata_for_case(case)
        return case

    register_reference_routes(app, references, read_case)
    register_image_source_routes(app, image_sources, read_case)

    def default_client():
        env = dotenv_values(Path(__file__).resolve().parents[1] / ".env")
        return ModelClient(ProviderSettings.from_mapping("baseten", env))

    @app.post("/api/cases/{case_id}/agent")
    def ask_agent(case_id: str, payload: AgentRequest):
        snapshot = read_case(case_id)
        if snapshot["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        snapshot["measurement_count"] = len(snapshot["measurements"])
        snapshot["measurements"] = snapshot["measurements"][:100]
        snapshot["measurements_returned"] = len(snapshot["measurements"])
        snapshot["measurements_truncated"] = (
            snapshot["measurements_returned"] < snapshot["measurement_count"]
        )
        snapshot["computed_context"] = read_planning_context(case_id)
        if snapshot["computed_context"]["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case revision changed")
        schema = {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }
        tool = ToolSpec(
            "read_case_plan",
            "Read the persisted case plan, operator-entered worksheet, notes and manual evidence, "
            "plus bounded computed_context with current accepted-mask metadata, scalar morphometry, "
            "derived indices and operator-reported sizing arithmetic when present. These are software "
            "estimates, not validated anatomy, clinical findings, or treatment suitability. "
            "Call with an empty JSON object. Scope is fixed by the server; do not supply case identifiers. "
            "Call this before answering. At most 100 measurements are returned; measurement_count is the total, "
            "measurements_returned is the visible count, and measurements_truncated marks omitted rows. "
            "The measurements are not validated vessel diameters or device sizes.",
            schema,
            lambda context, args: deepcopy(snapshot),
        )
        sources_tool = ToolSpec(
            "read_planning_sources",
            "Read a fixed, small primary-guideline bundle with population, section, source URLs and coverage limits. "
            "It is not a live literature search, device IFU, or clinical recommendation. Call with an empty JSON object.",
            schema,
            lambda context, args: deepcopy(PLANNING_SOURCE_BUNDLE),
        )
        sources_required = bool((snapshot.get("aneurysm_plan") or {}).get("options"))
        question = (
            "Read the case plan tool before answering. Distinguish user-provided notes from measured facts. "
            "Do not invent aneurysm location, dimensions, diagnosis, device compatibility or literature sources. "
            "Point-to-point distances are NOT neck, sac or orthogonal vessel measurements. "
            "The aneurysm worksheet is operator-entered, not inferred anatomy or diagnosis. "
            "Read read_planning_sources before discussing selected options; cite only supplied sources for clinical comparisons. "
            "Respect each source's population and coverage limits; if rupture status is unknown, do not assume an unruptured or ruptured pathway. "
            "Compare the selected options' evidence needs and unresolved questions, not individual suitability. "
            "Do not rank or recommend a treatment, estimate individual risk, or invent device sizes, IFU claims or references. "
            "User question: " + payload.question
        )
        try:
            with (client_factory or default_client)() as model:
                result = BoundedAgent(
                    model, [tool, sources_tool], max_model_calls=4, max_tool_calls=4
                ).run(question, CaseContext(case_id, payload.artifact_version))
        except (AgentError, ProviderError):
            raise HTTPException(
                502, "Model request failed; no planning state was changed"
            ) from None
        latest = read_case(case_id)
        latest_context = read_planning_context(case_id)

        def reference_revision(case):
            return (case.get("image_source") or case.get("reference_annotation") or {}).get(
                "reference_revision"
            )

        if (
            latest["artifact_version"] != payload.artifact_version
            or reference_revision(latest) != reference_revision(snapshot)
            or latest_context != snapshot["computed_context"]
        ):
            raise HTTPException(
                409, "Case or reference changed during model request; result discarded"
            )
        if "read_case_plan" not in result.tool_names:
            raise HTTPException(502, "Model did not inspect the case plan")
        if sources_required and "read_planning_sources" not in result.tool_names:
            raise HTTPException(502, "Model did not inspect the planning sources")
        return {
            "answer": result.answer,
            "tool_names": result.tool_names,
            "artifact_version": payload.artifact_version,
            "model_calls": result.model_calls,
            "sources": [
                {key: source[key] for key in ("id", "title", "url", "population", "section")}
                for source in PLANNING_SOURCE_BUNDLE["sources"]
            ]
            if "read_planning_sources" in result.tool_names
            else [],
        }

    from planner.device_inputs_server import register_device_input_routes
    from planner.device_inputs_state import DeviceInputsLedger
    from planner.device_results_read import register_device_result_read_routes
    from planner.device_results_server import register_device_calculation_routes
    from planner.device_results_state import DeviceResultsLedger
    from planner.device_server import register_device_routes
    from planner.geometry_server import register_geometry_routes
    from planner.geometry_state import GeometryLedger
    from planner.segmentation_server import register_segmentation_routes
    from planner.segmentation_state import SegmentationLedger

    results_dir = (
        inference_results_dir
        or Path(__file__).resolve().parents[1] / ".runtime" / "inference-results"
    )

    segmentations = SegmentationLedger(db_path)
    register_segmentation_routes(
        app,
        segmentations,
        image_sources,
        read_case,
        results_dir,
        runner=inference_runner,
    )

    read_geometry = register_geometry_routes(
        app,
        GeometryLedger(db_path),
        image_sources,
        read_case,
        results_dir,
        runner=geometry_runner,
    )
    from planner.anatomy_server import register_anatomy_routes

    register_anatomy_routes(
        app, db_path, image_sources, read_case, results_dir, runner=anatomy_runner
    )
    register_device_routes(app, read_geometry)
    from planner.device_scenario_server import register_device_scenario_routes
    from planner.device_scenarios import DeviceScenarioLedger

    read_scenarios = register_device_scenario_routes(
        app, DeviceScenarioLedger(db_path), read_geometry
    )
    device_inputs = DeviceInputsLedger(db_path)
    device_results = DeviceResultsLedger(db_path)
    register_device_input_routes(app, device_inputs, read_geometry)
    read_sizing = register_device_result_read_routes(
        app, device_inputs, device_results, read_geometry
    )
    register_device_calculation_routes(app, device_results, read_sizing)
    from planner.physics_server import register_physics_routes

    read_numerical = register_physics_routes(app, db_path, image_sources, read_case, results_dir)
    from planner.territory_workflow_server import register_territory_workflow_routes

    read_territory = register_territory_workflow_routes(app, db_path, image_sources, read_case)
    from planner.reformat_server import register_reformat_routes

    read_scene = register_reformat_routes(app, db_path, image_sources, read_case)

    from planner.device_db import (
        CATEGORIES,
        TERRITORIES,
        connect,
        query_devices,
        seed_default_catalog,
    )

    # Observe/synchronize the local listing once per application construction,
    # never as a side effect of a read-only catalog request.
    with closing(connect(db_path)) as conn:
        seed_default_catalog(conn)

    from planner.planning_context import freeze, project_context, source_revision
    from planner.territories import list_territory_plugins

    def read_components(case):
        geometry = sizing = None
        if source_revision(case) is not None and case["spatial_units"] == "mm":
            geometry = freeze(read_geometry(case["case_id"]))
            sizing = freeze(read_sizing(case["case_id"]))
        accepted = {
            role: freeze(segmentations.current(case["case_id"], role=role))
            for role in ("vessel", "aneurysm")
        }
        return geometry, sizing, accepted

    def read_planning_context(case_id):
        # Independently freeze every provider before projection, then reread all
        # dependencies. Result IDs change even when the case version does not.
        try:
            case = freeze(read_case(case_id))
            components = read_components(case)
            context = project_context(case, *components)
            latest = freeze(read_case(case_id))
            latest_components = read_components(latest)
            if latest != case or latest_components != components:
                raise HTTPException(409, "Planning context changed; reload saved state")
            return context
        except (ValueError, TypeError, KeyError, OSError) as exc:
            raise HTTPException(503, "Computed planning context is unavailable") from exc

    from planner.local_brief import register_local_brief

    register_local_brief(
        app,
        read_case,
        read_planning_context,
        read_territory,
        read_scene,
        read_scenarios,
        read_numerical,
    )

    def planning_for_brief(case):
        context = read_planning_context(case["case_id"])
        if any(
            context[key] != case[key] for key in ("case_id", "image_sha256", "artifact_version")
        ):
            raise HTTPException(409, "Case changed while preparing brief")
        return context

    @app.get("/api/cases/{case_id}/planning-context")
    def get_planning_context(case_id: str):
        return JSONResponse(read_planning_context(case_id), headers={"Cache-Control": "no-store"})

    @app.get("/api/devices")
    def list_unified_devices(category: str | None = None, territory: str | None = None):
        if (
            category is not None
            and category not in CATEGORIES
            or territory is not None
            and territory not in TERRITORIES
        ):
            raise HTTPException(422, "Unknown catalog category or territory")
        with closing(connect(db_path)) as conn:
            devices = query_devices(conn, category=category, territory=territory)
        return {
            "clinical_suitability_established": False,
            "devices": devices,
            "scope": "shared_catalog_listing_not_verified_current_ifu",
        }

    @app.get("/api/territories")
    def list_territories():
        return {
            "clinical_suitability_established": False,
            "execution_scope": "declarative_plugins_and_supplied_measurement_calculators",
            "territories": list_territory_plugins(),
        }

    @app.get("/api/cases/{case_id}/territory-analysis")
    def case_territory_analysis(case_id: str, territory: str = "neurovascular"):
        if territory not in TERRITORIES:
            raise HTTPException(422, "Unknown territory")
        context = read_planning_context(case_id)
        if territory == "neurovascular":
            return context["territory_summary"]
        return {
            "case_id": case_id,
            "territory": territory,
            "findings": [],
            "clinical_suitability_established": False,
            "status": "territory_measurements_not_available",
        }

    return app


def main(*, runtime_dir: Path | None = None):
    import uvicorn

    root = runtime_dir or Path(__file__).resolve().parents[1] / ".runtime"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    database = root / "workspace.sqlite3"
    database.touch(mode=0o600, exist_ok=True)
    database.chmod(0o600)
    uvicorn.run(
        build_app(
            database,
            sample_dir=root / "approved-public-sample",
            reference_dir=root / "public-reference",
        ),
        host="127.0.0.1",
        port=8765,
    )


if __name__ == "__main__":
    main()
