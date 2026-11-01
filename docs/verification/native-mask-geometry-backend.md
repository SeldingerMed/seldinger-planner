# Native-mask geometry backend checkpoint

Internal software evidence. This is not validated clinical sac/neck morphometry, an anatomical neck annotation, an extracted/validated vessel centerline, or device suitability. Only the explicitly approved public Zenodo case006 source and its accepted model masks were used. No unregistered STL was consumed.

## Incoming helper reconciliation

Parent independently exercised the surface/selected-section helpers. Additional observed RED→GREEN repairs reject nonhomogeneous4x4 affine rows, apply the8M-voxel cap before scalar scans, and reject an operator origin on an inner contour boundary even when an outer loop contains it. Surface extraction remains native marching cubes0.5 with full affine, no smoothing/decimation, a100000-foreground cap and50000-triangle cap before Python-list conversion. Triangle allocation inside upstream scikit-image precedes that last cap. Clipped sac point deduplication is at1e-9 world-unit precision, not mathematical exact equality. Base-runtime optional test collection was repaired rather than installing imaging dependencies in the base environment.

The helpers preserve numerical/evidence distinctions: mesh clipping includes plane intersections and equatorial points; planar contour selection requires a unique closed loop containing the explicit origin; parent planes are perpendicular to local operator-path tangents, not necessarily to each other. No maximum-width/average-diameter or neck-width/longitudinal-coverage substitution is made. No sizing engine is called.

## Exercised fixed-runtime path

`planner/geometry_worker.py` verifies the pinned source revision/image hash, actual source header units/grid, both content-addressed mask hashes, exact native affine/shape/units, uint8/binary/scaling and operator-input hash before computation. The source is selected from a fixed registered source ID; the blob directory is trusted server configuration, not a client field. The supervisor uses the fixed isolated Python runtime, shellFalse, four numeric threads, a60s timeout and bounded JSON input/output. Its calculation identity is in a web/imaging-independent contract module.

The actual public-mask exercise used **development-selected technical landmarks**, automatically constructed only for this verification script. They are NOT an anatomical neck or clinically located proximal/distal path. The first configuration placed parent stations within the aneurysm mask; its preliminary result is preserved in `technical-geometry-initial-overlapping-stations-{job,result,provenance}.json`. A test-first guard now refuses that configuration in the actual subprocess. Stations sampling the accepted aneurysm mask cannot be presented as parent caliber. This guard does not establish anatomical correctness of other stations.

A separately recorded technical configuration with stations outside accepted aneurysm foreground completed through the fixed worker in0.6455200421623886s. Direct output is `technical-geometry-direct-result.json`; inputs and their deliberately non-anatomical generation are `technical-geometry-job.json`, `technical-geometry-landmark-provenance.json` and `prepare_technical_geometry_job.py`. These are observed execution durations, not benchmarks or accuracy evidence.

## Actual ASGI API, persistence and SAM invalidation

HTTP-layer delivery was incomplete at parent inspection: its requested test file was absent and lint failed. Parent wrote tests reproducing a missing default-worker blob-directory argument (HTTP503), invalid station indices escaping as server exceptions, and overflow from a very large finite normal. Those observed failures were fixed; request validation now rejects invalid indices and normalizes finite nonzero normals safely. The HTTP layer selects source/mask identities server-side and shares the process-local inference gate.

Executed `uv run python artifacts/calibrated-source-integration/geometry_actual_api_invalidation.py` against the actual workspace SQLite database using FastAPI's ASGI test transport and **the real default subprocess runners**, not synthetic geometry/mask outputs:

1. Saved technical operator inputs on public case `IkEMF5YWYSm7LeodOXBSbQ`, advancing to v4.
2. Computed native-mask estimates, persisted a current numeric result and read back the same result ID.
3. Ran initialized-mask SAM with the current accepted aneurysm and accepted the correction only for technical lifecycle testing, advancing to v5. The accepted vessel was unchanged.
4. GET geometry returned `status='stale'`, `result=null`: previously materialized numeric outputs were suppressed, not merely tagged by a validity flag.
5. Recomputed from the newly accepted correction through the actual worker. HTTP200 returned a new current result whose dependencies contain the new SAM candidate.
6. Original CMHA case remained unknown-unit/v6.

Receipt: `geometry-actual-api-sam-invalidation.json`. This exercises the backend through real ASGI routes, native mask files, subprocess runtime and SQLite. It is NOT a browser geometry interaction or a loopback-network deployment test. Existing planning controls in the browser do not yet expose this geometry workflow.

## Local verification and remaining work

Latest composed base run:353 passed,96 skipped. Focused isolated imaging tests:17 passed. Ruff and diff checks passed. The previous94 model checks are separate prior checkpoints; do not silently add them to these runs without deduplicating fresh reports. Original geometry helpers remain unchanged.

Pending: broader API negative/race/resource coverage and independent review, bounded result history, complete frontend landmark/plane/contour/result interaction and actual browser reload/invalidation, source-versioned device catalog/range checks with genuine measurement inputs, and exact-head publication/CI. Clinical measurement/segmentation accuracy and independent full-head localization remain unestablished. Local code is not yet pushed at this checkpoint.
