"""Bounded, case/version-bound tool loop. No shell or arbitrary file tools."""

import json
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, field

from jsonschema import Draft202012Validator


class AgentError(RuntimeError):
    """Payload-free validation or budget failure."""


@dataclass(frozen=True)
class CaseContext:
    case_id: str
    artifact_version: str


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    schema: dict
    handler: Callable = field(repr=False)

    def declaration(self):
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.schema,
            },
        }


@dataclass(frozen=True)
class AgentResult:
    answer: str
    tool_names: list[str]
    model_calls: int
    usage: list[dict]


class BoundedAgent:
    def __init__(self, client, tools, *, max_model_calls=4, max_tool_calls=8, timeout_s=60):
        if any(type(n) is not int or n <= 0 for n in (max_model_calls, max_tool_calls)):
            raise AgentError("Invalid call budget")
        if not 0 < timeout_s <= 120:
            raise AgentError("Invalid time budget")
        self.client = client
        self.tools = {t.name: t for t in tools}
        if len(self.tools) != len(tools):
            raise AgentError("Duplicate tool names")
        for tool in tools:
            Draft202012Validator.check_schema(tool.schema)
        self.max_model_calls = max_model_calls
        self.max_tool_calls = max_tool_calls
        self.timeout_s = timeout_s

    def _validate_batch(self, calls, context, remaining):
        if not isinstance(calls, list) or not calls or len(calls) > remaining:
            raise AgentError("Tool-call budget exhausted or invalid batch")
        prepared, ids = [], set()
        try:
            for call in calls:
                call_id = call["id"]
                if not isinstance(call_id, str) or not 1 <= len(call_id) <= 64 or call_id in ids:
                    raise ValueError
                ids.add(call_id)
                if call.get("type") != "function":
                    raise ValueError
                function = call["function"]
                tool = self.tools[function["name"]]
                raw = function["arguments"]
                if not isinstance(raw, str):
                    raise TypeError
                args = json.loads(raw)
                if not isinstance(args, dict) or not Draft202012Validator(tool.schema).is_valid(
                    args
                ):
                    raise ValueError
                if args.get("case_id", context.case_id) != context.case_id:
                    raise ValueError
                if (
                    args.get("artifact_version", context.artifact_version)
                    != context.artifact_version
                ):
                    raise ValueError
                prepared.append((call_id, tool, args))
        except (KeyError, TypeError, ValueError):
            raise AgentError(
                "Rejected tool batch: invalid arguments, tool, or case/version"
            ) from None
        return prepared

    def run(self, question: str, context: CaseContext):
        deadline = time.monotonic() + self.timeout_s
        messages = [
            {
                "role": "system",
                "content": (
                    "Use only the declared tools. Do not invent tool results or clinical facts. "
                    "Read relevant tools before claiming system capabilities. "
                    "Current server-selected case scope: "
                    + context.case_id
                    + "; artifact_version: "
                    + context.artifact_version
                ),
            },
            {"role": "user", "content": question},
        ]
        used, usage = [], []
        for round_index in range(self.max_model_calls):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AgentError("Time budget exhausted")
            completion = self.client.complete(
                messages,
                [t.declaration() for t in self.tools.values()],
                max_tokens=2048,
                timeout_s=min(30.0, remaining),
            )
            if time.monotonic() >= deadline:
                raise AgentError("Time budget exhausted")
            message = completion.message
            usage.append(completion.usage)
            if not message.get("tool_calls"):
                return AgentResult(message["content"], used, round_index + 1, usage)
            prepared = self._validate_batch(
                message["tool_calls"], context, self.max_tool_calls - len(used)
            )
            # Replay all opaque provider fields, including reasoning, without logging them.
            messages.append(deepcopy(message))
            for call_id, tool, args in prepared:
                if time.monotonic() >= deadline:
                    raise AgentError("Time budget exhausted")
                try:
                    result = tool.handler(context, args)
                    content = json.dumps(result, allow_nan=False)
                except Exception:  # noqa: BLE001 - do not expose arbitrary tool payloads
                    raise AgentError("Tool execution failed") from None
                used.append(tool.name)
                messages.append({"role": "tool", "tool_call_id": call_id, "content": content})
        raise AgentError("Model-call budget exhausted")
