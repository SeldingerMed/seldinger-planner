# Aneurysm planning worksheet slice

## Goal and evidence boundary

Add a lesion-centered, editable planning worksheet to the fresh viewer. The operator can mark a target location in the loaded image, record lesion location/rupture context, associate saved manual point pairs with planning measurement roles, select treatment options to discuss, and save questions. Muse reads this exact revision-bound worksheet and compares evidence gaps without inventing measurements, device compatibility or a treatment recommendation.

This does not turn point pairs into validated sac/neck morphometry or orthogonal vessel diameters. Original public-source acquisition and spatial-unit corroboration proceed independently. Unknown-unit volumes can store target coordinates in RAS source units, but cannot create millimeter measurement evidence. No legacy repository imports, clinical/partner data, weights, deployment or external publication of medical claims.

## Shared contract

`planner/planning.py` owns only domain validation/evidence derivation. `AneurysmPlan` is a Pydantic model with extra fields forbidden:

- `lesion_label`: nonblank 1..80 characters, default `Target aneurysm`.
- `location_note`: string max240, default empty.
- `focus_ras`: optional finite 3-vector in the case's source world units, default null. Do not label unknown-unit coordinates as millimeters.
- `rupture_status`: `unknown | unruptured | ruptured`, default unknown. This is operator-entered context, not an inferred diagnosis.
- `clinical_context`: max2000 characters, default empty.
- `measurement_links`: dict mapping zero or more of `sac_height | sac_width | neck_width | proximal_parent | distal_parent` to nonempty measurement IDs max80 characters, default empty.
- `options`: unique list of zero or more of `observation | coiling | assisted_coiling | flow_diversion | intrasaccular | clipping`, max6, default empty. These are discussion candidates, not endorsements.
- `questions`: max2000 characters, default empty.

`build_plan_evidence(plan: AneurysmPlan, measurements: list[dict], spatial_units: str) -> dict` verifies every linked ID is present in the supplied case measurements. Raise `ValueError` for absent/foreign links, duplicate use of the same measurement for different roles, or any link when units are not mm. Return `linked_measurements` list in the role order above, each with `role`, `measurement_id`, `distance_mm`, `method: manual_point_pair`, `validated_morphometry: false`; `missing_measurements` list of unfilled role IDs; `interpretation: User-assigned roles on manual point pairs, not validated morphometry or device sizing.` No clinical classification, aspect/dome-neck risk score, or device sizing inference.

## Parent integration ownership

- Parent owns `planner/workspace.py`, `planner/server.py`, all frontend files and integration tests.
- Add nullable `aneurysm_plan` JSON column with migration. Case GET returns `aneurysm_plan` (normalized fields or null) and `aneurysm_evidence` (derived or null).
- `PATCH /api/cases/{case_id}/aneurysm-plan`: `{artifact_version, plan}`. Validate scope/units, atomically CAS the revision and save the plan in the same transaction. Invalid =>422, missing=>404, stale=>409 with no write.
- Include actual plan/evidence in exported brief and server-bound Muse tool snapshot. Invalidate the displayed Muse answer after edits; disable Muse while worksheet changes are unsaved.
- A saved image-linked target can refocus the viewer. Reset unsaved plan/target/answers on volume replacement or failure. Reopening the same fingerprint restores the saved worksheet.
- UI explicitly labels operator context, discussion candidates and manual point-pair evidence. Prefer concise method labels over repeated warning paragraphs.

## Verification

TDD vertical slices: domain defaults/validation; atomic API save/restore; evidence ownership/unknown units; frontend edit/save/focus and unsaved gating; agent actual-snapshot and brief integration. Run existing suites, lint, typecheck/build and actual public CTA browser path plus a separate synthetic millimeter fixture for measurement links. No false claim of automatic lesion detection or completed clinical planning.
