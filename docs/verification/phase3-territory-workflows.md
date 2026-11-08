# Phase 3 verification: territory workflows

## Implemented behavior

The actual App retains the neurovascular workspace and adds coronary PCI, structural heart/TAVR, and aortic/peripheral workflows. Each has source-bound annotations, its own optimistic revision, immutable saved results and explicit reload recovery. Cardiac/aortic modes do not require an aneurysm mask.

- TAVR: operator-applied oblique plane, native-volume contour picking, annular area/perimeter/effective diameters, signed ostial heights.
- Coronary: ordered physical path, indexed lesion/reference sections, arclength, area-equivalent reference taper and narrowing, optional outward-ray bifurcation angle.
- Aortic/peripheral: neck arclength, three declared axis segments, minimum/maximum Feret profiles, traced wall/tissue burdens and left/right iliac access profiles.
- Missing tissue annotations remain unknown. Explicit empty class annotations mean observed zero. Tissue regions must lie inside a traced wall and outside the lumen without overlapping other regions.
- Generic server-installed millimeter sources are admitted separately from the stricter bundled public-demo provenance contract. Opening a local volume does not upload its pixels or authorize a new server source.

## Geometry definitions

Section vertices are physical RAS coordinates. A simple planar ring supplies area and perimeter; the convex hull supplies minimum/maximum Feret diameters. Area-equivalent diameters are used consistently in coronary relative narrowing. Minima are over the supplied sections, not unsampled intervening anatomy.

Path profile normals follow the centered previous-to-next chord at interior nodes and a one-sided chord at endpoints. Aortic alpha compares suprarenal-to-neck-start with neck-start-to-neck-end; beta compares that neck axis with neck-end-to-sac. Burdens use trapezoidal integration of class areas divided by corresponding outer-wall area integration over the declared neck interval.

## Independent resource limits

Per-field maxima are independent, not a promise that every combination of maxima can be submitted together. Each contour permits 128 vertices; each path permits 128 nodes and 32 profiles; each tissue class permits eight regions. A separate workflow-wide limit of 8,192 annotated positions includes section origins and all main/access/tissue paths; the request body is independently capped at 1,000,000 bytes. The App states the aggregate budget. A real default-API test confirms that a structurally valid 32-profile lumen/wall trace is rejected by the aggregate guard before storage, while the measured 8,030-point example is accepted. Raising the aggregate ceiling to the full structural Cartesian maximum would materially expand the bounded compute envelope and is intentionally not part of this release.

## Real App/API browser exercise

An isolated API served the production frontend, a fresh SQLite database and a generated 32³ signed-short NIfTI gradient with identity millimeter affine. Public samples/references and model calls were disabled in that instance. This was a software/geometry exercise on explicit synthetic bytes, not an anatomical dataset study.

Chrome interactions used the actual viewer cursor, applied planes and SVG contour picking. All three workflows were saved through the default API, then recovered after a fresh page load and reopening the same file:

| Workflow | Observed saved behavior |
| --- | --- |
| TAVR | Four-point ring: area 24.000000715 mm², perimeter 20.000000238 mm; two distinct cursor-selected ostia yielded signed heights +4.871242523 and −5.167973518 mm. |
| Coronary | Four actual cursor path nodes, four traced sections, indexed lesion and references; measured area-equivalent narrowing 50%. |
| Aortic/peripheral | Four path nodes, two neck lumen/wall/thrombus sections, explicit zero calcification, two left-access end sections; neck arclength 4.183 mm displayed, traced thrombus burden 0.548696830%, left-access sampled minimum Feret 2 mm. |

Pointer coordinates are quantized by browser screen transforms. Numerical checks use the retained physical annotations, not idealized intended pointer coordinates. The observed annular dimensions agree with the intended 6×4 mm ring within 10⁻⁵ mm/mm².

The native oblique PNG center pixel independently matched the source's analytic linear ramp: expected grayscale 40, observed RGBA (40,40,40,255). The calculation used the retained profile origin, raster bounds and known source intensity function, separately from the browser sampler.

A one-shot acknowledgement test allowed a real TAVR PUT to commit revision 2, then deliberately changed only the client-visible acknowledgement revision to 999. The App hid retained numbers, locked save and mode changes, and recovered the actual revision through explicit reload. Exactly one mutation was issued. No automatic retry or rollback was asserted.

Desktop and 430×932 portrait layouts were inspected. Portrait document width and scroll width were both 430 px; tables scroll inside their own container. The reload action remained enabled and readable, with foreground rgb(201,212,217) on rgb(21,30,36). The owned server listener and both task-created/recovered browser targets were closed and verified absent afterward.

## Automated verification

Clean-candidate results: **754 backend tests passed,108 optional tests skipped;129 numerical tests passed;21 imaging-geometry tests passed;307 frontend tests passed**. Base tests used Python3.12.13, numerical/geometry checks Python3.11.15, and the final frontend run Node24.22.2. Ruff, formatting, TypeScript/build, API/server Pyright and dependency audit passed with zero vulnerabilities. Geometry tests used a separate runtime populated from the numerical dependency lock; no trained-model run is claimed.

Clean-candidate checks and exact file hashes are recorded in `phase3-artifacts.json`. The publication candidate excludes local `plan.md` and all pre-existing unrelated work. Local mixed-checkout totals are not substituted for clean-candidate totals.

Targeted regressions cover nonround diameter consistency, aortic axis definitions, true oblique rigid-transform invariance, self-crossing polygons, tissue containment/overlap, unknown versus explicit-zero classes, actual all-mode HTTP persistence, simultaneous competing PUTs, changed read snapshots, stale-case suppression, bounded bodies/points, saved-row tampering, ambiguous postcommit storage errors, source admission, deferred old frontend responses, busy feedback and viewport-bound raster invalidation.

The backend independent review substantiated no defects in its bounded geometry/concurrency probes. It did not establish timing guarantees for all SQLite readers; the committed API concurrency tests are the reproducible acceptance evidence.

### Review repairs and retained policies

- Definitive HTTP 413/422 validation rejections retain the editable draft and explicitly report that nothing was stored. A real self-crossing trace produced422 with workflow revision0; correcting that same draft then stored revision1 through the real App/API.
- HTTP409 still locks mutation retries: the committed post-store acknowledgement-race test produces409 after two valid rows have committed. The suggestion that every409 is a non-commit was disproved rather than applied.
- Deleting the last tissue-region annotation returns the class to unknown and now explicitly explains that transition. Only the dedicated No-observed action declares zero. This rule is independent of prior UI history and works for both initially unknown and previously explicit-empty classes.
- Applied section and viewport objects are memoized. In the real native-volume browser, an unrelated landmark update retained the same existing image node with zero image mutations. Geometry/source/window/bounds invalidation remains covered separately.
- Removed the duplicate dirty-state reset. Moved Phase3 mode/dirty assertions into the dedicated native-source integration tracer rather than extending the already-long public-neuro test; no timeout was raised.

The repair candidate reran all 754 base and 307 frontend tests. The source lint excluded only locally provisioned third-party `.runtime` virtual environments; the CI backend has no such generated directories. The 129 numerical and 21 imaging-geometry tests were also rerun on the final clean candidate.

Contour picking stops at 128 vertices with an explicit limit notice. The guard test proves a successful 128th pick before rejecting the 129th and fails when the cap is removed. Invalid, duplicate, empty-path and degenerate-tangent profile stations now explain why no profile was added. The contour-bound error interpolates the shared limit.

Additional review refinements prevent a duplicate cursor append before it can clear profiles, share the 128-point contour bound between geometry and Pydantic, and preserve drafts for the independently proven pre-write 413 body rejection.

A proposed write-readback shortcut was intentionally declined after a real default-API measurement: an 8,030-point circular-profile input (31 lumen/wall pairs, 128 vertices per ring) performed **three** complete geometry computations, not five. Observed timings were 0.667347250 s pre-write, 0.659410333 s and 0.675560750 s for the two stored-row integrity reads; the whole PUT took 2.085107916 s and returned 200/revision 1. This is one near-point-cap input on the local machine, not a latency guarantee for all shapes. Fresh persisted-row verification and double-read coherence were retained rather than replaced with a no-recompute acknowledgement path.

## Delivery gate

Exact-head repository CI and the configured code-review app must pass, with actionable findings resolved, before merge. Verification artifacts identify source bytes; they do not imply external deployment or any change in data-use authority.
