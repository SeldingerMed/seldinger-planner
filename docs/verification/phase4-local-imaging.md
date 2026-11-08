# Phase 4 verification

## Delivered surface

The canonical planner adds a bounded local DICOM converter, confirmed physical-path scenes, two native CPR modes, first-person intensity-boundary navigation, explicitly registered secondary cross-sections and local source-bound Markdown export. All verification data in this phase was generated synthetic data. No patient/partner source, model invocation, external data transfer or deployment was used.

Operator instructions and the supported DICOM subset are in [Local imaging](../local-imaging.md). The implementation contract is in [Phase 4 local imaging](../plans/phase4-local-imaging.md).

## Actual producer and browser checks

The real CLI converted two generated 32×32×32 CT/MR series into fresh bundles admitted by the default API and actual NiiVue loader. The MR source's RAS origin was shifted by 2 mm. An explicitly confirmed secondary-to-primary translation of −2 mm aligned it to the primary source.

The actual App saved a three-point physical path and registration with independent scene revision 1. Straightened CPR, fixed-direction/stretched CPR, perspective boundary rendering and the registered cross-section all painted real canvas pixels. Reopening the saved case in a fresh browser context restored the path, registration and all four views.

An independent NiBabel/NumPy check at primary RAS [16,16,7] read native primary/secondary values 687/1203. With primary window [200,1800], secondary window [0,1400] and opacity 0.35, it predicted RGBA [50,127,127,255]. The actual registered canvas pixel matched exactly. The physical path length was 17.17269132744285 mm in both the independent calculation and scene result.

Camera pixel SHA-256 values changed from station 0 to 0.5 and again during real play/pause navigation:

- Station 0: `c6485ab833b364140882805f92b488f9ca30b63eca1e3cbaef42a1959ed2f24c`
- Station 0.5: `98d038a65d770b24044d9705cade89741a27f7b4c22f4797b02f1272ee477bfc`
- After playback, station fraction 0.545: `e434f501cdc9e45538eb23c8a699394cd3a7aa324f0121777020af24ba8d3675`

These are cropped canvas-byte comparisons, not hashes of changing UI labels.

A declared synthetic annular contour through the actual workflow API produced 24 mm² area, 20 mm perimeter and signed coronary heights 4/5 mm. The real Chrome download contained those current scalar results, source/scene/result identifiers and the displayed windows, station and ray/fusion settings. Readback found no synthetic private-tag sentinels, raw contours/paths or transform matrices. That initial download is a historical checkpoint; the final candidate receipt separately identifies its refreshed export.

## Failure and concurrency behavior

- Classic oblique CT/MR and enhanced CT/MR/X-Ray3D fixtures check patient-coordinate sorting, fresh headers, rescaled values and real installed-store admission.
- A forged file-meta group length hiding a second transfer syntax actually reached upstream dataset decompression before the guard was corrected. Its regression now rejects before decompression.
- Exact native pixel length is checked before upstream decoding can silently trim excess bytes. Missing pixels, mixed valid bit depths, unsupported syntax/projections, unsafe paths and resource limits reject without publication.
- A real CLI subprocess showed that lazy UID parsing could print a private-value warning after `dcmread`. The conversion boundary now treats warnings as rejection throughout parsing/conversion; the subprocess regression requires the exact sanitized stderr.
- Variable per-frame rescale is baked into pixels and described as `per_frame_linear`, with no misleading fixed coefficient.
- Actual post-commit acknowledgement injection replaced one successful save response with a labeled synthetic 409. The fieldset's effective disabled state and handler guard prevented attempted retries; no stale reformat canvases remained. Explicit reload recovered the exact committed scene while case version stayed 1. Recovery performed reads, not another mutation.
- Provider result replacement without a case-version change invalidates a composed brief. Corrupt current ledger evidence yields 503, not partial or silently missing numbers.

## Display and cleanup

Desktop rendering and a 430-pixel viewport were inspected. The narrow document width remained 430; the export action stayed within the viewport, with readable foreground/background, and all four canvases remained available. No external resource URLs were observed in the isolated page.

The task-owned Chrome targets and download context were closed/disposed. The isolated API process was terminated and port 18765 was verified closed. The unrelated service on 8765 was not changed.

## Exact candidate

The clean export from the Phase 3 merge, overlaid only with the intended Phase 4 files, passed 834 backend tests (111 optional skips), 380 frontend tests, 31 ingestion tests, 129 numerical tests and 52 model-free imaging tests. Ruff, explicit-runtime API/ingest Pyright, TypeScript/build and the production dependency audit passed. The final Chrome download was 2668 bytes, SHA-256 `ca1ee8f5175759ebc31ebc1eacbacde381accd981f4b08e3b37d8f8f0c9afbf4`, and retained the exact current scene, scalar results and display settings. The fresh registered pixel again matched [50,127,127,255]; the refreshed narrow viewport remained 430 pixels wide.

The companion [artifact manifest](phase4-artifacts.json) binds the source and verification artifacts. Removing the brief snapshot recheck in a throwaway candidate made the materialized-result race regression fail with an unsafe 200 instead of 409; restoring the exact guard restored green tests. Earlier mixed-checkout totals are not substituted for clean-candidate evidence. The local `plan.md` and eight other unrelated files remain outside the commit and are checked by their preserved hashes.


## Independent review dispositions

The read-only UI review traced source/operation epochs, ambiguous-save locks, busy ownership, exact byte/hash loading and fixed-origin bounds. A real throwing-stream test reproduced cleanup masking the size-cap error; cancellation/lock cleanup now preserves the original outcome. Export keeps its own disable and captured-receipt recheck rather than raising the parent busy indicator. A mismatched save echo intentionally remains ambiguous until reload; manually loading a changed secondary creates a draft but cannot render against a mismatched saved registration.

The independent converter audit reproduced malformed character-set exceptions, mixed bit depths and misleading variable-rescale provenance. The converter now sanitizes internal exceptions at its public boundary, rejects mixed effective encoding and accurately labels per-frame scaling; synthetic regressions pass. Identity rescale defaults and accepted sub-tolerance spatial jitter are documented operator-visible policies, not conversion failures. Final focused follow-up and repository-app clearance are recorded separately against their inspected source revisions.


Repository-app review found that stretched CPR used the first pixel-center station instead of the physical path start for its fixed direction. A short-first-segment, early-bend analytic regression failed before the correction and now passes at both coarse and fine widths. The filename fixture now uses a nonidentity permutation and reverse creation order. The alleged pre-sort affine origin was disproved: `_series` returns the sorted records, and `_write_bundle` independently selects their first record. A forced collection order `[5,4,0,1,3,2]` passes exact affine, per-voxel value and world-position checks; mutating the writer to use the wrong origin makes that regression fail. The final post-review browser rerun retained all four known center pixels and downloaded the same exact brief bytes. Operator-message spacing was corrected.


A subsequent review exposed globally recognized station/enum keys crossing the per-mode scalar whitelist. Five real-producer-derived negative cases now reject those keys in both projection and rendering. Confirmation toggles clear a prior pre-write error while preserving the dirty draft, with an explicit blocked-state handler guard. The optional duplicate-frame-build optimization was deferred: on a bounded 128-point helix, the measured extra frame lookup averaged 0.0173 ms versus 1.187 ms for the stretched raster. This is one local timing observation, not a general performance guarantee.


Failed scene reload now releases the discarded draft's parent dirty lock only for the live request owner. The real-parent regression first reproduced the stranded workspace and now verifies recovery without an enabled native display. Current and stale DTO variants reject unknown keys. One CI run hit the existing multi-stage calibrated-integration test's 5000 ms whole-test limit, without an assertion failure; that single comprehensive flow now has a bounded 15000 ms budget, with all of its original assertions retained. The complete clean frontend suite passes.
