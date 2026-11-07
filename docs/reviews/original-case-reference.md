# Original-case reference review reconciliation

Scope: independent read-only review of the uncommitted reference slice atop `ae927c8f9e25c2c4260a586c5cae2f99576c8a59`, followed by parent checks and narrowly scoped hardening. This is not clinical clearance or an exact-head automated review-app approval.

The reviewer reported no blockers within the research-preview scope and observed 26 source/API tests plus 10 reference/viewer tests passing before follow-up hardening. Parent broader checks were separate.

## Findings

1. **Claim of inward normals from an orientation-reversing transform: rejected.** The actual matrix is `diag(-1, -1, 1)`, whose determinant is +1, not -1. It is a proper rotation, not a reflection. Recomputing cross products from the transformed vertex order therefore preserves winding orientation. Parent computed the determinant with Python and checked the existing output-normal regression. Negating normals as suggested would introduce a defect. This does not independently establish that the publisher's original winding is outward.
2. **Non-finite scaling: hardened.** Added six parameterized rejection tests for NaN/+infinity/-infinity in source slope/intercept and six for installed manifest scaling. All 12 reproduced acceptance before the fix. The narrow preparer now rejects unsupported non-finite scaling before creating output; the reference store rejects it with 503. Valid original source scaling is unchanged. The review's proposed browser JSON failure was not reproduced: source_header is deliberately excluded from public metadata. The actual defect was acceptance of invalid/non-finite provenance fields, not that claimed browser path.
3. **Hash-validation/FileResponse reopening race: retained prototype limitation.** Files live in the fixed, local-controlled runtime directory and must not be concurrently replaced or edited. FileResponse reopens by path after verification. The browser independently checks the received bytes against the requested hashes before attaching them, so a changed response fails that client check. This does not provide server-side immutability against a local attacker and is not a multiuser/security deployment clearance. No such deployment is authorized.

Parent follow-up: focused source/API suite 38 passed; full backend suite 129 passed. Frontend remained unchanged by this scaling hardening, with its preceding 27-test pass, TypeScript/build/format checks and real public-asset browser verification recorded separately. Ruff checks/formatting and diff checks passed after follow-up. Test artifacts, screenshots and dataset files remain ignored.

## Delayed source review, subsequent hardening

A second review of an earlier preparer/API snapshot arrived after publication of `08059b7`. Its concrete parser/receipt/retry findings were reproduced and addressed individually with RED/GREEN tests:

- Reject fractional, non-finite and excessive payload offsets before output creation rather than truncating them with int().
- Record cropped_affine from the serialized float32 sform rows, matching actual output header bytes exactly.
- Recognize exact-length binary STL even when its arbitrary header starts with solid and contains facet.
- On failure, clean this attempt's fixed output names only, including a partial manifest. Fault-injected mesh and manifest failures now permit a corrected retry in the same initially empty output directory. This is not cleanup of pre-existing user files.
- Expose measurement_count, measurements_returned and measurements_truncated in the model snapshot and describe the 100-row cap in the tool. Zero-row and 101-row synthetic cases exercise that contract.

The review again conflated a coordinate sign transform with a voxel-array reversal. The transform is not an image-index flip; the CTA voxel order and source affine are not reversed. The comment is clarified accordingly. Candidate image consistency rests on the separately recorded, offset-corrected source investigation, not on the matrix alone. The fixed source's unknown-unit guard remains an intentional fail-closed constraint, not an instruction to rewrite source units.

Full backend checks after these changes: 139 passed. Frontend: 27 passed, TypeScript/build/format checks passed, production audit zero vulnerabilities. Actual original-source re-preparation took 8.169756500050426 seconds and retained identical image and STL hashes; only the corrected manifest affine/revision changed. Both new surface routes passed HTTP hash readback; an old-revision route returned 409. Independent read-only verification of the four-file hardening diff found no blockers within this scope and observed 39 focused tests passing. Parent broad checks and actual-source readback remain separate evidence. This is not clinical clearance or automated exact-head merge approval.
