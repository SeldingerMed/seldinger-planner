# Calibrated-source integration review reconciliation

Internal technical review, not clinical clearance. Review `deleg_b56c8df6` inspected the earlier small-context source integration. It reported no blockers. It did not supply an exact commit/file-hash attestation, and its two-source worker discussion predates the separate broader planning source. It must not be represented as a full review of subsequent changes.

## Inspected scope and parent reconciliation

The reviewer read the provider, registry, worker, transport and segmentation panel, targeted App source/load/accept wiring, and checked curated manifest shape. Its reported inspection list did not include a full server/segmentation-server inspection. Parent independently inspected the current registry, worker source selection, segmentation routes, panel reset/epoch behavior and source-selection tests.

1. **Legacy curated trust asymmetry: retained nonblocking limitation.** The worker hashes its fixed installed curated manifest as a revision rather than checking a separate manifest pin; calibrated providers pin both manifest and image. The legacy manifest remains trusted installed configuration, not a request-selected path. Preserve this distinction; no new trust/registration claim follows from calibrated-source support.
2. **Malformed worker JSON: API leak claim not reproduced.** `json.JSONDecodeError` is a `ValueError`; `create_segmentation` already catches `ValueError` around the runner and returns the generic HTTP503 inference failure. A new conformance parameter explicitly raises a JSON decode error containing a staging-path sentinel and verifies sanitization, empty current masks and no installed blob. No production change was needed. Direct `run_local_model` utility callers can still receive the original exception type rather than a normalized `RuntimeError`.
3. **Acceptance overlay flicker: retained UX follow-up.** Revision-dependent reset briefly clears/refetches the overlay after acceptance. Persistence/binding remain correct; the actual broader browser accept/reload path restored the exact accepted IDs and masks. Do not remove revision invalidation merely to eliminate flicker.
4. **Reset while an older POST is pending: bounded concurrency nuance.** Epoch guards discard old results. The current server additionally uses a process-wide nonblocking inference semaphore and rejects a second inference with HTTP429, verified by the existing busy-limit test. Two pending HTTP requests are possible; two model executions are not authorized concurrently by this server process. This does not establish cross-process admission control.

Parent reconciliation command:

```sh
uv run pytest tests/test_segmentation_server.py tests/test_source_registry.py tests/test_planning_source_registry.py tests/test_worker_sources.py tests/test_sam_correction_server.py -q --basetemp artifacts/pytest-calibrated-review-reconciliation
uv run ruff check .
git diff --check
```

Observed:63 passed in0.95s; lint and diff checks passed. No pixels/models were rerun for this review reconciliation. Later broader-source actual model/lifecycle evidence is recorded separately in `docs/verification/calibrated-source-application.md`; it is not retroactive expansion of the child review scope. Clinical measurement validity, independent localization/accuracy evaluation, device sizing and real dependent invalidation remain open.
