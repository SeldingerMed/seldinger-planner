# Existing-mask SAM correction: parent technical evidence

Internal unpublished worktree slice after `c96c0a9`; not finished browser integration, clinical validation or a source-publication/merge receipt.

## Parent exercised paths

- Test-first API change binds optional opaque `base_candidate_id` to the current accepted aneurysm of the same case/image/reference. Caller never selects a blob path or expected hash. Native include/exclude polarity is strict integer 1/0. Wrong-model correction claims fail 422; preview/rejected/superseded/foreign-case/vessel bases fail 409 before inference; tampered blobs fail 503. These route fixtures are explicitly synthetic.
- Test-first worker change rechecks the fixed content-addressed blob, source identity, uint8 binary payload, native shape, exact affine and units. It passes the selected native row/column slice as SAM initialization, then copies the entire accepted 3D mask and replaces only that slice. A synthetic asymmetric-grid test proves orientation, deletion/addition and untouched-slice preservation.
- Parent actually ran the fixed subprocess SAM worker using accepted public-case trained mask `xgiMbCbHle1DyMt2y60GEw`, hash `68666d83675e9d2be4f2e13f1efe6fc4140269b48dee2f5940a85ccadf474dc0`. The technical seed was algorithmically selected from that mask at native `[87,91,69]`, not an independent clinical/operator annotation. Actual SAM used the prior; original selected-slice foreground 25 became 267, with 242 changed voxels. **This is not evidence of an improvement.** All other slices matched exactly. No candidate was accepted and case artifact 5 was unchanged.

Receipt: `artifacts/model-integration/sam-existing-mask-public-worker.json`; reproducible technical script alongside it. Original input is a reference-selected public context, with spatial units still unspecified. No millimeter measurement/sizing unlock is justified.

## Incoming helper reconciliation before its summary delivery

Parent observed the incoming helper had finished but its summary had not yet been delivered. Composed base collection failed because it introduced module-level NumPy into the deliberately ML-free prompt module. Parent wrote an isolated subprocess regression, observed RED, restored lazy imports, then observed GREEN. No NumPy was installed into the base runtime.

Parent also inspected the pinned original `sam2/utils/transforms.py`: `postprocess_masks` uses bilinear `align_corners=False`. The incoming custom NumPy interpolation aligned corners instead. A 5×9 asymmetric prior test reproduced the discrepancy, then passed after replacing manual interpolation with the installed Torch half-pixel operation. Binary-to-logit ±4 remains an explicit heuristic, not prior learned decoder logits. No full published SAM training/clinical equivalence is implied.

Observed composed checks at this point: **260 base tests passed, 62 opt-in tests skipped**; **14 selected ML tests passed**, including real synthetic SAM prior forwards and the synthetic worker-splice test. Two upstream TorchScript deprecation warnings remain. The standalone public-case worker completion is additional direct execution, not a synthetic response.

## Still required

Frontend correction controls and explicit accepted-base display; real API/browser preview→reject/accept→reload persistence; stale-base/race/geometry/sizing invalidation verification; final full suites and independent composed review. Existing-mask correction is not yet reported as a finished user workflow.
