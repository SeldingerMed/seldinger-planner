# Fresh planning workspace implementation plan

**Goal:** Run a newly written local application that opens a real public CTA, supports linked slices/3D and RAS-mm point-to-point measurements, persists case planning state, and lets Muse inspect the actual version-bound state.

**Architecture:** New React/TypeScript/Vite frontend with upstream NiiVue and strong interaction inspiration from the original viewer. Colin subsequently permits selective code copying, especially viewer components; the application structure and planning state remain new, and any reused code needs source attribution. New FastAPI service with local SQLite state and the already-new provider foundation. Volumes stay in the browser; the server receives only explicitly entered public-case provenance and image geometry, measurements, and planning notes. Do not wholesale port the legacy app or copy credentials, clinical/partner data, bulk assets, models, or private configuration as part of code reuse. Public sample data must be obtained independently from its original source, kept ignored, and not committed or sent to a model.

**Tech stack:** React, TypeScript, Vite, NiiVue, Vitest, FastAPI, SQLite, pytest.

## Acceptance and boundaries

- A local server and browser UI actually run; frontend build/typecheck and backend tests pass.
- A real independently sourced public CTA opens in the new viewer with linked views. If no authorized download is obtainable, do not synthesize replacement anatomy or claim a CTA smoke test.
- Two selected world-coordinate points produce a deterministic distance in mm. This is not validated neck, landing-zone, or device-sizing analysis.
- Measurements and notes persist in SQLite; artifact revision changes invalidate old agent requests.
- Agent tools read only server-selected case state. No shell, arbitrary URL, filesystem, or clinical-image tool.
- Current model stays Baseten Muse Spark Open. Agent output is a planning-state summary and missing-information list, not an unsupported treatment recommendation.
- Source stays fresh. Existing trained-model integration remains deferred until a separate original artifact/provenance contract is established.
- No model weights, images, credentials, runtime SQLite files or generated builds in public git.

## Contract: new backend layer (delegated, isolated ownership)

Create only `planner/workspace.py` and `tests/test_workspace.py`. Parent owns dependency files, agent endpoints, frontend, launch scripts, and documentation. Use TDD, run each new behavior RED then GREEN. No legacy repository access, no paid calls, no reading `.env`.

Export `create_app(db_path: pathlib.Path) -> fastapi.FastAPI`. SQLite connection per operation with transaction; schema creation at app construction. Routes:

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/cases` input: `title` 1..100 chars, `image_sha256` exactly 64 lowercase hex, `source_url` optional HTTPS URL (never fetch it), `dimensions` three positive ints <=2048, `spacing_mm` three finite positive floats <=100. Server generates opaque `case_id`; return case object with `case_id,title,image_sha256,source_url,dimensions,spacing_mm,artifact_version` (string revision `1` initially), `notes` empty, `measurements` empty.
- `GET /api/cases/{case_id}` returns case or 404. Case IDs cannot become paths.
- `POST /api/cases/{case_id}/measurements` input: `artifact_version`, `label` 1..80 chars, `point_a_mm`/`point_b_mm` length-three finite numbers; server computes Euclidean `distance_mm`, creates measurement ID. Return updated full case. Increment revision atomically. Stale revision =>409 with no writes. Coincident points =>422. State is RAS physical mm, explicitly returned as `coordinate_system:"RAS"` on measurement.
- `PATCH /api/cases/{case_id}/notes` input: `artifact_version`, `notes` max8000 chars. Atomically update and increment revision, stale=>409.
- `GET /api/cases/{case_id}/brief` returns `text/markdown` built only from actual persisted title, source, hash, revision, measurements and user notes. No fabricated clinical facts. Clearly label the measurement method point-to-point distance, not validated device sizing.

Never return db paths/SQL errors or accept arbitrary file paths. Do not enable wildcard CORS. Tests use temporary SQLite paths and real TestClient with fake metadata, explicitly test persistence after app recreation and stale no-write behavior. No sample patient data.

## Parent sequence

1. Update AGENTS and ignore rules with fresh-build boundary; create feature branch.
2. Install declared upstream dependencies, no code generator importing old source.
3. New UI tracer test: header and file-open empty state, then fresh React implementation.
4. New viewer adapter using upstream NiiVue API, linked multiplanar + volume rendering and physical crosshair coordinates; no homegrown fake anatomy.
5. Measurement/notes UI and HTTP integration, tested using API-shaped synthetic fixtures (not demo images).
6. Attach bounded server-selected Muse tools to workspace with explicit user trigger; test scope/version refusal and live public metadata-only interaction.
7. Independent source acquisition and real browser smoke, inspect screenshot and network/runtime errors.
8. Run Python tests, frontend tests/typecheck/build, secret and legacy-reference scans. Review exact diff. Commit/push feature branch, open PR. Merge only with required CI and exact-head approved review; otherwise report PR honestly.
