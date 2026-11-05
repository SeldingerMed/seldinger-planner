# Seldinger Planner

A new CTA-first neurovascular imaging and evidence-workspace research prototype, built for the Meta Global AI Developer Hackathon. This repository contains the new application, not a wholesale port of the earlier Seldinger app. It is not a clinical service or a treatment-recommendation system.

## Hackathon source and original work

**Full application: [`feat/fresh-planning-workspace`](https://github.com/SeldingerMed/seldinger-planner/tree/feat/fresh-planning-workspace).** The older `main` branch contains the initial provider foundation, not the complete workspace. Public source does not mean a hosted deployment.

The new application and adapters were authored here during the event, with implementation commits dated October 31 and November 1, 2026. New work includes the viewer/workspace, case persistence and provenance contracts, bounded agent, inference adapters, mask-preview ledger, native-slice correction, geometry dependency tracking, historical source/input checks, and native oblique CTA display. No legacy Seldinger application code was imported.

Upstream libraries, public datasets, and pretrained checkpoints are dependencies, not newly trained models or newly collected data. Meta provides Muse Spark Open and SAM 2.1; separate pretrained vessel/aneurysm adapters are not presented as Meta models. Source images, model weights, local state, and generated evidence are excluded from git.

## Implemented

- React/TypeScript workspace with upstream NiiVue: linked slices and 3D volume view, display presets, crosshair location, and measurement evidence links.
- Browser-local NIfTI loading. Image bytes are not uploaded to the workspace server or included in Muse requests.
- FastAPI and local SQLite case state, notes, point-to-point distances, optimistic revision checks, and Markdown brief export.
- Case reopening by image fingerprint preserves saved notes and measurements in the same browser/server workspace.
- An editable aneurysm worksheet: operator-marked image target, lesion/context fields, user-assigned manual measurement roles, discussion candidates and planning questions. Saving is revision-bound and reopening the same image restores it.
- Baseten Muse Spark Open reads the server-bound case/worksheet snapshot through a bounded tool loop. Selected-option discussion also requires a fixed primary-source bundle, with source population and coverage limits visible. The model cannot select a different case, write planning state, execute shell commands, or fetch arbitrary files or URLs.
- Direct Meta model adapter for separate infrastructure tests.
- Original-public-case reference preview: a hash-checked context CTA crop and paired curated 3D surfaces, fixed case-bound asset routes, browser-side asset verification, reference-target navigation and a dedicated surface view. This is dataset-provided geometry, not a new segmentation result.

- Case-bound local inference workers for trained binary vessels, trained aneurysm segmentation within an installed context crop, and Meta SAM 2.1 prompted segmentation/correction. Candidates have an explicit preview/accept/reject lifecycle, source identity, and versioned producer provenance. Local inference reads the installed public source; user-opened viewer files and Muse requests do not upload the scan.
- Correction of an accepted mask on one native slice, preserving other slices. Acceptance invalidates dependent geometry/sizing results. This is not 3D propagation or evidence of better anatomical boundaries.
- Operator-defined neck/parent planes and path, prototype sac/section geometry, and native CTA reslices with accepted-mask contours. Source, physical units, case/input revisions, and currentness gate the displayed outputs.
- Historical FDA-label references, saved independent operator sizing inputs, deterministic checks/arithmetic, and explicit missing/stale/outside-range states. Mask-section extrema are not silently copied into independent sizing fields. The exercised public example still has missing independent inputs, no selected device, and no clinical compatibility determination.
- Interactive **Device studio** with authored Stryker/Medtronic flow-diverter braids, WEB SL/SLS cages and two illustrative coil families. Place and compare them with hash-checked accepted native-mask surfaces and optional linked CTA; edit dimensions/pose/path and retain independent browser-local alternatives. Geometric warnings and source/recall status are separate from clinical suitability.
- An explicitly hypothetical research physics bench: ideal-helix diameter/length coupling, a cited local thin-screen pressure-loss equation, and primary-coil volume arithmetic requiring explicit inputs. These are not patient-specific CFD or outcome predictions. See [exercised studio evidence and limits](docs/verification/device-planning-studio.md).

## Current limits

This is not a clinically validated planning application. Full-head aneurysm localization, segmentation accuracy, anatomical plane validity, clinical morphometry, device suitability, individual risk, treatment selection, deployment simulation, and improved outcomes are not established. SAM is **2.1**, not SAM 3.1. Muse reads saved case/worksheet metadata and a fixed source bundle; it does not inspect scan pixels, operate the viewer, accept masks, compute geometry, or choose a device. Point-pair distances and current mask-section calculations are not validated clinical diameters.

The mm-calibrated Zenodo case `006` is a development example, publisher-classified fusiform-saccular. DICOM calibration does not validate reference-informed crop selection, STL registration, or the operator-defined planes. A smaller context produced an empty vessel result, retained as a negative result; a larger context produced nonempty candidates, not proof of anatomical accuracy. See [calibrated application evidence](docs/verification/calibrated-source-application.md).

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

The separate **Open reference CTA** action reads an installed bundle from ignored `.runtime/public-reference/`. The exercised case is CMHA `AHMU1218001`, acquired directly from the original public distribution. A fresh stdlib adapter preserves raw crop voxels, intensity scaling and the unspecified source-unit declaration. The paired curated STLs use an explicit candidate x/y sign transform. The interface labels that uncertainty, keeps millimeter measurements disabled, and renders references only in 3D, not as projected whole-mesh shapes on slice images. See [original-case verification and preparation](docs/verification/original-case-reference.md). Neither dataset assets nor model weights are included in git.

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

## Optional source/model installation

A fresh source checkout can run the basic viewer, local workspace, manual evidence, and brief export with an authorized user-opened NIfTI. It does not include demonstration datasets or model weights. **Open calibrated CTA** requires the separately prepared, ignored Zenodo source bundle; source [DOI 10.5281/zenodo.15697196](https://doi.org/10.5281/zenodo.15697196), CC BY 4.0. Model buttons require pinned checkpoints and isolated runtimes. See [model source/runtime evidence](docs/verification/model-foundations.md), [reference preparation](docs/verification/original-case-reference.md), and [calibrated context preparation](docs/verification/calibrated-context-preparation.md). These are exercised preparation records with limits, not a one-command installer or permission to redistribute assets.

## Current verification checkpoint

On November 4, 2026, the local backend suite passed **557 tests**, with **97 optional heavyweight skips**. A separate isolated native surface/mask-geometry lane passed **16 synthetic tests**. Ruff lint and format passed. The frontend passed **188 tests**, TypeScript/production build, and the production dependency audit (zero reported vulnerabilities). Vite retains a large-chunk advisory. Skipped real-model tests are not counted as passed, and software checks do not establish clinical performance.

Actual browser checks also exercised a live Baseten Muse call, local SAM correction preview/rejection, native geometry recomputation after a case revision, and saved-note/brief readback on the public calibrated case. Related retained evidence:

- [Actual calibrated application and context-size diagnostic](docs/verification/calibrated-source-application.md)
- [SAM acceptance to downstream invalidation/recomputation](docs/verification/device-sizing-sam-lifecycle.md)
- [Native oblique CTA sections and independent pixel readback](docs/verification/native-cta-oblique-sections.md)
- [Historical sizing input/result application checks](docs/verification/device-sizing-application.md)

Verification documents are historical checkpoints. Later notes supersede earlier implementation-status statements without erasing negative results or clinical limits.

## Earlier viewer-only evidence boundary

Backend persistence, stale-write rejection, brief export and the live Muse read-tool round trip have been exercised with explicitly synthetic metadata. The real public CMHA crop has also been exercised in an attached browser: all five layouts, crosshair and display-preset changes, 3D camera motion, saved-note persistence after reopening, brief export, and a live Muse call reading the saved public-case metadata and notes.

The measurement UI separately saved a physical-RAS point-to-point distance from an explicitly synthetic, millimeter-declared NIfTI geometry fixture. The real CMHA crop still has unknown spatial units and its millimeter measurement controls remain disabled. These are functional/rendering checks, not segmentation, morphometry, device-sizing or clinical validation. See [browser verification](docs/verification/browser-smoke.md) for the precise evidence boundary.
