import httpx
import pytest


def test_provider_settings_use_exact_fixed_endpoints_and_hide_secrets():
    from planner.providers import ProviderSettings

    meta = ProviderSettings.from_mapping("meta", {"MODEL_API_KEY": "unit-meta-secret"})
    baseten = ProviderSettings.from_mapping("baseten", {"BASETEN_API_KEY": "unit-base-secret"})
    assert meta.base_url == "https://api.meta.ai/v1"
    assert meta.model == "muse-spark-1.3"
    assert baseten.base_url == "https://inference.baseten.co/v1"
    assert baseten.model == "meta-models/muse-spark-open-1026"
    assert "unit-meta-secret" not in repr(meta)
    assert "unit-base-secret" not in repr(baseten)


def test_missing_credential_is_named_without_value():
    from planner.providers import ProviderError, ProviderSettings

    with pytest.raises(ProviderError, match="MODEL_API_KEY"):
        ProviderSettings.from_mapping("meta", {})


def test_unknown_provider_is_rejected():
    from planner.providers import ProviderError, ProviderSettings

    with pytest.raises(ProviderError, match="Unsupported provider"):
        ProviderSettings.from_mapping("untrusted", {"MODEL_API_KEY": "unit-secret"})


def make_client(handler, provider="baseten"):
    from planner.providers import ModelClient, ProviderSettings

    settings = ProviderSettings.from_mapping(
        provider, {"MODEL_API_KEY": "unit-meta-secret", "BASETEN_API_KEY": "unit-base-secret"}
    )
    return ModelClient(settings, transport=httpx.MockTransport(handler))


def test_completion_sends_provider_specific_body_without_structured_output():
    import json

    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"role": "assistant", "content": "ready"}, "finish_reason": "stop"}
                ],
                "usage": {"total_tokens": 7},
            },
        )

    with make_client(handler) as client:
        result = client.complete([{"role": "user", "content": "hello"}], [], max_tokens=128)
    body = json.loads(requests[0].content)
    assert requests[0].url == "https://inference.baseten.co/v1/chat/completions"
    assert body["model"] == "meta-models/muse-spark-open-1026"
    assert body["reasoning_effort"] == "low"
    assert body["max_tokens"] == 128
    assert "response_format" not in body
    assert "unit-base-secret" not in str(body)
    assert result.message["content"] == "ready"
    assert result.usage == {"total_tokens": 7}


@pytest.mark.parametrize(
    "message,finish",
    [
        ({"role": "assistant", "content": "partial"}, "length"),
        ({"role": "assistant", "content": None, "refusal": "refused"}, "stop"),
        ({"role": "assistant", "content": None}, "stop"),
    ],
)
def test_incomplete_refused_or_empty_responses_fail(message, finish):
    from planner.providers import ProviderError

    with (
        make_client(
            lambda _: httpx.Response(
                200, json={"choices": [{"message": message, "finish_reason": finish}]}
            )
        ) as client,
        pytest.raises(ProviderError),
    ):
        client.complete([], [])


@pytest.mark.parametrize("status", [307, 401, 402, 429, 500])
def test_http_errors_never_echo_response_or_credentials_or_retry(status):
    from planner.providers import ProviderError

    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            status, text="unit-base-secret", headers={"Location": "https://evil.test"}
        )

    with make_client(handler) as client, pytest.raises(ProviderError) as error:
        client.complete([], [])
    assert len(calls) == 1
    assert "unit-base-secret" not in str(error.value)


def test_malformed_provider_json_is_a_safe_failure():
    from planner.providers import ProviderError

    with (
        make_client(lambda _: httpx.Response(200, text="not-json unit-base-secret")) as client,
        pytest.raises(ProviderError) as error,
    ):
        client.complete([], [])
    assert "unit-base-secret" not in str(error.value)
