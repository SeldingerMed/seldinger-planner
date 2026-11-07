# Aneurysm worksheet verification

## Implemented scope

The new local application now persists an operator-entered aneurysm worksheet alongside the image fingerprint, notes and manual point pairs. It stores a source-space RAS target, location/context, explicit rupture-status uncertainty, user-assigned measurement roles, selected discussion candidates, and questions. It does not detect an aneurysm, validate morphometry, select or size a device, or recommend treatment.

## Exercised paths

- Domain defaults, finite target coordinates, field bounds, strict role/option enums, and duplicate-option rejection.
- Real SQLite plan save and reopening after application recreation.
- Atomic artifact-version compare-and-swap. Stale writes do not overwrite the saved plan.
- Evidence links must use distinct measurements from the same case. A foreign case's measurement is refused without changing the revision.
- Unknown-unit images may save a target/context without numerical measurement links. They cannot create millimeter evidence. No calibration override was added.
- Exported Markdown includes the actual worksheet, target-unit label, selected candidates, questions and the manual-evidence method boundary.
- UI edits disable Muse until the worksheet is saved. Volume replacement resets the draft/consent and clears prior model output.

## Actual public-image browser flow

The installed public-source CTA crop was opened in the attached browser. An explicitly operator-marked, unconfirmed ROI and questions were saved at revision 3; no patient history, rupture status, diagnosis or anatomical measurements were invented. The saved target, context, options and notes returned after reopening the same fingerprint. No synthetic evidence appeared in the public case after switching images.

A real Muse/Baseten request read both `read_case_plan` and `read_planning_sources`. Its response retained the unknown spatial calibration and rupture status and treated coiling/flow diversion as discussion candidates rather than suitable treatments. It displayed the actual two-source receipt. This is evidence that the tool path ran, not clinical validation of the response.

A browser regression was found and reproduced in a failing lifecycle test: programmatic refocus moved the rendered crosshair but left the coordinate readout, and thus the next endpoint selection, at the old location. Refocus now explicitly reports the physical-affine round-trip coordinate. The actual browser was rechecked after moving away from the target; the footer returned to the saved target coordinates.

## Separate analytic fixture

An explicitly synthetic, millimeter-declared NIfTI fixture was reopened with its saved manual point pair. The UI linked that same-case measurement to a user-assigned `neck_width` role and saved it. The API returned the original distance with `method: manual_point_pair` and `validated_morphometry: false`. The fixture does not represent a neck or any anatomy. The real CTA was restored afterward; its empty, disabled measurement links and separate saved plan were preserved.

## Source-discussion contract

`planner/planning_sources.py` is a small fixed bundle, not an arbitrary-URL tool, live search, device IFU or exhaustive/latest guideline review:

- ESO 2022 unruptured aneurysm guideline, recommendation table PICO 1/2: https://pmc.ncbi.nlm.nih.gov/articles/PMC9446328/ ; DOI `10.1177/23969873221099736`.
- NICE NG228, published 23 November 2022, recommendations 1.2.4 and 1.2.7 for ruptured aneurysmal subarachnoid haemorrhage: https://www.nice.org.uk/guidance/ng228/chapter/Recommendations .

The primary content was read back during implementation. Clinical populations must not be assumed from an unknown rupture-status field. The server refuses selected-option output if the model skipped the source tool. A guard-mutation check in an isolated temporary package demonstrated that removing this check makes the negative test fail, with the uncited response wrongly accepted as HTTP 200. The live package was not mutated.

## Review reconciliation and remaining limits

The delegated domain component initially indexed `id` rather than the producer's actual `measurement_id`, and rejected all unknown-unit plans rather than only numerical evidence links. Both issues were reproduced and corrected with focused regression tests before integration.

A subsequent independent read-only review found no blocking regression in revision ownership, draft isolation, unknown-unit handling, source provenance, escaping, or manual-evidence labeling. Its two actionable low-severity findings were reconciled: rejected links now use neutral prerequisite wording rather than claiming a calibrated case, and HTTP 409 locks writes/Muse until an explicit saved-state reload. The reload checks case/image identity, discards local drafts only after the user chooses the labeled action, resets model-transfer consent, and clears prior output. The evidence pre-check remains in the transaction.

New frontend regressions exercise a different-fingerprint volume replacement and the conflict → explicit reload → save-with-new-revision path. The actual attached browser independently reproduced a server-side revision change, observed blocked writes and the retained local draft, reloaded the saved plan with consent cleared, and persisted a subsequent save at revision 4. This used a separate metadata workspace for the public crop, made no model call, and restored the prior browser case mapping. The browser also exposed the recovery action below the viewport; the alert now appears above the canvas, and a real bounds check confirmed the action is visible. These checks validate application behavior, not the image's calibration or clinical interpretation.

Exact original-member identity and millimeter calibration of the existing crop remain uncorroborated. The recorded dataset citation is not a verified per-member lineage. Original-source CTA/STL acquisition is independent work; no mesh, voxel mask, trained inference or SAM correction is claimed here. Any future quantitative aneurysm analysis must retain source, method, coordinate frame, calibration and validation provenance.

Private local receipts/screenshots are under ignored `artifacts/aneurysm-worksheet/`. No images, model weights, credentials, databases or screenshot artifacts are added to git.
