# Broader approved context source extension

Own ONLY `planner/image_source.py` and `tests/test_image_source.py`; parent owns registry/API/worker/frontend. <=4min small extension, vertical RED/GREEN. No models, pixels, .env, installs, network or commits. Existing calibrated-v3 source must remain byte/behavior compatible. Do not update any false clinical/source-preparation flags.

Actual new artifact was independently prepared and both real adapters exercised by parent after the tight56x77x50 source produced zero vessel voxels. Broader source is still reference-informed, not independent localization or validated annotation. It produced nonempty masks, NOT an accuracy/performance validation. New native200x200x180 =7200000voxels, int32/mm. Existing caps unchanged. Primary full source hash98ecbcedc625ff1eecdf3a90366a05ec0bc38fd6c4172facbc8bb5bb7d86e9b4.

Add constants:
`PLANNING_SOURCE_ID = "zenodo-case006-planning-context"`
`PLANNING_ROOT = <samecaseparent>/context-planning-v1`
`PLANNING_IMAGE_SHA256 = "26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473"`
`PLANNING_MANIFEST_SHA256 = "92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e"`

Add `PlanningSourceStore(CalibratedSourceStore)` exposing the same trusted constructor signature `(root=None,*,expected_manifest_sha256=PLANNING_MANIFEST_SHA256,expected_image_sha256=PLANNING_IMAGE_SHA256)`. Defaults pinned to planning-root and hashes. Instance `.source_id` is PLANNING_SOURCE_ID. Metadata identical key shape/False flags/no meshes; case_label "Zenodo case 006 planning context", source_id planning-ID, image_url `/api/image-sources/zenodo-case006-planning-context/volume`. Source URL/license/method/selection_basis unchanged. Adjust parent metadata to use trusted instance source_id/label so both store variants produce correct identity, never infer variant from request or data. Base defaultCalibratedSourceStore still emits old metadata/paths/pins exactly. No API changes.

TDD tests before code: planning class defaultloadsactualhashcheckednewartifact (readsmallmanifest/hashrawfilebytes only, no arrays); metadata correctnewid/root URL anddistinct hashes; old defaultclass remains oldID/oldroot88f/cb4. Do not require raw source installed in genericCI: skip only actual-source file tests if absent, keep synthetic tests running. Add a synthetic PlanningSourceStoreDI test using existing tiny fixture trusted hashes so newclass is covered onCI. Run focusedtests/Ruff+format beforefinish. Returnexactoutput andunfinishedissues.
