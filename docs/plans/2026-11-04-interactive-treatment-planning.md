# Interactive CTA and Device Treatment Planning Implementation Plan

> **For Hermes:** Implement through the Hermes-native engineering harness with bounded independent review and test-first vertical slices. OMP is retired. This document is a plan, not authorization to start a new deployment or a claim that these features work.

**Goal:** Build a hands-on aneurysm planning environment in which Colin can manipulate real CTA and segmentation, position devices in the anatomy, and compare untreated and treated scenarios, progressing from geometric fit to computed flow changes and eventually outcome prediction.

**Architecture:** Keep the fresh `seldinger-planner` application and its case/artifact contracts. Introduce a shared physical-space scene and editable planning scenarios; retain NiiVue for image views and add an upstream vtk.js 3D planning renderer for surfaces, device picking and simulation fields. Geometry, deployment approximations, CFD and clinical outcome prediction remain separate versioned producers.

**Tech stack:** Existing React/TypeScript/Vite, NiiVue, FastAPI/SQLite, isolated Python imaging/model workers; proposed upstream vtk.js for the planning scene, Python mesh/centerline processing, and an isolated OpenFOAM research worker for CFD. Pin and audit new dependencies before installation. No new cloud service is needed for the first deliverable.

**Status:** Internal proposed plan,2026-11-04. No application code changed for this planning request. Estimates below are planning ranges, not measured throughput or delivery promises.

---

## 1. Correction to the product direction

The present application overemphasizes worksheets, provenance panels and numeric results. A viewer beside those panels is not an interactive treatment-planning product. Passing tests did not establish that the experience matched the requested application.

The next milestone is not another measurement endpoint, model search, chat feature or video edit. It is a complete interaction: **inspect anatomy → edit segmentation → choose a device → manipulate its placement → compare scenarios**.

The original application is a capability reference, not a source to copy. Read-only inspection confirms source wiring for independent CTA transfer/threshold controls, anatomy opacity and layer manipulation, NiiVue/VTK rendering, and braid/coil/WEB overlay actors. Its intervention plan also documents prior reduced-order work and an idealized CFD experiment. This is materially beyond the new app's current device experience. This planning pass did not launch the original app or rerun its scientific experiments.

Preserve the fresh-build constraint. Do not copy old application code, tests, configuration, device assets or generated research artifacts. Retain original owned checkpoint integration under existing provenance contracts; author new interactions and scientific adapters from fresh contracts and upstream/primary sources.

## 2. Target experience

Default screen:

- **Center:** large interactive 3D vessel/sac/device scene, not a long form or chat transcript.
- **Adjacent:** linked axial/coronal/sagittal slices and an adjustable oblique plane; click a vessel or device in3D and see its position in CTA.
- **Left:** anatomy/layer tree with independent CTA, vessel, aneurysm, device, centerline and flow-result visibility/opacity.
- **Right:** contextual inspector for the selected structure, editing tool or device. Secondary drawers hold catalog evidence and provenance.
- **Bottom:** saved scenario cards such as untreated, device A, device B. Compare views share camera and slice location without sharing mutable plan state.
- **Optional assistant:** typed shortcuts to the same tools. All essential interactions work without an LLM.

Visible interaction modes: Navigate, Edit mask, Measure, Place device, Inspect results. Mouse/keyboard hints change with mode; an erase gesture must never silently rotate a camera, and normal camera motion must not paint a mask.

The first live walkthrough must show real changes: clip the CTA, isolate anatomy, correct a boundary, move a neck/landing handle, deploy a device, move or resize it, and switch between saved alternatives. A screenshot of a prepositioned overlay does not pass.

## 3. Baseline and reuse boundary

Current source inspected at `86b34f1` on `feat/fresh-planning-workspace`. Preserve the existing modified source-audit and untracked TopAneu verification note. Legacy source inspected read-only at `16893baab0973b2e06dccb03ef40e6090226009f`; its unrelated worktree changes are out of scope.

| Area | Present new-app foundation | Required change |
|---|---|---|
| CTA | NiiVue already supports linked simultaneous MPR/render, window presets, crosshair and camera interaction | Preserve that linkage in a persistent planning layout; add custom window/level, transfer/opacity controls, clipping and saved camera |
| Segmentation | Case-bound model candidates, preview/accept/reject; native-slice SAM correction | Simultaneous vessel/sac layers, actual accepted-mask surfaces, direct brush/erase, undo/redo, component cleanup and rapid preview |
| Geometry | Native mask mesh calculations; operator planes/path; oblique CTA images | Direct draggable/pickable3D neck plane, parent path and landing handles; image-linked calipers |
| Devices | Historical sizing arithmetic and source work; no deployment scene | Current small catalog, physical-space overlays, deployment state and fit measurements |
| Alternatives | Worksheet text and discussion candidates | Durable independent device scenarios and synchronized visual comparison |
| Simulation | No deployment/CFD pipeline in fresh app | New deployment model, CFD jobs, quantitative before/after fields and verification |

Do not make independent detector performance a prerequisite for the workspace. Use identified curated or corrected reference masks on approved public CTA cases while inference is separately evaluated. TopAneu provides aneurysm labels; its vessel masks are silver-standard model outputs, not expert vessel references. Keep research-only scope and attribution. Do not automatically use the existing case006 morphology as a universal sidewall or WEB demonstration case.

## 4. Coordinate, artifact and scenario architecture

### Physical-space scene

`PlanningScene` contains CTA source identity, accepted vessel/sac mask IDs, display mesh IDs, neck plane, centerline/path, branch landmarks and devices. Canonical planning coordinates are physical RAS millimeters. Record voxel-to-RAS and renderer transforms explicitly. Mirror/oblique/anisotropic fixtures and actual source-to-renderer landmarks must agree. Rendering decimation is separate from the measurement/simulation mesh; cosmetic smoothing never changes measured anatomy silently.

Initial upstream vtk.js tracer: one calibrated CTA, one accepted-mask surface, one draggable fiducial and one generated device line/tube synchronized with NiiVue. This is a bounded integration test, not a renderer rewrite. If the dual-renderer route cannot preserve coordinates and interaction performance, record the specific failure and use NiiVue-only surface controls for the first checkpoint. Do not silently install a third renderer or migrate to a PACS platform.

### Versioned scenarios

A scenario references immutable inputs and its own draft/committed placement:

```ts
type PlanningScenario = {
  id: string;
  caseId: string;
  imageSha256: string;
  acceptedMaskIds: { vessel: string; aneurysm: string };
  geometryResultId: string;
  catalogRevision: string;
  devices: Array<{
    instanceId: string;
    catalogEntryId: string;
    deploymentModelVersion: string;
    placementRevision: string;
    poseRAS: number[];
    controlPointsRAS: Array<[number, number, number]>;
  }>;
  revision: string;
};
```

This is a proposed frontend contract, not a claim that these identifiers exist today. Server schemas validate types, dimensions, bounds and case bindings. CFD results additionally bind deployed-geometry hash, fluid domain, boundary conditions, material/porous parameters, solver version and convergence report. Device position, anatomy, neck plane or boundary-condition changes invalidate dependent results. Display opacity and camera changes do not invalidate physics. A late result can be retained for its old scenario, never relabeled current.

Interactive drafts update locally. Accept/save commits a new revision; cancel leaves the last accepted state intact. Accepted segmentation revisions invalidate measurements, device fit and simulation exactly as the present dependency pipeline already does. Extend existing state guards rather than replacing them with loosely coordinated frontend state.

## 5. Delivery sequence with demonstrable exit gates

### Milestone A: restore an excellent imaging and editing workspace

**Scope:** linked3D/MPR; rotation/pan/zoom/reset; custom window/level and CTA transfer functions; clipping plane; independent vessel/sac visibility, colors and opacity; lesion focus; accepted-mask surface extraction; direct native-grid brush/erase; undo/redo; explicit preview/accept/cancel; SAM as an optional local refinement tool.

Begin with axial native-grid editing, then extend to orthogonal views through the same tested coordinate mapping. Oblique mask painting is not enabled until its voxel brush geometry is verified. Provide connected-component removal with preview. No automatic aggressive smoothing or filled-in missing branches. Save/reopen restores mask revisions and scene configuration.

**Exit gate:** Colin can load a real public CTA, remove obstructing tissue from the display, inspect vessel/sac surfaces from any angle, edit the segmentation and see2D/3D update together, undo it, accept an edit and reopen it. An actual browser recording and persisted-mask readback must demonstrate this before moving the main build effort to simulation.

### Milestone B: direct anatomical planning and the first device overlay

**First treatment story:** a flow diverter across an appropriate sidewall aneurysm. Select the actual public case after checking morphology, usable parent-vessel extent and calibration. Use a separate bifurcation case for WEB; do not force both onto the same anatomy.

- Click proximal/distal landing positions in linked CTA/3D; drag the handles and neck plane directly.
- Generate a vessel-constrained centerline proposal between picked points, allow corrections, and inspect orthogonal lumen sections. Do not reuse a PCA line as a sufficient path in a tortuous artery.
- Integrate one small manufacturer/jurisdiction-specific flow-diverter family with verified dimensions and source revisions. Unknown mechanical/braid parameters stay unknown rather than guessed from marketing dimensions.
- Generate a curved device envelope and braid visualization, not a straight cylinder. Device geometry follows the selected vessel path using a stable transported frame.
- Manipulate diameter/length, axial position and allowed deployment controls. Keep nominal dimensions, modeled deployed length and operator inputs distinct.
- Show landing-zone extent, neck span, local device-to-wall distance, branch-ostium overlap and lumen intersection. These are geometric diagnostics; they do not prove deployability, apposition forces or branch patency.
- Render the device in3D and as physical intersections on CTA slices, not a projected whole-device silhouette.

**Exit gate:** a user places, moves, resizes, removes and restores the device in real anatomy. Switching sizes changes actual mesh and geometric checks. Reload reproduces the same saved placement. A deliberately poor placement must produce a visibly poor fit, not a forced green result.

### Milestone C: comparative planning, WEB and coils

First persist untreated and two FD alternatives with shared-camera split comparison and image-linked differences. Then add family-specific planning:

- **WEB/intrasaccular:** source-backed nominal size and catheter fields; orient a barrel/mesh approximation in the sac, adjust depth and axis, inspect protrusion into parent/branches, residual geometric neck opening and sac-wall intersections. A fitted ellipsoid is not mechanical deployment or proof of neck sealing. Integrate the already captured37-SKU portfolio only with its separate current IFU/catalog revisions; CTA measures do not silently satisfy required angiographic acquisition criteria.
- **Coils:** selectable coil inventory with source-backed primary wire/coil dimensions; total material-volume packing arithmetic; deterministic in-sac geometric packing preview with collision/protrusion flags. Do not fabricate a physical coil rollout or equate packing percentage with occlusion probability.
- **Stent-assisted coiling:** combine independently versioned stent and coil instances only after both producers work; no unverified combined efficacy score.
- **Discussion:** compare explicit anatomical/technical tradeoffs and missing clinical information. Keep treatment choice with the operator; the assistant cannot fill unknown physiology or override fit findings.

**Exit gate:** changing one scenario does not mutate another. The same anatomical edit invalidates all dependent alternatives. Comparison separates fit values, assumed device geometry and computed flow results, rather than mixing them in a single success score.

### Milestone D: genuine untreated-versus-treated hemodynamics

This is part of the build direction, not a decorative animation added to the video.

1. Prepare a trimmed, inspectable, watertight lumen domain from reviewed segmentation. Preserve relevant parent/branch outlets and define the neck/sac analysis region. Surface repair and inlet extensions are explicit transformations with before/after artifacts.
2. Run untreated3D flow on a small idealized reference before patient-derived geometry. Start with incompressible rigid-wall Newtonian assumptions, clearly stated, and then a pulsatile inlet with explicit outlet conditions.
3. Add the first FD as a calibrated thin porous-screen/tubular interface with local resistance tied to the deployed device geometry. Do not infer resistance from metal coverage alone using an invented monotone curve. Compare against a wire-resolved or published experimental reference on a tractable fixture.
4. Freeze the baseline and treated cases under identical inlet/outlet assumptions and meshes/protocols suitable for paired comparison. Provide a sensitivity sweep when flow is assumed, not patient-measured.
5. Compute neck inflow, mean sac velocity, inflow-jet changes and outlet flow distribution. Add WSS only when near-wall resolution is adequate. Define oscillatory metrics only for a converged pulsatile run. Residence/contrast-washout requires an actual transport/particle calculation, not animation along a centerline.
6. Display measured flow fields, streamlines/pathlines with correct labels, velocity colors and optional actual computed contrast washout. On device movement, mark old physics stale; show job progress and keep the viewer responsive.
7. Require mass balance, mesh/time-step convergence, cyclic convergence where applicable, bounded residuals and an independent physical reference before accepting quantitative effects. Initial engineering targets: mass imbalance under1% and key scalar changes under5% across mesh/time refinement; these are numerical gates, not clinical accuracy claims.

**Exit gate:** one idealized and one public CTA-derived case each complete reproducible baseline/FD jobs. Device changes modify the actual solver input. Any cached result is labeled precomputed and bound to the exact scenario. No flow animation is presented as solved physics unless its fields came from that job.

Initial outputs can say **modeled sac inflow reduction under these assumptions**. They cannot say **probability of aneurysm obliteration**. Subsequent WEB/coil porous representations require their own parameter and validation work; do not apply FD coefficients to other devices.

### Milestone E: deployment mechanics and eventual obliteration prediction

Two distinct programs:

- **Mechanics:** improve from geometric placement to constrained braid expansion/foreshortening and later force-based contact, validated against known deployed shapes and bench evidence. Only then make mechanical wall-apposition statements. WEB deformation and coil dynamics need separate models, not scaled copies of the FD model.
- **Outcome:** develop time-resolved thrombosis/transport research if useful, but long-term angiographic obliteration additionally depends on healing, antiplatelet exposure, branch flow and clinical variables. A validated outcome model requires actual treated-device geometry/strategy, longitudinal occlusion endpoints and patient-grouped external evaluation/calibration. TopAneu is not such an outcome cohort. No manually chosen formula or LLM-generated percentage fills this gap.

Outcome-data access, institutional collaboration and external claims remain separately approval-gated. Lack of outcome data must not block A–D.

## 6. Concrete first implementation packages

Every package uses RED → minimal implementation → GREEN → browser/producer check → bounded review → scoped commit. Implement one exercised layer at a time. Do not dispatch competing writers into `App.tsx`.

| Package | Exact proposed files | First failing specification | Real-path check |
|---|---|---|---|
| Scene/display contract | Create `web/src/planning/sceneState.ts`, `.test.ts`; modify `web/src/Viewer.tsx` | Changing camera/opacity preserves mask and measurement revisions | Rotate/clip/hide CTA while accepted anatomy stays aligned |
| Renderer tracer | Create `web/src/planning/PlanningScene.tsx`, `rendererTransforms.ts`, `.test.ts`; modify `web/package.json` | Oblique source fiducial maps to same RAS point in both renderers | Pick and refocus same landmark across3D/MPR |
| Simultaneous masks and surfaces | Modify `web/src/Viewer.tsx`, `web/src/App.tsx`; create `planner/surface_worker.py`, `tests/ml_runtime/test_surface_worker.py` | Both accepted roles render; stale/cross-case mesh is rejected | Hide vessel without hiding sac; accept edit updates only proper surface |
| Native editing | Create `web/src/planning/MaskEditor.tsx`, `maskEdits.ts`, `.test.ts`; create `planner/mask_edits.py`, `tests/test_mask_edits.py` | Stroke/undo restores exact bytes; cancel never commits; transformed brush hits intended voxel | Actual noncentral public-case brush, undo/redo, accept/reopen |
| Direct planes and path | Create `web/src/planning/GeometryHandles.tsx`, `.test.tsx`; modify `web/src/MorphometryInputs.tsx` | Dragging handle changes RAS location while preserving valid coordinate frame | Move neck and landing handles in3D; inspect actual oblique images |
| Device producer | Create `planner/device_deployment.py`, `tests/test_device_deployment.py`; create `web/src/planning/DeviceInspector.tsx`, `.test.tsx` | Curved path creates matching rendered/calculated geometry; absent specs do not produce fabricated mechanics | Place two actual catalog sizes and observe mesh/fit change |
| Scenario ledger | Create `planner/scenario_state.py`, `scenario_server.py`, `tests/test_scenarios.py`; create `web/src/planning/ScenarioCompare.tsx`, `.test.tsx` | A/B state isolation, revision conflicts and anatomy-change invalidation | Save/reopen alternative placements with synchronized camera |
| CFD job boundary | Create `planner/simulation_contract.py`, `simulation_worker.py`, `simulation_server.py`, `tests/test_simulation_contract.py` | Mismatched geometry/BC hash cannot become current; timeout/cancel persists failure | Real isolated solver job plus exact result readback |
| CFD verification fixtures | Create `research/hemodynamics/README.md`, `research/hemodynamics/verify_run.py`, `tests/test_flow_metrics.py` | Analytic mass flux/units and known manufactured field metrics match | Untreated/treated fixture, convergence sweep, then public case |

Files are proposed new modules, not existing implementations. Resolve final API names against the relevant installed upstream version before writing code. Keep physics manifests and generated outputs outside source control. No routine `.env` reads.

Commands to run at applicable gates, not claims that they ran in this planning turn:

```sh
# Repository root
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
git diff --check

# Existing isolated imaging test lane, add new native tests when written
SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_geometry_worker.py tests/ml_runtime/test_mask_geometry.py -q

# Frontend
cd web
npm test
npm run build
npm audit --omit=dev
```

There is currently no `npm run lint` script. Do not invent a successful lint command. Add candidate formatting/type checks and actual browser interaction coverage. CI green is necessary for code publication, not sufficient product acceptance.

## 7. Delivery priorities and effort

Recommended effort envelopes, to be revised after the first renderer/editor tracer:

- **First visual checkpoint:** A, then a single movable FD overlay from B. Aim for the first several focused development days, not weeks of invisible infrastructure first.
- **Interactive planning prototype:** A–C, roughly2–3engineering weeks for a focused implementation/review loop. Not a validated deployment simulator.
- **First paired3D CFD research integration:** D, roughly an additional2–4engineering weeks if solver installation, mesh generation and device resistance references are tractable. Explicit-device/FEM work can extend this substantially.
- **Validated mechanics and clinical obliteration predictions:** no honest calendar commitment before bench/reference inputs and longitudinal outcome data exist.

These are scope estimates, not promised dates or a claim that agents can compress validation into parallel execution. Viewer/interaction work and source/physics audit can proceed independently. Do not delay the visible workspace for catalog completeness or a new detector.

## 8. Product acceptance, not just test counts

Before another polished video, exercise a live end-to-end session on authorized public CTA:

1. Load a fresh case and show aligned CTA, vessel and sac in simultaneous3D/MPR.
2. Manipulate view, clipping, transfer functions and individual layers without losing anatomy or measurements.
3. Edit a boundary; undo/redo; cancel; accept; close/reopen; verify exact mask changes.
4. Place and move a device with actual dimensions; inspect it in both3D and slices.
5. Compare two different placements, including one visibly poor fit; reopen both unchanged.
6. Change anatomy and demonstrate that old fit/flow outputs are stale, never silently current.
7. For the CFD milestone only, run or explicitly replay a scenario-bound solved result, expose assumptions, and show actual numerical differences.

Initial usability targets to measure, not assume: at least30fps during basic camera motion on the designated demo machine, preview interaction within200ms for bounded local edits/device handles, cancellation without frozen UI, and saved-case reopen without state loss. Qualify3D surface rebuild and solver latency separately. Parent verifies exact current source and browser behavior; independent review checks coordinates, state coherence and scientific claim boundaries.

The next presentation is earned by this workflow. Narration, moving cameras and a larger number of passing tests cannot substitute for it.

## 9. Source anchors and limits of this plan

- Canonical founder direction: `/Users/colin/Obsidian/Main/Business/Seldinger/Product & Research/Seldinger CTA Planning Rebuild Proposal.md`. This plan expands device simulation previously deferred there; it is not a claim that the older proposal authorized clinical efficacy statements.
- Current new-app source: `README.md`, `web/src/Viewer.tsx`, `web/src/MorphometryInputs.tsx`, `planner/geometry_worker.py`, current sizing/reference docs.
- Read-only legacy audit: `seldinger-app/apps/web/modules/viewer.js`, `docs/intervention-plan.md`, `data/cfd/idealized_aneurysm/README.md`. Legacy CFD README specifies a2Dsteady channel/cavity mean-speed metric. Do not relabel that as patient-specific neck inflow, outcome validation, or a fresh run of the new app.
- Upstream rendering: https://niivue.com/docs/ and https://kitware.github.io/vtk-js/ . Installed NiiVue source confirms clip-plane, opacity and drawing controls; that does not make their application integration complete.
- Primary porous-model methodological lead: https://pmc.ncbi.nlm.nih.gov/articles/PMC9372908/ . Resolve full methods and parameters before implementation; a literature result does not validate our producer.
- Current WEB source capture: `docs/research/current-web-us-sources.md`; acquisition/label constraints: `docs/verification/topaneu-noncommercial-prototype.md`.

This is a proposed build plan backed by source inspection, not a new application run, full engineering implementation, mechanical validation or CFD study.

## 10. Independent review disposition

Two bounded independent audits were reconciled against actual source and primary papers:

- **Retain existing linkage:** simultaneous NiiVue MPR/render is already present. The workspace task exposes and extends it rather than claiming it must be invented.
- **Reject the orphaned-oblique claim:** `App.tsx` mounts `MorphometryResults`, which renders `ObliqueSection`. The missing interaction is draggable plane manipulation, not absence of the native CTA section component.
- **Reject automatic sizing-field substitution:** geometry-derived defaults cannot populate the six independent sizing inputs unless their measurement definitions actually match and provenance is explicit. Operator confirmation alone does not turn a section extremum into a different quantity.
- **Reject dome deletion as obliteration simulation:** deleting or hiding the sac may be a geometric display operation, not a simulation of treatment effect. Keep anatomy and treatment representations separate.
- **Add a concrete mechanics candidate:** Závodszky et al.,2020, DOI10.1002/cnm.3340, https://pmc.ncbi.nlm.nih.gov/articles/PMC7317397/ describes a spring-mass braid with measured-force calibration, diameter/length coupling and push-pull effects. Parent verified the primary abstract. Reproduce its mechanics/bench tests before claiming our implementation has those properties; do not inherit the paper's runtime or validation as our own. Article license is CC-BY-NC4.0; verify any associated code/data rights separately.
- **Retain the thin-screen CFD route:** Abdehkakha et al.,2021, DOI10.1016/j.compbiomed.2021.104988, https://pmc.ncbi.nlm.nih.gov/articles/PMC9372908/ supports local deployed-pore-dependent thin-screen resistance. Its reported small-study agreement with explicit CFD is a reference, not an automatic accuracy gate or evidence about our outputs.
- **Coil representation matters:** Fillingham et al.,2023, DOI10.1016/j.jbiomech.2023.111733, https://pmc.ncbi.nlm.nih.gov/articles/PMC10528313/ compares FEM and micro-CT coil geometries in four ICA aneurysm models and reports materially larger neck-inflow errors for a porous approximation. Parent corrected the incoming audit's author/year attribution. Do not turn global packing into a uniform, supposedly validated flow obstruction.
- **Outcome data remains absent:** the incoming suggestion that TopAneu might supply angiographic follow-up was unsupported. It remains an anatomy/annotation development source, not a demonstrated treated-outcome cohort.

The audits informed this plan; neither was a fresh browser test or implementation review. Parent verification rejected inaccurate findings rather than treating all suggestions as approved requirements.
