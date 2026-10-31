"""Explicit provider settings. Credentials never belong in serialized settings."""

from collections.abc import Mapping
from dataclasses import dataclass, field

import httpx


class ProviderError(RuntimeError):
    """Safe, deliberately payload-free provider failure."""


@dataclass(frozen=True)
class ProviderSettings:
    provider: str
    base_url: str
    model: str
    api_key: str = field(repr=False)

    @classmethod
    def from_mapping(cls, provider: str, env: Mapping[str, str | None]) -> "ProviderSettings":
        definitions = {
            "meta": ("https://api.meta.ai/v1", "muse-spark-1.3", "MODEL_API_KEY"),
            "baseten": (
                "https://inference.baseten.co/v1",
                "meta-models/muse-spark-open-1026",
                "BASETEN_API_KEY",
            ),
        }
        if provider not in definitions:
            raise ProviderError("Unsupported provider")
        base_url, model, key_name = definitions[provider]
        key = env.get(key_name)
        if not key or not key.strip():
            raise ProviderError(f"Missing credential: {key_name}")
        return cls(provider, base_url, model, key)


@dataclass(frozen=True)
class Completion:
    message: dict = field(repr=False)
    finish_reason: str
    usage: dict


class ModelClient:
    """Small synchronous adapter, with no automatic retries or redirects."""

    def __init__(self, settings: ProviderSettings, *, transport=None):
        self.settings = settings
        self._http = httpx.Client(
            timeout=30.0, follow_redirects=False, trust_env=False, transport=transport
        )

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self._http.close()

    def complete(self, messages: list, tools: list, *, max_tokens=2048, timeout_s=30.0):
        if type(max_tokens) is not int or not 1 <= max_tokens <= 4096:
            raise ProviderError("Invalid output-token limit")
        if not 0 < timeout_s <= 30:
            raise ProviderError("Invalid request timeout")
        body = {
            "model": self.settings.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "reasoning_effort": "low",
        }
        if tools:
            body.update(tools=tools, tool_choice="auto")
        try:
            response = self._http.post(
                self.settings.base_url + "/chat/completions",
                headers={"Authorization": "Bearer " + self.settings.api_key},
                json=body,
                timeout=timeout_s,
            )
        except httpx.HTTPError:
            raise ProviderError("Provider transport failure") from None
        if response.status_code != 200:
            raise ProviderError(f"Provider HTTP {response.status_code}") from None
        try:
            payload = response.json()
            choice = payload["choices"][0]
            message = choice["message"]
            finish = choice["finish_reason"]
            if not isinstance(message, dict) or message.get("role") != "assistant":
                raise ValueError
            if message.get("refusal") or finish not in ("stop", "tool_calls"):
                raise ValueError
            calls = message.get("tool_calls")
            if calls:
                if finish != "tool_calls" or not isinstance(calls, list):
                    raise ValueError
            elif (
                finish != "stop"
                or not isinstance(message.get("content"), str)
                or not message["content"].strip()
            ):
                raise ValueError
            usage = payload.get("usage") or {}
            if not isinstance(usage, dict):
                raise TypeError
        except (ValueError, TypeError, KeyError, IndexError):
            raise ProviderError(
                "Provider returned malformed, incomplete or refused output"
            ) from None
        return Completion(message=message, finish_reason=finish, usage=usage)
