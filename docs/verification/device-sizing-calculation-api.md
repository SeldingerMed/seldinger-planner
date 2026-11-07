# Case-bound sizing calculation HTTP tracer

Local technical prototype only. No current-SKU, device selection, clinical compatibility, anatomical validation or study-completion claim.

## Interface and scope

`GET /api/cases/{case_id}/device-sizing` returns coherent source/case/geometry, whole saved-input and materialized-result envelopes. `POST` at the same path computes only from the server's saved operator-input record. It does not accept dimensions, files, model choices or arbitrary source selectors. The request binds exactly `artifact_version`, `reference_revision`, `geometry_result_id`, `input_revision`, `inputs_sha256`, `catalog_version`, `calculation_version`. Strict strings and bounded identifiers/hashes; extra fields forbidden. Actual and declared request body capped at4096bytes, JSON required, query selectors rejected. CPU/SQLite work runs off the async request loop.

The calculation uses `calculate_reported_sizing`, then persists through DeviceResultsLedger's transaction-owned live-dependency check. This is historical arithmetic over explicit, unvalidated reports. Six missing/null independent dimensions remain missing; neither image-plane Feret widths nor extrema are substituted. A successful post-readback must return the exact newly stored result ID as current. If an input changes after commit,409 requires reload and old numbers are suppressed. A409 is not rollback: the dedicated regression proves one durable stale result and no repeated old-context insert. Other provider/SQLite/type/data execution failures return generic503 and no-store, never raw paths. No automatic retry is authorized by an ambiguous acknowledgement.

## Incoming reader reconciliation

The child supplied7 passing tests, independently rerun, but exceeded its14-call scope (reported25calls) and was truncated at its iteration cap. Its 'no gaps' claim was not accepted as proof. Parent RED/GREEN regressions reproduced and fixed:
- Projection from a mutable geometry alias could emit artifact_version999 around an earlier validated snapshot. Geometry/catalog are now encoded and independently parsed before validation and projection.
- Current input values with a different geometry capture could pass when no materialized result existed. They now fail409 before any values are returned.
- Input encoding errors escaped as500; encoding/parse now happens inside the sanitized provider boundary.
- A retained result alias could mutate a nested validated_sizing flag after validation. Result and input envelopes are independently parsed snapshots too.
- None, unknown status, malformed current, or stale-with-numbers store envelopes now fail closed503/no-store. No stale numeric projection.

GET final focused count17; POST final focused count21. These include real temporary SYNTHETIC SQLite, not real-case sizing targets. Positive synthetic POST -> persistence -> GET verifies minimum historical coverage14mm and approximate WEB7mm/4mm, from explicitly synthetic parent3/3.5mm, coverage8mm and independent sac6/5/6.5mm inputs. Source version changes and all client context pointers are checked; input replacement during arithmetic maps409 and stores no result. Protocol rejection and execution error sanitization are exercised. Catalog/geometry/input rereads establish a coherent observed snapshot, not a guarantee against future independent changes. A catalog change late in POST can leave a committed old-context result that is then suppressed by the authoritative reader; no rollback promise.

## Actual public-case execution

After verifying the old server's PID/parent/command/cwd, it was stopped and the new task-owned server started (`proc_e87a1fd6489a`, launcher37916; verify actual serving child before management). The first smoke tried a nonexistent `/geometry` metadata URL and stopped on404 BEFORE any POST. Repository route readback established the actual `/morphometry` path; the corrected smoke used that route without weakening any guards.

Actual public case `IkEMF5YWYSm7LeodOXBSbQ` v8:
- Six saved dimensions stayed NULL.
- POST returned200/no-store and materialized result `I2i2Nz4Lp7j2ocaNG_RP2Q`.
- Calculation status `partial_inputs`, six explicit gaps, no numeric sizing targets.
- Reopened exact report matched, while the complete case, morphometry and saved-input envelopes remained unchanged.
- Browser-origin proxy GET returned the same ID/partial report,200/no-store.

Receipts: ignored `artifacts/device-range-integration/device-sizing-live-calculation.json` and `device-sizing-browser-api-readback.json`. Pure presenter/controller and App integration are separate pending work. This is not a browser calculation-button claim yet.

Full lightweight backend528passed/96skipped; Ruff check/format and diff whitespace passed. Imaging/native-model checks retain their separate prior checkpoint; none were rerun or upgraded by these metadata/API tests. Local/uncommitted follow-up only, latest published source remains363e095. Independent reader review is pending; no new CI/deployment/publication claim.
