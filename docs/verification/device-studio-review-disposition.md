# Device studio independent review disposition

Internal engineering/source review,2026-11-04. Review findings are hypotheses reconciled against the current implementation and primary sources, not blanket clinical clearance.

|Finding|Parent disposition|
|---|---|
|Scenario braid angle omitted|Fixed before the review arrived. An exercised RED/GREEN UI test restores the saved angle; comparison uses each placement's own angle. Model schema advanced to `procedural-device-v2`; old v1 records are rejected rather than assumed reproducible.|
|Bench/anatomy alternatives swap|Separate coordinate spaces are intentional. Sharing bench-origin placements with CTA RAS would be unsafe. The current code already binds bench examples to a loaded case's identity, disproving the claim that all case-bound bench keys are global. UI now explicitly distinguishes saved bench examples from anatomy alternatives and states they are not silently transferred.|
|Post-build mask identity not rechecked|Reproduced through the real route with an injected same-ID metadata replacement. It returned200before the fix. The post-build guard now checks mask hash and source revision as well as case artifact version and acceptance; the test returns409after the fix. Existing content-addressed ledger semantics do not currently expose an in-place mask update, but the defensive snapshot check is retained.|
|Native surface path not exercised|The parent had already run both actual public-case surfaces through the worker and independently checked returned STL vertices against native mask coordinates. Added optional synthetic tests for the exact native worker path, reflected anisotropic affine bounds, required declared-mm units and immutable byte decoding.|
|Native hash/load race|Reproduced: replacing the file after hashing changed the output despite the original expected hash. Fixed by capped single-read bytes, hash verification, bounded gzip decoding and `Nifti1Image.from_bytes` on that frozen buffer. The mutation test now passes.|
|Unspecified units might require loosening|Rejected. Unknown mask-header units must fail closed; a case-row mm claim cannot authorize relabeling unknown mask units. The synthetic negative test explicitly verifies this. The approved calibrated public masks passed with actual declared-mm headers.|
|Coil length can exceed geometric preview capacity|Retain explicit failure. Selecting either family initializes a6mmillustrative envelope, not the3mmuser-edited condition cited by the review. Reducing the envelope can legitimately make the requested length unrepresentable. Do not silently shorten a requested implant or force a green fit. Preview capacity is not an anatomical maximum packing estimate or clinical failure criterion.|
|Clip-plane arguments|Installed upstream NiiVue docs explicitly identify depth as normalized distance and azimuth/elevation in degrees. They give2.0as a no-plane example. The UI makes no millimeter claim for this display control. This is separate from the independently verified native surface RAS geometry and does not establish an anatomical registration validation.|
|Surpass Elite64versus40wires|Both source passages verified. Current US Stryker AP004884 v1.0says64wires; HAS/CNEDiMTS January2025French assessment says40. Keep the US-source-based display, disclose the unresolved jurisdiction/version conflict in a visible warning and qualify the caption as a cited-source statement, not independently measured construction. Do not copy the French size matrix into a US catalog.|
|Elite/other size lists incomplete|Every catalog entry now has visible size-coverage metadata; FD lists are explicitly captured subsets, not a complete size portfolio. Missing entries do not establish nonavailability. Source-listed dimensions and exploratory geometric controls remain distinct.|
|WEB supposedly36rather than37rows|Rejected after programmatic count:29SL plus8SLS equals37. Current app rows retain distinct W5/WEB17 versus W4/WEB21 catheter fields. FDA historical EV dimensions are not substituted for the retained current ordering-source rows.|
|Vantage027recall versus021correction|Review confirmed existing separation. Recalled027and unverified-US Contour remain outside ordinary choices.|
|Brittle identifier-based strand fallback|Removed. Every entry now supplies an explicit `displayWireCount`, separate from any verified/source-stated count. Changing an identifier no longer changes the weave. Unknown per-SKU construction remains labeled illustrative.|
|Unused roll field|Retained legacy draft-schema field has no UI control and no claimed effect. It is not a mechanical rotation or deployment parameter. A future pose implementation must version and test it rather than imply current functionality.|

## Source verification

- US manufacturer Elite: https://www.stryker.com/us/en/neurovascular/products/surpass-elite.html . Parent retrieved full text with “64 wire flow diversion with pure CoCr structural wires”.
- US manufacturer Evolve: https://www.stryker.com/us/en/neurovascular/products/surpass-evolve.html . Parent retrieved full text explicitly describing64wires.
- French assessment: https://www.has-sante.fr/upload/docs/evamed/CNEDIMTS-7676_SURPASS_ELITE_14%20janvier%202025_7676_avis.pdf . Parent retrieved the40-wire description and jurisdiction-specific matrix. The discrepancy was not resolved by pretending the sources describe one identical verified US configuration.
- WEB construction and coil source closeout: `docs/research/device-catalog-source-closeout.md`.

## Scientific scope retained

This disposition supports a nonclinical geometric research prototype only. It does not clear the software for patient care, establish anatomical validity, reproduce device contact/rollout mechanics, solve patient-specific CFD or predict angiographic obliteration. Those missing capabilities remain missing after the review.
