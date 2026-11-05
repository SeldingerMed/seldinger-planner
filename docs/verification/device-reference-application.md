# Device-reference application verification

Internal engineering evidence, not clinical validation or a completed sizing study. New application repository: `seldinger-planner`, branch `feat/fresh-planning-workspace`. This calibrated geometry/device follow-up remains local, uncommitted, relative to published head `363e0956e4e8c17b294dddd933d6c17be862b9fe`; no new exact-head CI claim.

## Exercised behavior

The application now renders a source/case-bound **Devices** panel on the actual public Zenodo case 006 planning CTA. It shows two operator-path-normal mask-section Feret intervals, arithmetic comparisons with the historical 2–5 mm interval, source revisions/links, 11 collapsible historical Pipeline rows, and four explicitly missing independent sizing dimensions. Historical internal identifiers are not manufacturer SKUs. WEB catalog rows remain unavailable. It does not select a device or produce a sizing target.

The browser opened the calibrated CTA, expanded the actual table and counted 11 body rows. No JavaScript errors were recorded. Displayed parent intervals were 3.453–5.151 mm and 3.453–5.057 mm, each outside the historical interval. These comparisons are not clinical rejection, eligibility or sizing-diameter selection. Existing green overlays remain trained/edited technical masks, not anatomical reference truth.

Actual UI lifecycle:
1. Public case `IkEMF5YWYSm7LeodOXBSbQ` v6 had current geometry and a `partial_inputs` device report.
2. Editing notes immediately hid loaded case numbers before save.
3. A real PATCH notes write advanced the case to v7. GET geometry/device reports became stale, with no case numbers displayed.
4. Original empty notes were restored with another actual PATCH, advancing to v8. The metadata change remained conservatively invalidating.
5. Clicking the observed **Compute mask geometry** control ran the real geometry worker. POST returned 200; the device panel refetched and restored partial comparisons at v8.
6. Independent direct HTTP reads verified original notes restored, case/device version 8, geometry result `nT6RqCsbkOZ9SG5-o38ETg`, and matching geometry/device result identity.

Catalog data/rule SHA-256: `c697cac424e72db7f60edc90e7c2a5c3547802fa89022cc1890527b48a8d21bf`. This is a canonical data coherence token, not a PDF checksum or source-authenticity proof.

Receipts under ignored `artifacts/device-range-integration/`:
- `device-ui-baseline.json`, `device-ui-baseline.png`
- `device-ui-stale.json`
- `device-ui-recomputed.json`, `device-ui-recomputed.png`
- `device-ui-independent-readback.json`

An initial automation probe used an incorrect button label, `Compute geometry`. Inspection found the real **Compute mask geometry** control enabled; the corrected probe succeeded. No application repair was required for that probe failure.

## Incoming-patch review and parent repairs

The delivered component's five tests and TypeScript check passed independently, but they did not establish all required invalidation states. Parent RED/GREEN regressions reproduced loaded numbers remaining visible after disabled/unknown-unit transitions, requests against mismatched case/image bindings, and incomplete producer validation. Repairs:
- Derive renderable data from current eligibility, scope and error state, not merely retained loaded data. Clear retained data when becoming ineligible.
- Refuse mismatched case/image bindings without issuing metadata requests.
- Require known geometry/device calculation versions, matching catalog versions, exactly two parent roles, complete missing-dimension metadata, false validation flags and the actual partial/stale producer shapes.
- Validate historical catalog version format/basis and FDA HTTPS source links; reject bogus WEB availability.
- Replace the original ambiguous late-response test with an actual deferred old-case response after switching to a second valid case scope.
- Integrate into App dirty/busy/source locks and key by geometry recompute epoch so same-version recomputation refreshes the report.

Read-only backend review found no blocker in its inspected scope and correctly limited catalog hashes to coherence rather than authenticity. Parent independently reproduced its shared-alias concern: mutation and reversion during projection could evade the second-read comparison while influencing projected numbers. Projection now parses the exact frozen JSON token into an independent object; a real HTTP regression verifies output against the frozen snapshot. Catalog validation now also rejects malformed WEB intervals and all nonpositive/bool margin rules even when a caller recomputes their data hash.

Provider evidence-integrity errors remain sanitized 503 responses, per the explicit route contract; known case/source races remain 409. This is not a client-provided measurement endpoint. The review suggestion to convert all provider integrity failures to 4xx was not adopted. Cross-consistency between section area and equivalent diameter is not newly validated by this display/range layer. Snapshot consistency does not prevent subsequent changes by another client.

## Observed checks

- Full base pytest: **404 passed, 96 skipped**, 2.72 seconds.
- Focused device core/HTTP: **38 passed**, 0.17 seconds.
- Full frontend: **88 passed**, 19 files.
- TypeScript, production Vite build, Prettier, Ruff check/format and git diff whitespace check passed. Existing large-bundle warnings remain; no false warning-free-build claim.
- Opt-in model/imaging suites were not rerun by this device-only checkpoint. Earlier model and geometry evidence remains separately scoped.

## Still unfinished

The current interface is the historical catalog/range layer, not full sizing. Independent operator-reported parent sizing diameters and longitudinal/sac sizing dimensions, durable sizing-input/result persistence, full sizing calculations, broader compatibility requirements and that workflow's complete invalidation remain separate work. Do not populate missing real-case dimensions with synthetic values. Independent full-head aneurysm localization, anatomical measurement/reference evaluation, current complete catalogs and clinical validity remain unestablished. This verification does not authorize publication, external demo distribution or clinical use.
