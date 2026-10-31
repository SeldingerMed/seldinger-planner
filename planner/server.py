"""Local-only workspace composition. Images are never included in model requests."""

import json
from contextlib import closing
from copy import deepcopy
from pathlib import Path
from typing import Literal

from dotenv import dotenv_values
from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from planner.agent import AgentError, BoundedAgent, CaseContext, ToolSpec
from planner.providers import ModelClient, ProviderError, ProviderSettings
from planner.workspace import _connect, _get_case, create_app


class AgentRequest(BaseModel):
    artifact_version: str = Field(min_length=1, max_length=20)
    question: str = Field(min_length=1, max_length=4000)
    public_data_confirmed: Literal[True]


def build_app(db_path: Path, *, client_factory=None, sample_dir: Path | None = None):
    app = create_app(db_path)
    sample_dir = (
        sample_dir or Path(__file__).resolve().parents[1] / ".runtime" / "approved-public-sample"
    )

    @app.middleware("http")
    async def local_origin_only(request: Request, call_next):
        origin = request.headers.get("origin")
        allowed = {"http://127.0.0.1:5173", "http://localhost:5173", "http://127.0.0.1:8765"}
        if origin and origin not in allowed:
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
        return case

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
        schema = {
            "type": "object",
            "properties": {},
            "required": [],
            "additionalProperties": False,
        }
        tool = ToolSpec(
            "read_case_plan",
            "Read the actual persisted case plan, public-source provenance, user notes and point-to-point measurements. "
            "Call with an empty JSON object. Scope is fixed by the server; do not supply case identifiers. "
            "Call this before answering. The measurements are not validated vessel diameters or device sizes.",
            schema,
            lambda context, args: deepcopy(snapshot),
        )
        question = (
            "Read the case plan tool before answering. Distinguish user-provided notes from measured facts. "
            "Do not invent aneurysm location, dimensions, diagnosis, device compatibility or literature sources. "
            "Point-to-point distances are NOT neck, sac or orthogonal vessel measurements. "
            "Describe available evidence and missing information; do not recommend a treatment. "
            "User question: " + payload.question
        )
        try:
            with (client_factory or default_client)() as model:
                result = BoundedAgent(model, [tool], max_model_calls=4, max_tool_calls=4).run(
                    question, CaseContext(case_id, payload.artifact_version)
                )
        except (AgentError, ProviderError):
            raise HTTPException(
                502, "Model request failed; no planning state was changed"
            ) from None
        if read_case(case_id)["artifact_version"] != payload.artifact_version:
            raise HTTPException(409, "Case changed during model request; result discarded")
        if "read_case_plan" not in result.tool_names:
            raise HTTPException(502, "Model did not inspect the case plan")
        return {
            "answer": result.answer,
            "tool_names": result.tool_names,
            "artifact_version": payload.artifact_version,
            "model_calls": result.model_calls,
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
        build_app(database, sample_dir=root / "approved-public-sample"), host="127.0.0.1", port=8765
    )


if __name__ == "__main__":
    main()
