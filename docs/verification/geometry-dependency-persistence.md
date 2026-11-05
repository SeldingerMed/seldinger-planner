# Geometry dependency persistence checkpoint

Internal software evidence, not working product morphometry or clinical validation. `planner/geometry_state.py` now materializes numeric result JSON in its own SQLite table, separate from manual point-pairs. Synthetic tests first exposed stale numbers after dependency edits and a racing write, then passed after transactional snapshot comparison and fail-closed read suppression.

Proven with real SQLite fixture transactions:

- Save operator inputs, compute/store a synthetic3mm height, reload the same result without self-invalidation.
- Accepted mask replacement, operator-input edits, notes/case revision changes, source revision changes and image changes suppress the stored numeric result on reads.
- Rejecting a preview preserves existing materialized results; a case edit during calculation prevents persistence.
- Mismatched operator/mask image or source bindings and unknown units refuse a calculation snapshot.
- Unseeded single-slice SAM is not accepted as volumetric sac input. Seeded corrections must trace through immutable same-case/image/source ancestors to a trained three-dimensional aneurysm model. Accepting a lineage-valid synthetic SAM correction invalidates the prior numeric result.

Observed command: `uv run pytest tests/test_geometry_state.py tests/test_segmentation_state.py tests/test_sam_correction_server.py -q --basetemp artifacts/pytest-geometry-ledger-final --junitxml=artifacts/calibrated-source-integration/geometry-ledger-base.xml` →29 passed in0.51s. This includes15 new geometry-state checks and14 existing segmentation/correction checks. Focused Ruff/check-format and diff checks passed.

The numerical surface/section workers, route/runtime integration, frontend and actual public-case numeric computation are not established by these persistence tests. Device sizing is not called. Input/output caps, complete API validation and runtime integration still require their own executable checks before route exposure. Contract: `docs/plans/case-morphometry-contract.md`. The read-only reconnaissance's invalid coplanar tracer, surrogate sizing mappings, missing-ledger assertion and mutually orthogonal-plane interpretation were rejected rather than implemented.
