# Calibrated-context review reconciliation

Read-only review `deleg_e3edde10` examined an earlier incoming snapshot, not the final parent repairs. It did not edit files or run source/model inference. Its conclusion is not clinical or whole-product clearance.

## Actionable findings

- **Output path is a regular file:** parent reproduced the `NotADirectoryError`, added an explicit directory guard, and observed RED/GREEN. Sentinel bytes remain unchanged.
- **Nonidentity NIfTI scaling:** parent reproduced effective slope/intercept cases `(2,0)`, `(1,100)`, `(0.5,-1024)`. These previously failed only through a generic dtype mismatch. The preparer now explicitly rejects nonidentity *proxy* scaling before materialization/output. It does not reset source headers, apply a second transform or silently convert physical values. The authorized DICOM-derived int32 source has identity NIfTI scaling and was actually rerun successfully.
- **Nonfinite crop and output symlink:** already fixed/tested before this review arrived. Earlier NaN input wrote a partial image and then failed readback; Inf could return successfully. The current selected crop rejects all nonfinite values before writing artifacts. A symlinked output target stays untouched.
- **Manifest readback:** parent reproduced a changed-on-disk manifest that the previous function would accept. The function now reloads the actual JSON and requires equality before success.
- **Hash syntax:** direct RED/GREEN tests now reject `0x` prefixes, Unicode digits and whitespace even when Python `int(...,16)` would parse them. Valid ASCII hex remains supported.
- **Tuple provenance:** now rejected as non-JSON input instead of silently converted to a list. Caller-supplied provenance remains separate from measured fields.
- **Manifest-only pre-existing output:** added the second sentinel variant; both image and manifest preservation tests pass.

## Geometry/tolerance scope

Source-size overflow, singular affine and actual serialized-affine binding were already repaired and tested by the parent. The reviewer confirmed the crop transform composition is correct. Its second original fixture was an axis permutation, not a general oblique angle; the parent added a true 37-degree oblique reflected/anisotropic test with forward-world and inverse-index checks.

The review's large-coordinate false-rejection argument is not adopted as stated: existing `np.allclose` calls also have a default relative tolerance, not just the listed absolute tolerance. Do not widen tolerances from that assertion. Generic large-origin-image support is not established by this case-specific operator layer. The independent authorized-case runner uses explicit absolute corner/index error bounds and binds the manifest to the actual saved matrix.

## Actual final-path exercise

Fresh `context-v3/` was generated after the review fixes under an independent 60-second deadline, without overwriting v1/v2. All 215600 source-crop voxels match; int32, mm/sec and actual saved affine are preserved; source compressed SHA is unchanged before/after; five nonpadding probes match; all corner-world and inverse-index errors are below `1e-5` in their respective units. The image and manifest hashes match v2, while the producing module hash is recorded separately.

Receipt: `artifacts/calibrated-source-discovery/context-preparation/parent-context-v3-readback.json`. Focused preparer suite: **29 passed**. Whole base suite: **262 passed, 94 skipped**. Full general ML runtime: **72 passed, 22 skipped**, with the existing two upstream TorchScript warnings. Whole-source lint/format and diff whitespace checks passed. Frontend is unchanged from published363e095 and its previously observed 38-test/build checkpoint; no frontend change is claimed here.

This closes the scoped preparation review, not source-registry/API/UI installation, clinical morphometry, device sizing or downstream invalidation. No STL frame/units/registration, anatomical accuracy or clinical validation claim is added.
