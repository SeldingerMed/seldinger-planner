# Seldinger Planner

A new CTA-first neurovascular planning research prototype. This repository contains the new application, not a wholesale port of the earlier Seldinger app.

## Implemented

- React/TypeScript workspace with upstream NiiVue: linked slices and 3D volume view, display presets, crosshair location, and measurement evidence links.
- Browser-local NIfTI loading. Image bytes are not uploaded to the workspace server or included in Muse requests.
- FastAPI and local SQLite case state, notes, point-to-point distances, optimistic revision checks, and Markdown brief export.
- Case reopening by image fingerprint preserves saved notes and measurements in the same browser/server workspace.
- Baseten Muse Spark Open reads a server-bound snapshot through a bounded tool loop. The model cannot select a different case, write planning state, execute shell commands, or fetch arbitrary files or URLs.
- Direct Meta model adapter for separate infrastructure tests.

This is not yet the proposed end-to-end aneurysm planner. Segmentation inference, sac/neck measurements, orthogonal landing-zone diameters, sourced device sizing, treatment comparison and SAM correction are not implemented.

## Run locally

```sh
uv sync --group dev
uv run python -m planner.server
```

In a second terminal:

```sh
cd web
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The API binds only to `127.0.0.1:8765`; Vite proxies `/api`. This prototype is not configured for public deployment or multiuser access.

Open an authorized `.nii` or `.nii.gz` volume smaller than 200 MB. NIfTI headers must declare millimeter units before the UI and API allow millimeter measurement creation. Unspecified or unsupported units remain flagged rather than silently relabeled. A point-to-point distance is not a validated vessel diameter or device size.

The optional **Open public CTA** action reads an already installed local sample from ignored `.runtime/approved-public-sample/`, requiring `public-cta.nii.gz` and `public-cta.json` with source and license provenance. No volume is distributed in this repository. The locally exercised source is an existing CMHA CTA crop, credited to Song et al. (2024), [dataset DOI](https://doi.org/10.6084/m9.figshare.26965450.v1), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its source NIfTI has unspecified spatial units, so millimeter measurements are disabled for that sample pending independent unit corroboration. No new segmentation inference is claimed.

## Credentials and data

Copy `.env.example` to an ignored `.env` and set `MODEL_API_KEY` and `BASETEN_API_KEY`. Restrict that file to mode `0600`. Never put provider keys in frontend environment variables.

Baseten uses `meta-models/muse-spark-open-1026`. Meta infrastructure tests use `muse-spark-1.3`. Live model calls require explicit user action and incur API usage. Do not submit private, patient, partner or unapproved case information. The UI requires public/synthetic-data confirmation, reset on every volume change, before sending case metadata and notes to Muse.

Runtime state, local images, weights, build outputs, and credentials stay out of git. The application does not confer rights to redistribute datasets or model artifacts.

## Verify

```sh
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
cd web
npm test
npm run build
npm audit --omit=dev
```

Paid, nonclinical provider conformance probe, run separately from offline tests:

```sh
uv run python -m planner.probe --provider both
```

The probe sends no imaging and saves sanitized local results in ignored `artifacts/`. Model/tool call counts and output tokens are capped; elapsed time is checked at operation boundaries. Blocking tools do not yet have process-level preemption. No automatic retries or fallback providers are enabled.

## Evidence boundary

Backend persistence, stale-write rejection, brief export and the live Muse read-tool round trip have been exercised with explicitly synthetic metadata. The real public CMHA crop has also been exercised in an attached browser: all five layouts, crosshair and display-preset changes, 3D camera motion, saved-note persistence after reopening, brief export, and a live Muse call reading the saved public-case metadata and notes.

The measurement UI separately saved a physical-RAS point-to-point distance from an explicitly synthetic, millimeter-declared NIfTI geometry fixture. The real CMHA crop still has unknown spatial units and its millimeter measurement controls remain disabled. These are functional/rendering checks, not segmentation, morphometry, device-sizing or clinical validation. See [browser verification](docs/verification/browser-smoke.md) for the precise evidence boundary.
