# Geometry backend review reconciliation

Internal software review, not clinical clearance. `deleg_3ee9c083` inspected contracts plus geometry state/worker/server, calculation identity and selected-section code. It did not inspect mask extraction, original geometry internals, server registration or tests, and supplied no exact-byte revision attestation. Its scoped no-blocker assessment must not be generalized to those omissions or later changes.

## Reconciled findings

- Revision-read fallback: already reproduced and removed before review delivery. Explicit conformance coverage prevents silently retrying without a source revision; read failures return sanitized503.
- Parent degeneracy: existing geometry core rejects zero normals, now confirmed through a native-mask worker test with coincident tangent neighbors. Parent additionally reproduced a distinct-index/same-position case that silently returned duplicate sections, then added a physical-position distinctness guard with1e-9mm equality tolerance.
- Path support: requiring every explicit path sample in vessel foreground and one6-connected component is intentional fail-closed policy, not permission to invent centerline support across segmentation gaps. The contract is clarified and a background-sample rejection test passes. An operator path remains unvalidated as an anatomical centerline.
- Exception surface: actual `MorphometryError` subclasses ValueError and is covered by the current sanitized runner boundary. The fixed supervisor normalizes subprocess failures. No catch-all was added merely for hypothetical injected programmer exceptions; gate release remains in finally. More targeted invalid-landmark feedback remains a UX follow-up.
- Rounding: nearest native index with Python ties-to-even remains explicit. Background seed and out-of-grid points fail closed, not by snapping automatically to a different structure.
- Cap correction: the job cap is16KiB; the result cap is1MiB, not16KiB. Upstream marching-cubes face allocation precedes the post-extraction triangle cap. Durable result-history bounding remains a separate follow-up, not cleared by the review.

## Additional parent finding: GET coherence

The review's no-stale-result conclusion missed an envelope race. Parent forced an update/recompute between the outer case read and `ledger.current`: the API returned artifact_version4 outside while serving a current numeric result bound to artifact_version5 inside. A failing HTTP test reproduced this exact mismatch.

GET now reads operator inputs before a final case/source recheck, returns409 if identity changed during the read, and separately requires current numeric dependencies to match the response case/image/source/version. The response is coherent at its checked read point; this is not a claim that another client cannot mutate state after the response.

Observed focused verification:

```sh
uv run pytest tests/test_geometry_server.py tests/test_geometry_state.py tests/test_geometry_runtime.py -q --basetemp artifacts/pytest-geometry-review-green
SELDINGER_RUN_MODEL_TESTS=1 PYTHONPATH="$PWD" .runtime/ml-runtime/bin/python -m pytest tests/ml_runtime/test_geometry_worker.py tests/ml_runtime/test_mask_geometry.py -q --basetemp artifacts/pytest-geometry-review-ml-green
```

40 base checks passed in0.57s;20 isolated imaging checks passed in0.14s. Focused format, Ruff and diff checks passed. No real image/model inference was repeated for this review. Actual public-mask computation/SAM invalidation evidence remains in the separate backend checkpoint. Browser geometry integration, device sizing and clinical validity remain unfinished.
