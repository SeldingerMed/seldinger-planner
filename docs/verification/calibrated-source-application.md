# Actual calibrated-source application exercise and context diagnostic

Internal technical evidence, not clinical/accuracy validation. Source is explicitly approved public Zenodo 15697196 case006. Source DICOM mm/HU calibration is independent of the unvalidated STL placement used to select context. No original files or earlier prepared contexts were overwritten.

## Actual small-context app path

After restarting the verified task-owned backend, parent exercised the real browser at local5173:

- Open calibrated CTA → actual hash-verified 312177-byte source → new case `EYJ6bJs8-YfLixwEEbNGhA`, shape `[56,77,50]`, int32/mm, source image `88f6e5a67dee23439c864d9e32d771fdd24abee55b904b8260fe30e3ddcd40a3`, package revision `cb4f1ced10ae6b3b2e6d7cc9273c5f3f4fbc0478dba6a74588f083b3626c478f`. No curated mesh layer.
- Actual aneurysm model request→fixed isolated MPS/float32 worker→HTTP200 in4935ms, 244-voxel candidate `ra2hUgou73FqxFVOUNI0sA`, mask hash `84c530d57399df9be02e5cf125cfa6a8c662bfab757a1ded51e438090c0d2ada`. Independent saved native shape, exact affine, mm/sec and binary-uint8 readback verified. Candidate acceptance advanced the new case to v2 **only for technical lifecycle testing, not endorsement of anatomical correctness**.
- Actual screenshot initially revealed that the model overlay was not loaded despite a successful candidate. App still constructed `segmentationBinding` only from the old curated reference. Parent reproduced this with a failing component assertion, bound the viewer to the calibrated source too, then verified the actual 1348-byte mask fetch and red overlay in the browser. Green controls alone did not establish a rendered model result.
- Actual owned vessel request returned HTTP200 in10670.4ms but **zero foreground voxels**, candidate `0oE_EivW5WhB5WlYoaWfFw`. This is a negative model result, not successful anatomical segmentation. Parent rejected that preview through the browser and read back HTTP200 rejection. It was not accepted or used for sizing.
- Existing CMHA case `WzFtr9iVULfwb0B6HB2KGg` remained unknown-unit, version6. No retroactive calibration.

Browser request/error receipts and screenshots are under `artifacts/calibrated-source-integration/`. No browser errors/alerts observed during the recorded small-context path. Morphometry and sizing remain invalid/unimplemented; acceptance flags do not establish their validity.

## Bounded broader-context diagnostic

Empty output motivated a controlled context-size diagnostic, not changes to weights, voxel caps or memory limits. The same approved full source was cropped at native start `[170,148,100]`, size `[200,200,180]` =7200000voxels, preserving original int32 scalars/mm geometry. Preparation and full source hash checks succeeded; source image bytes10577722, image SHA `26b8a3e766cf1306796286c8d10dfef41192930919df9029f9be0779b8080473`, manifest SHA `92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e`.

- Real owned-vessel adapter: 22999 foreground voxels, native binary/affine/units readback verified, 91.24841841682792seconds, four CPU threads, independent165second deadline. No new weights/TTA; original-cohort preprocessing equivalence remains unresolved. Receipt `broader-context-vessel-probe.json`.
- Real retained aneurysm-head adapter: 6432 foreground voxels, native binary/affine/units readback verified, 4.807762457989156seconds, retained0.5MPS memory fraction, float32, independent60second deadline. Receipt `broader-context-aneurysm-probe.json`.

Both are **nonempty candidate outputs**, not evidence of accurate vessels/sac boundaries or clinical superiority. No registered annotation truth or performance evaluation exists here. This case/context has been used for development and must not be presented as a sealed evaluation case. Source selection remains reference-informed with unvalidated annotation registration.

## Actual broader-source application lifecycle

The distinct opaque ID `zenodo-case006-planning-context` is installed and selected by the App's calibrated-source control. The earlier small source remains pinned and served independently. Parent inspected and exercised `deleg_14b98c57`'s provider extension; composed provider/registry/worker tests exposed an order-dependent test monkeypatch, repaired by patching the actual module attributes rather than replacing only `sys.modules`. A component test first failed because the App still called the small-source default, then passed after explicit broader-source selection. Both actual API metadata payloads remain frontend conformance fixtures.

- Actual metadata and volume requests returned HTTP200; all10577722 served image bytes matched the pinned image SHA above. Browser created case `IkEMF5YWYSm7LeodOXBSbQ` at v1 with200x200x180 native geometry and mm spacing, without a curated mesh.
- Browser aneurysm request returned HTTP200 in4861.1ms: candidate `qs__LFVEgTI7jkTOYpYXwg`,6432 voxels, mask SHA `fdb824b2582b736af7e7b456f4e461427dfd3c02a388143218c3e1841f9ea4f4`.
- Browser owned-vessel request returned HTTP200 in86282.2ms: candidate `dycJyq9mxUTrB_C9G3PDKg`,22999 voxels, mask SHA `2a301b02171aaf3bb8b7508c480a6dd8111d612d93e6a192797ec0ef2c07cf99`. Both hashes exactly match their direct diagnostic masks. These are observed request durations, not a performance benchmark.
- Parent accepted both only for technical lifecycle testing. After a full browser reload and source reopen, the same case was v3 and both exact candidate IDs were current. Native mask API bytes, hashes, binary uint8 values, voxel counts, exact source affine, dimensions and mm/sec units were independently read back.
- Real initialized-mask SAM used that accepted aneurysm, produced preview `Iy2JMf-EFsFg9_O9tSYRng`, and was rejected through the browser. Independent blob comparison proved every unedited native slice identical; edited slice was90. Rejected-mask HTTP404, unchanged accepted vessel/aneurysm IDs and unchanged case v3 were verified. This does not establish 3D correction propagation or anatomical quality.
- The old CMHA case remained unknown-unit/v6. Recorded broader browser sessions had no errors. Receipts: `planning-{aneurysm,vessel}-preview.json`, `planning-models-{accepted,reopened}.json`, `planning-sam-{preview,rejected}.json`, and `planning-native-lifecycle-readback.json` under the artifact directory above, with corresponding screenshots and executable readback script.

Composed local verification:313 base tests passed with94 optional ML tests skipped; those94 unique ML tests then passed in their isolated runtimes (72 general,22 aneurysm). All51 frontend tests, TypeScript/build, Ruff/format, production dependency audit and diff checks passed. Two upstream TorchScript deprecation warnings and the existing Vite chunk-size warning remain. These follow-up changes are local at this checkpoint, not yet published or exact-head CI-verified.

Independent review `deleg_b56c8df6` of the earlier small-context integration is reconciled in `docs/reviews/calibrated-source-integration-final.md`. Its scoped no-blocker finding does not automatically clear the later broader-source changes. Parent confirmed that malformed worker JSON is already sanitized by the API and that the inference semaphore rejects a concurrent model request;63 reconciliation checks pass. Clinical morphometry, catalog/sizing and real downstream invalidation remain open.
