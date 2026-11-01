# Actual SAM acceptance to geometry/sizing lifecycle

Internal public-case technical integration proof, not boundary-quality improvement, clinical validity or a completed anatomical study. This supersedes the 'actual SAM-to-sizing unexercised' limit at the preceding UI checkpoint; that checkpoint remains a historical record.

## Original trained model, actual native mask

On approved Zenodo case006 planning CTA, case `IkEMF5YWYSm7LeodOXBSbQ` v8, the real browser clicked **Refine accepted aneurysm** with Include point at the existing crosshair. The request used accepted SAM mask `kcFqkVPc0OurCgfL4eHWHg` as its base, source revision92834342c650ecae3733cac33aec096f01ff699c4f25c234fdb0b8738ae6f18e and the actual CTA's image hash. No synthetic model response or new checkpoint was substituted.

Real local SAM2.1 tiny proposal returned200, candidate `grDHSlKdxScYwtvY2YzN1w`, retained model SHA7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69, initialized-mask provenance and native point compliance. Raw model quality0.9543734788894653 is NOT a probability or anatomical quality score. The observed point RAS[-15.091732025146484,14.75045394897461,-7.3125] maps to nearest native[100,100,90].

Before acceptance, an independent existing imaging-runtime readback downloaded only the approved case's two mask blobs from the local API, verified both compressed SHA hashes, binary native200x200x180 shape and exact affine. Changed slices were exactly[90], all179other slices identical, prompt sample1. The source image and other cases were untouched. This proves one-slice/native-copy behavior, not better anatomy.

## Actual complete browser/API chain

1. Browser **Accept candidate** advanced this case v8 -> v9, accepted the new correction and retained vessel `dycJyq9mxUTrB_C9G3PDKg`.
2. GET and visible UI reported stale geometry with result:null, stale operator-input binding and stale sizing with result:null. Earlier real geometry metrics were suppressed; the real sizing result had been partial with no numeric targets.
3. Browser **Compute mask geometry** invoked the actual fixed native worker using retained operator plane/path. Geometry became current at v9; source physical frame was unchanged. No new anatomical-validity claim.
4. The operator editor reconfirmed the original technical provenance with all SIX scalar fields still blank/null, producing new revision `nj_ZAKVrnXqwsh60vWZceg`. No proxy values from sac/neck/parent extrema were copied.
5. Browser **Calculate saved inputs** persisted current partial result `5ZfTMOOICZnZ60QuOTyJ0w` bound to current geometry `AO_E1txbmLBk0InJ7ZMiwQ` and the new input revision. There are still six missing independent dimensions, no real sizing targets or selected device.
6. Fresh app/CTA reopen showed the exact saved result, casev9/empty notes, no visible alerts; guarded session recorded no JS errors. Real CTA/mask overlays are visible in the screenshot.

## Receipts

Ignored artifacts/device-range-integration:
- device-sizing-sam-preview.json
- device-sizing-sam-native-check.json
- device-sizing-sam-accepted-invalidation.json
- device-sizing-sam-recomputed.json
- device-sizing-sam-reopened.json/png

The first metadata inspector looked for a nonexistent `inputs` key in morphometry and stopped BEFORE a model/write action. Repository/API readback established actual `operator_inputs`; this was corrected without synthesizing data. All state transitions above were subsequently observed.

Prior latest backend530pass/96skip and frontend144pass/build remain software checkpoints, not new model-study results. Native slice artifact readback above is a distinct actual-model proof. Independent full-head localization, clinical/anatomical reference evaluation, current catalog completion/clinical compatibility and externally cleared demo publication remain open. No new paid cloud job, external clinical-data transfer or publication occurred.
