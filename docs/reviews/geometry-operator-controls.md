# Operator input review reconciliation

Scope: delayed read-only review `deleg_7550c4a8` of the incoming input component, compared with the newer parent code, actual Python producer behavior, controlled asynchronous tests and the real local CTA workflow. This is engineering review reconciliation, not clinical clearance or an exact-head review of the entire application.

## B1: normalized echo comparison

Confirmed independently and already repaired before review delivery. The parent observed Python re-normalizing the JavaScript oblique unit vector's final ulp, replaced exact normal JSON equality with an explicitly bounded `1e-12` per-component normal-only tolerance, retained exact coordinate/path/index matching, and waited for authoritative new-version props after save. The actual browser's oblique-plane save advanced the public case from v5 to v6, suppressed old numbers, and computed/reopened current results. Not every oblique vector must fail in the old implementation; one real producer counterexample is sufficient to establish the defect.

## B2: distinguish stale data from busy ownership

The review combines three different situations:

- Temporary `disabled` from the component's own busy callback is no longer a scope reset. It locks actions but keeps the same valid request identity. A valid completion must still be acknowledged.
- For committed case/source scope changes, the existing effect cleanup advances the request epoch. The parent's late-PUT regression confirmed no revision or error callback fires from the abandoned request. The review's claim that the described reset necessarily leaks `onRevision` despite that epoch check was not reproduced.
- A real ownership bug remained: `finally` looked up the newest `callbacksRef.current.onBusy`, so a request that acquired callback A could release callback B after a scope/callback change. The parent reproduced it, captured the original busy callback per request, and now balances that same owner's true/false pair. Stale numerical/revision callbacks remain discarded. Simply skipping every stale `finally` release would leave an outstanding busy state stranded.

Parent integration also reproduced a renderer failure resetting the shared workspace flag while a geometry request still ran. The app now maintains separate workspace and geometry busy states and disables actions using their aggregate. A controlled real-App test confirms source switching stays disabled until the outstanding geometry request finishes, even after the viewer reset unmounts its controls. This is a simulated renderer-failure regression, not an observed clinical/image failure.

## Other findings

- Unconfirmed PUT outcomes, including mismatched echoes and lost responses, now put controls into an error/reload-required state. The app uses its existing explicit saved-state reload path; it does not retry a possibly committed write or infer a successful revision from the malformed response. Two regressions observed failure before repair.
- Origin capture now explicitly tells the operator to recapture dome direction.
- Path clearing explicitly tells the operator to rebuild at least four points and reselect stations. Non-writing discard was already added and exercised before review delivery.
- The clamped-select issue was reachable during normal path growth at three points, contrary to the review's "currently unreachable" qualification. Station selectors now appear only when four points provide two interior positions and show the actual draft indices without `Math.min` substitution.
- StrictFloat integer-valued JSON behavior, saved-input structure and source identity comments are consistent with the inspected server. Those are schema facts, not anatomical validity.

## Verification

- 13 focused input-component tests passed; full frontend 73 tests in 18 files passed.
- TypeScript, production Vite build and git whitespace checks passed. Existing chunk-size warning retained.
- Final normal-path browser check used the actual calibrated CTA, saved v6 operator inputs and real fixed-runtime worker. POST returned 200/current, result `TB7cH69mFvVtkwKfO4_D3A`; source controls became enabled after completion; no observed browser errors or alerts.
- Browser receipt: `artifacts/calibrated-source-integration/geometry-busy-review-browser.json`.
- Initial verification automation attempted Compute after result hydration but before input hydration. No POST occurred. The resumed check waited for the actual enabled compute control and passed without repeating a mutation.

No outstanding blocker from this review remains in the exercised technical input-control scope. This does not establish clinical measurement accuracy, device suitability, oblique CTA reslicing, independent full-head localization, or review/CI clearance for the unpublished aggregate diff.
