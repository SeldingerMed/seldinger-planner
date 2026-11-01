# Native-mask results in the CTA workspace

Internal engineering verification. No clinical or anatomical validity claim.

## Exercised layer

The fresh planner now reads persisted case-bound geometry into the planning pane of the actual calibrated CTA workspace. It shows mask-derived sac height/width, operator-plane neck metrics, and two operator-path-normal parent sections. Each section has its actual contour projected into an orthonormal physical-plane basis with equal aspect. Section controls navigate the image crosshair to the corresponding world-space plane origin.

This result-only layer does not determine an anatomical neck or centerline, edit operator inputs, validate the segmentation, recommend treatment, or perform device sizing. The public-case inputs currently persisted on the exercised case are technical test landmarks, not expert annotations.

## Parent reconciliation of delegated component

The incoming three-file component passed its six original focused tests and TypeScript. Parent producer-shape tests exposed that a real stale record has `result: null` and no current-result dependency object. The incoming component labeled that shape Not computed instead of Stale. It now accepts the bound stale/not-computed producer variants without exposing historical numbers.

Parent also reproduced and fixed missing case-unit gating and overflow of an individually finite plane-normal vector's norm. Unsupported source units cause no result fetch or millimeter readout; nonfinite derived normal lengths fail closed. Effect cleanup invalidates outstanding requests, including transitions through disabled or unbound scope. The original synthetic stale fixture was replaced with the real producer shape.

`App.tsx` now passes the calibrated source binding and current case version to the result component and connects section focus to the viewer. Layout uses compact physical-plane diagrams and existing workspace colors. Planning navigation wraps instead of clipping after adding Geometry.

## Actual checks and local browser evidence

- Parent initial incoming checks: six component tests and TypeScript passed.
- Parent RED: three newly added component regressions failed before repair.
- Parent RED: application conformance test failed before App wiring.
- Parent GREEN: component and calibrated integration suites, 12 tests passed; TypeScript and production Vite build passed. Existing >500 kB chunk warning retained. Subsequent whole-base verification: 366 passed, 96 skipped; 20 native imaging checks passed separately. Ruff, format check, and git diff whitespace check passed.
- Verified and stopped task-owned server PID 42901, whose command was the planner environment's `python -m planner.server`. Restarted current backend using `uv run python -m planner.server`, tracked process `proc_d3b707939ee4`, launcher PID 72936.
- Actual live health and geometry endpoint returned HTTP 200. Case `IkEMF5YWYSm7LeodOXBSbQ`, artifact version `5`, current result `3A5cJfQFVcCveUCAImizsw`.
- Actual browser opened the pinned broader calibrated CTA. All observed source/case/segmentation/geometry metadata requests returned 200. Restored v5 geometry, three finite SVG paths, and no observed browser errors.
- Clicking Go to neck section moved the displayed RAS crosshair to `-14.4 / 11.6 / -11.1`, matching the persisted world origin `[-14.359309673309326, 11.5766282081604, -11.141874999999999]` at the viewer's one-decimal display precision.

Receipts: `artifacts/calibrated-source-integration/geometry-results-browser.json` and `geometry-results-browser.png`. They record the actual public-case response and screenshot, not a mocked browser run. Source image bytes were not embedded in the JSON receipt.

## Remaining scope

Operator input capture/save/compute controls are a separate component under implementation. Device catalog integration, dependent device-result invalidation, independent full-head aneurysm localization/evaluation, anatomical measurement/reference evaluation, and clinical suitability are not established by this layer. Current follow-up source/geometry changes remain local and unpublished; the earlier published commit is not evidence of CI for these changes.
