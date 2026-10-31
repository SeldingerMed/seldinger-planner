# Seldinger Planner

New CTA-first aneurysm planning application, built separately from `seldinger-app` and `seldinger-ml`.

## Current exercised slice

- Fixed-endpoint Meta and Baseten clients.
- Baseten model: `meta-models/muse-spark-open-1026` (the unversioned catalog alias returned HTTP 403 on the supplied account; this dated model succeeded).
- Direct Meta model: `muse-spark-1.3`, Standard mode.
- Bounded, schema-validated tool loop with server-selected case/version checks.
- Nonclinical live conformance test that reads source-file existence and returns a fresh nonce through an actual tool call.

This is infrastructure, not yet a viewer or clinical planning workflow. No segmentation inference or aneurysm detection is claimed by this slice.

## Run

```sh
uv sync --group dev
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv run python -m planner.probe --provider both
```

The last command incurs a small number of real API calls. It uses no imaging and writes sanitized results to ignored `artifacts/provider-smoke.json`. The supplied credentials live in ignored `.env` with mode 0600. Never put provider keys in frontend environment variables.

The runner caps model/tool counts and checks elapsed time between operations; HTTP connect/read/write/pool operations have finite timeouts. This is not process-level preemption of a blocking tool. Add job-level isolation/timeouts before exposing expensive segmentation handlers. No automatic retries or provider fallbacks are enabled.

## Next product slices

1. Typed case/artifact manifests and read-only adapter to the existing public CTA library.
2. New linked 2D/3D viewer.
3. Seldinger segmentation adapter preserving checkpoint/preprocessing/coordinate semantics.
4. Aneurysm-localized SAM proposal/acceptance loop and measurement invalidation.
5. Source-grounded sizing and treatment-option worksheet with image-linked Muse tool calls.

Keep automatic aneurysm detection distinct from curated lesion annotations and clinician selection.
