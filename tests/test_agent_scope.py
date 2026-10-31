import json

from test_agent import setup_agent

from planner.agent import CaseContext


def test_numeric_looking_artifact_versions_are_serialized_as_json_strings():
    agent, context, seen, _ = setup_agent([{"role": "assistant", "content": "Ready."}])
    context = CaseContext(context.case_id, "2")
    agent.run("Inspect status", context)
    system = seen[0][0]["content"]
    assert json.dumps({"case_id": context.case_id, "artifact_version": "2"}) in system
    assert "JSON strings" in system
