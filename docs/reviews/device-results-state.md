# Materialized sizing-result state: parent reconciliation

Internal software bookkeeping evidence only. New repository, branch `feat/fresh-planning-workspace`; local/uncommitted. No real CTA sizing dimensions were invented and no clinical/device selection claim is established.

## Exercised layer

`planner/device_results_state.py` now persists immutable materialized result records in separate SQLite tables. A transaction compares the live case/image/source/mask/operator snapshot, latest materialized geometry result ID, validated input revision/hash, catalog data hash and calculation version before accepting a result. It does not bump case versions, alter masks, change geometry or overwrite input history. Current reads suppress result numbers after dependency changes and never search backward for an older matching result.

All result-store execution in this checkpoint used real TEMPORARY SQLite databases with explicitly synthetic metadata. It is not yet registered as the case-bound sizing calculation HTTP API and was not exercised against the live public-case database. The independent input API and real all-null input smoke remain separately documented.

## Incoming patch and parent repairs

The child's original 19 tests were independently rerun with input/geometry tests:62 passed. Parent then reproduced and corrected additional defects with RED/GREEN tests:
- Malformed catalog hashes, uppercase hash tokens and unsupported calculation versions were accepted for persistence. Dependencies now require exact lowercase 64-character data hashes and the supported calculation version; tokens are rejected, not normalized.
- Current reads could emit an unsupported stored schema or forged clinical-suitability flag. Reads now validate stored result schema, finite/capped JSON, false validation flags and case-bound marker again before returning a result.
- A list root produced AttributeError instead of the required ValueError. Root dependencies/results must be JSON objects.
- Result-declared catalog/calculation versions could contradict their dependency envelope. Version identity is now checked on persistence and current reads.
- The nominal rejected-preview test only created a preview. It now actually calls the ledger reject decision and verifies preservation.
- The temporary skip-if-missing-transaction-helper test was made mandatory after the parent implemented that helper. Missing infrastructure must fail, not silently skip.

The result store freezes caller objects before later use and returns the exact written result snapshot rather than fetching a postcommit latest row. Its role remains metadata coherence and stale-output suppression, not mathematical revalidation, catalog authenticity or clinical suitability. Trusted SQLite write authority and the future API's source/provider checks remain separate boundaries.

## Verification

- Final result-state focused suite: **27 passed**, 0.44s.
- Whole lightweight base suite, now INCLUDING the result-store tests: **489 passed, 96 skipped**, 3.70s.
- Targeted Ruff, formatting and git diff whitespace checks passed.
- No new opt-in model/imaging runs or frontend verification are claimed by this checkpoint.

The result-store child exceeded the requested tool-call cap (reported25 versus16), despite returning a compiled artifact. Its claim of no plan deviation was not accepted as an operational fact. The parent did not extend that run and reviewed the actual files/tests rather than treating the summary as clearance.

Remaining: independent input API review, operator input component integration, source-bound calculation/result HTTP composition and results UI, actual workflow invalidation, independent full-head localization and anatomical/clinical validation. A tested persistence layer is not a completed sizing product.
