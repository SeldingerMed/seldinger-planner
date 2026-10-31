import json
from copy import deepcopy

import pytest


def call(name="read_status", arguments=None, call_id="one"):
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": json.dumps(
                arguments
                if arguments is not None
                else {"case_id": "scope-a", "artifact_version": "v1"}
            ),
        },
    }


def setup_agent(turns, **limits):
    from planner.agent import BoundedAgent, CaseContext, ToolSpec
    from planner.providers import Completion

    seen, executed = [], []

    class Client:
        def complete(self, messages, tools, **kwargs):
            seen.append(deepcopy(messages))
            message = turns[min(len(seen) - 1, len(turns) - 1)]
            return Completion(message, "tool_calls" if message.get("tool_calls") else "stop", {})

    schema = {
        "type": "object",
        "properties": {"case_id": {"type": "string"}, "artifact_version": {"type": "string"}},
        "required": ["case_id", "artifact_version"],
        "additionalProperties": False,
    }

    def handler(context, args):
        executed.append(context.case_id)
        return {"case_id": context.case_id, "status": "actual-tool-result"}

    agent = BoundedAgent(
        Client(), [ToolSpec("read_status", "Read status", schema, handler)], **limits
    )
    return agent, CaseContext("scope-a", "v1"), seen, executed


def test_round_trip_preserves_opaque_assistant_fields_and_returns_tool_evidence():
    turn = {
        "role": "assistant",
        "content": None,
        "reasoning_content": "opaque",
        "tool_calls": [call()],
    }
    agent, context, seen, executed = setup_agent([turn, {"role": "assistant", "content": "Ready."}])
    result = agent.run("Read status", context)
    assert result.answer == "Ready."
    assert result.tool_names == ["read_status"]
    assert result.model_calls == 2
    assert executed == ["scope-a"]
    assert seen[1][-2] == turn
    assert json.loads(seen[1][-1]["content"])["status"] == "actual-tool-result"


@pytest.mark.parametrize(
    "bad",
    [
        call(name="run_shell"),
        call(arguments={"case_id": "scope-b", "artifact_version": "v1"}),
        call(arguments={"case_id": "scope-a", "artifact_version": "v2"}),
        call(arguments={"case_id": "scope-a", "artifact_version": "v1", "path": "/private"}),
        call(arguments=[]),
        {"id": "one", "type": "function", "function": {"name": "read_status", "arguments": "{"}},
    ],
)
def test_invalid_call_batch_is_rejected_before_any_tool_executes(bad):
    from planner.agent import AgentError

    agent, context, seen, executed = setup_agent(
        [{"role": "assistant", "tool_calls": [call(call_id="good"), bad]}]
    )
    with pytest.raises(AgentError):
        agent.run("status", context)
    assert executed == []
    assert len(seen) == 1


def test_duplicate_call_ids_are_rejected():
    from planner.agent import AgentError

    agent, context, _, executed = setup_agent(
        [{"role": "assistant", "tool_calls": [call(), call()]}]
    )
    with pytest.raises(AgentError):
        agent.run("status", context)
    assert executed == []


def test_model_budget_is_enforced():
    from planner.agent import AgentError

    agent, context, seen, _ = setup_agent(
        [{"role": "assistant", "tool_calls": [call()]}], max_model_calls=2
    )
    with pytest.raises(AgentError, match="budget"):
        agent.run("status", context)
    assert len(seen) == 2


def test_tool_budget_rejects_whole_batch():
    from planner.agent import AgentError

    agent, context, _, executed = setup_agent(
        [{"role": "assistant", "tool_calls": [call(call_id="one"), call(call_id="two")]}],
        max_tool_calls=1,
    )
    with pytest.raises(AgentError, match="budget"):
        agent.run("status", context)
    assert executed == []


def test_handler_failure_is_payload_free():
    from planner.agent import AgentError, BoundedAgent, ToolSpec

    agent, context, _, _ = setup_agent([{"role": "assistant", "tool_calls": [call()]}])

    def broken(context, args):
        raise RuntimeError("a-secret-from-a-handler")

    tool = agent.tools["read_status"]
    agent = BoundedAgent(agent.client, [ToolSpec(tool.name, tool.description, tool.schema, broken)])
    with pytest.raises(AgentError) as error:
        agent.run("status", context)
    assert "a-secret-from-a-handler" not in str(error.value)
