"""Real, nonclinical provider/tool round trips. Never sends imaging or credentials as context."""

import argparse
import json
import secrets
import time
from pathlib import Path

from dotenv import dotenv_values

from planner.agent import AgentError, BoundedAgent, CaseContext, ToolSpec
from planner.providers import ModelClient, ProviderError, ProviderSettings


def read_build_status(root: Path, nonce: str) -> dict:
    return {
        "application": "seldinger-planner",
        "agent_source_present": (root / "planner" / "agent.py").is_file(),
        "provider_source_present": (root / "planner" / "providers.py").is_file(),
        "clinical_data_used": False,
        "verification_nonce": nonce,
    }


def run_probe(provider: str, root: Path) -> dict:
    settings = ProviderSettings.from_mapping(provider, dotenv_values(root / ".env"))
    nonce = secrets.token_hex(8)
    schema = {
        "type": "object",
        "properties": {
            "case_id": {"type": "string"},
            "artifact_version": {"type": "string"},
        },
        "required": ["case_id", "artifact_version"],
        "additionalProperties": False,
    }
    tool = ToolSpec(
        "inspect_build",
        "Read the real build status and a verification nonce. Call before answering status questions.",
        schema,
        lambda context, args: read_build_status(root, nonce),
    )
    started = time.monotonic()
    with ModelClient(settings) as client:
        result = BoundedAgent(client, [tool], max_model_calls=3).run(
            "Inspect this build using inspect_build. Report whether agent and provider source "
            "files exist, and reproduce the returned verification_nonce exactly. "
            "This is an infrastructure test, not a clinical case.",
            CaseContext("infrastructure-probe", "build-0"),
        )
    verified = result.tool_names == ["inspect_build"] and nonce in result.answer
    return {
        "provider": provider,
        "model": settings.model,
        "verified_tool_round_trip": verified,
        "model_calls": result.model_calls,
        "tools": result.tool_names,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "usage": result.usage,
        "answer": result.answer,
        "clinical_data_used": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--provider", choices=["meta", "baseten", "both"], default="both")
    options = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    providers = ["baseten", "meta"] if options.provider == "both" else [options.provider]
    reports = []
    for provider in providers:
        try:
            report = run_probe(provider, root)
        except (AgentError, ProviderError) as exc:
            report = {"provider": provider, "verified_tool_round_trip": False, "error": str(exc)}
        reports.append(report)
        print(json.dumps(report, indent=2))
    out = root / "artifacts" / "provider-smoke.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(reports, indent=2) + "\n")
    return 0 if all(r["verified_tool_round_trip"] for r in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
