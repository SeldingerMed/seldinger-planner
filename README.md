# Seldinger Planner

The canonical treatment-planning repository for Seldinger. The local `plan.md` is the controlling architecture and phased implementation plan; it remains intentionally uncommitted and is not distributed with this source checkout. The product direction spans neurovascular, coronary/structural-heart and peripheral/aortic planning; the implemented imaging workspace remains aneurysm-first. This is a research prototype, not a clinical service or a treatment-recommendation system.

## Phase 1 consolidation

Reusable catalog/database patterns, territory contracts and deterministic calculators have been adapted locally from `seldinger-app` and `seldinger-ml`. Runtime imports do not depend on those sibling checkouts. A shared SQLite catalog projects the frontend listing through `/api/devices`, with explicit unverified category scaffolding outside the sourced neurovascular listing. Unsupported commercial SKU, primary-coil-diameter and regulatory claims are not filled with guesses.

Current accepted-mask metadata, scalar morphometry, derived indices and saved operator-reported sizing are available through `/api/cases/{case_id}/planning-context`, in the Markdown brief, and to the bounded agent after the existing public/synthetic-data confirmation. Recomputed result identities invalidate a model response even if the case revision is unchanged. No image, mesh, contour or centerline arrays are included in this computed context.

Additional server-installed NIfTI-1 sources can be discovered by an opaque source ID and a verified manifest under `.runtime/installed-sources/`. This bounded path requires millimeter units and explicit sform calibration, preserves hash/revision checks and rejects malformed or tampered sources. It is not a generic clinical-data upload service. See the [installed-source contract](docs/installed-sources.md).

## Phase 2 native numerical workers

The device studio now pairs the analytical bench with bounded native-mask rod and Stokes/Brinkman research workers. Results are persisted against exact source, accepted-mask, case and geometry identities. Hypothetical mechanics/flow inputs and diagnostic residuals are not device calibration or physiological validation. Mask-derived parent-path proposals require operator confirmation, review of geometric station suggestions, and a separate save.

See [native numerical setup, API contracts and limits](docs/native-physics.md). The model-free numerical runtime and synthetic numerical tests have a separate CI lane. The exercised browser integration uses production components with generated images/masks, not clinical data or a new full-App source-import validation.

## Phase 5 anatomy-assisted planning

The imported-CTA workflow now connects accepted vessel/sac masks, editable path/plane proposals, explicitly computed measurements, saved anatomical device alternatives and a fresh source-bound brief. Proposal generation does not accept a mask, save operator landmarks, confirm a reformat scene or choose a device.

- Original-artifact RSNA vessel/sac inference and initialized SAM2 correction use pinned local workers. A correction changes one native slice of an existing full mask; immutable ancestry distinguishes that edit from standalone single-slice segmentation. Acceptance invalidates dependent results.
- Device alternatives on admitted anatomy use a server ledger with independent revisions, exact authored-catalogue identity, explicit saves and reload/discard recovery. The separate analytical bench retains local-only alternatives.
- Saved rod and Stokes runs are read through the validated numerical ledger into the studio and brief. Parameter hashes and geometry/result identities remain visible; custom rest-shape coordinates are represented by count/hash in scalar exports. These are anatomy/operator-parameter runs, not solved outcomes for a commercial device alternative.
- Guided readiness separates current saved evidence from dirty drafts, pending confirmation, failed reads and stale downstream results. A fresh export rereads the coherent source-bound snapshot instead of exporting cached screen state.

Actual public case013 execution covers inference, proposal/edit/save, correction acceptance, geometry recomputation, native reformats, scenario save/reopen and browser downloads. The nontrivial rod rest-shape experiment converged in 103 iterations and its recorded discrete energy and sampled clearance were independently recomputed. The full native flow domain exceeds the retained Stokes mesh budgets; that refusal remains a negative result, without cropping the anatomy or increasing limits to force success. Reference-STL frame/units and training overlap remain unresolved, so these records do not establish external-reference accuracy. See [source/model provenance](docs/verification/phase5-source-model-evidence.md), [reference annotation contract](docs/verification/phase5-reference-annotation-contract.md) the [correction-consistency report](docs/verification/phase5-evaluation-report.md), and the [implementation contract](docs/plans/phase5-anatomy-workflow.md).

Existing territory workflows, DICOM preparation, native reformats and explicit rigid registration remain separate source/scene contracts. No dataset images, model weights or local SQLite workspaces are distributed with this source.

## Fusion Step A: C-arm views and projection geometry

The planner now models a C-arm in the patient frame of an admitted volume. An operator can define an isocenter and target path, save up to eight named working views, read per-view foreshortening and field coverage, ask for a low-foreshortening angle proposal and preview a simulated projection of the volume. A separate local converter admits the acquisition geometry of a projection XA run (angles, distances, pixel spacing, frame timing and biplane linkage) without retaining pixels.

This is the geometry layer for later 2D/3D fusion. Nothing is registered to an acquired angiogram, no angiogram is displayed, and the angle convention is declared from DICOM rather than verified against a vendor system. See [C-arm views and projection geometry](docs/carm-projection.md).

## Fusion Step C1: angiogram overlay and 2D-to-3D registration proposal

A separate local command admits a small, bounded set of angiographic frames (at most two planes and eight frames per plane, from PNG or uncompressed DICOM XA), each bound by SHA-256, with the deidentification basis recorded per plane. The overlay studio shows one verified frame, proposes a rigid pose that lays the accepted vessel mask's projected points on the frame's extracted centerlines, and saves the proposal only after the operator reviews the overlay and confirms it. Frames from a video are extracted outside the app by `scripts/extract_angio_frames.py`, which installs a pinned, hash-checked ffmpeg when none is on PATH.

Everything is retrospective. No live video is read, a saved proposal is not a validated registration, and no registration accuracy is claimed. See [Angiogram overlay and 2D-to-3D registration proposal](docs/angiogram-overlay.md) and its [verification note](docs/verification/step-c1-angiogram-overlay.md).

## Historical hackathon source and original work

The source checkout includes the planning workspace. Images and trained artifacts are installed separately under the source/model contracts below. Public source does not mean a hosted deployment.

The new application and adapters were authored here during the event, with implementation commits dated October 31 and November 1, 2026. That event baseline included the viewer/workspace, case persistence and provenance contracts, bounded agent, inference adapters, mask-preview ledger, native-slice correction, geometry dependency tracking, historical source/input checks, and native oblique CTA display. No legacy application code was imported into that event baseline; the subsequent Phase 1 consolidation above adapts selected sibling-repository components.

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

The [Phase 2 native-physics checkpoint](docs/verification/phase2-physics-centerlines.md) records the clean candidate, synthetic worker/browser evidence and review limits. The later [Phase 1 source verification](docs/verification/phase1-consolidation.md) records the consolidation review, clean-export checks and evidence boundaries. The checkpoint below is historical.

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
