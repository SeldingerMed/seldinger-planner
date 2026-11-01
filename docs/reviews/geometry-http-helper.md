# Geometry HTTP helper reconciliation

`deleg_f4ad5bf7` ended at its iteration cap with a partial, unverified HTTP patch. Its delayed report is historical, not evidence that the current working tree is untested. Parent inspection confirmed the requested test file was absent and Ruff failed. The report's environment-blocker explanation was not a genuine prerequisite: pure-stdlib analytic geometry runners and FastAPI tests run with the existing base `uv` runtime; imaging tests and the real worker use the separate imaging runtime. No dependency installation was needed.

Parent already completed and exercised the API before the delayed report arrived. Observed test-first repairs covered missing default-worker `blob_dir`, invalid station indices escaping as server errors, and overflow from a very large finite normal. Actual public-mask computation, persistence, SAM-induced numeric invalidation and recomputation are recorded in `docs/verification/native-mask-geometry-backend.md` and the actual API receipt. Those real runs were not repeated for this reconciliation.

The report's allegedly safe `_saved_inputs` compatibility fallback was not revision-safe: a TypeError from revision-aware reading silently retried an unbound read. Parent reproduced that behavior with a failing test, removed the fallback, and now returns a sanitized HTTP503 without exposing old-frame coordinates. The new build does not require this speculative backward compatibility.

Additional CI-safe conformance tests confirm forbidden client source/path/hash fields are rejected before the runner, nonfinite/clinical-claim/oversized/missing/unknown-unit results are not persisted, the shared busy gate returns429 without running work, and a case edit during calculation prevents persistence. Synthetic fixture masks/runners remain explicitly labeled and are not model evidence.

Observed reconciliation command:

```sh
uv run pytest tests/test_geometry_server.py tests/test_geometry_state.py tests/test_geometry_runtime.py -q --basetemp artifacts/pytest-geometry-http-reconciliation-green
```

Result:39 passed in0.67s; focused formatting, whole-repo Ruff and diff checks passed. Current helpers do not establish a production-grade API or clinical measurement validity. Independent code review and further persistence/resource/race checks remain separate. The read-only result component is delegated as a small GET/render tracer, not the full operator-editing workflow.
