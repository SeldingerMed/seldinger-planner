# Device source closeout: WEB construction and coil dimensions

Internal source record,2026-11-04. These are source facts, not validation of our geometric models or clinical planning. Parent verified the original-source text below after the bounded research helper returned. Images, proprietary CAD and manufacturer marketing claims were not imported into the application.

## WEB

The FDA SSED for P170032 describes two implant shapes, barrel and sphere, made from nitinol wires and nitinol wires with a platinum core in a braided self-expanding mesh. **SLS means single-layer sphere, not double-layer.** The app already distinguishes SL and SLS correctly.

Source: https://www.accessdata.fda.gov/cdrh_docs/pdf17/P170032B.pdf . The historical applicant was Sequent Medical. Current catalog attribution is separate from the historical PMA applicant.

Neither the reviewed FDA SSED nor retained IFU100044 Rev E establishes exact per-SKU wire counts. The app must keep those unknown rather than turn a secondary literature range into an exact device count. The W5/WEB17 and W4/WEB21 entries have different minimum catheter IDs even where nominal diameters overlap. Do not merge them by diameter alone.

## Stryker Target

The parent read the full original manufacturer brochure AP003690 v1.0, not just a search result:

https://www.stryker.com/content/dam/stryker/neurovascular/products/target-360-detachable-coils/resources/AP003690%20v1.0_Target%20family%20brochure_interactive.pdf

It lists Target10-size primary diameter0.010inch, Target XL0.014inch and Target XXL0.017inch. These family-level values do not identify a selected coil SKU. The brochure is international, with an explicit market-availability warning, so it is not by itself evidence of US availability for every size.

For appearance, Target360is described as an open-center shape seeking the outer wall with concentric filling. The first1.5loops are stated to be25%smaller than the nominal secondary diameter. This differentiates it from a generic stack of rings; the present generic packing preview does not yet reproduce that heat-set shape or deployment mechanics.

The parent separately read FDA K252694. It explicitly includes Target360Nano/Ultra/Soft/Standard, Target XL360Soft/Standard and Target XXL360. It describes stretch-resistant, electrolytically detachable platinum-tungsten coils and clears revised access labeling. It lists a family-wide secondary diameter range1–24mm and coil length1–50cm, not a complete per-SKU dimensional table.

Source: https://www.accessdata.fda.gov/cdrh_docs/pdf25/K252694.pdf . **Do not use K222533, a Target Tetra clearance, to silently assign a Target360SKU's primary diameter.**

## Medtronic Axium Prime

The parent first tried direct extraction of official US pages. They returned an “Incorrect Browser” page, not usable specifications. The shared Chrome browser then successfully loaded the official Frame page and the parent read the actual DOM tables:

https://www.medtronic.com/en-us/healthcare-professionals/products/neurological/neurovascular/detachable-coils/axium-prime-frame-coil.html

Source document marker: `US-NNP-2300061(v1.0):2025-04`; cited IFU `M046931CDOC2 Rev D`.

The characteristics table states primary coil ODs0.0115,0.0125,0.0135and0.0145inch against secondary diameter groups3–3.5,4–6,7–10and12–25mm. The currently expanded ordering table includes literal rows:

|Item|Secondary diameter|Implant length|Primary coil OD|
|---|---:|---:|---:|
|FC-3-6-3D|3mm|6cm|0.0115inch|
|FC-4-8-3D|4mm|8cm|0.0125inch|
|FC-6-25-3D|6mm|25cm|0.0125inch|

An anomalous source row is preserved literally: `FC-3.5-10-3D` displays implant length6cm, despite “10” in the identifier. Do not repair it from the identifier or select it without resolving the source conflict. The complete table was retained locally in ignored `artifacts/device-planning/axium-prime-frame-live-source.json`.

The helper's extra-soft0.0108inch finding remains snippet-level in this pass. Do not promote it into an automatically populated physical parameter without full primary-source verification.

## Contour

The helper found the actual corporate chain Cerus Endovascular/Stryker, not Cerenovus. Reviewed manufacturer pages are international; a US IDE study is not a marketing authorization. A bounded search that fails to find a PMA is not proof that none exists. Keep Contour outside the verified-US ordinary library until current exact US marketing status is affirmatively established. It remains an explicitly unverified-US research reference.

## Consequence for the current prototype

The accepted source closeout supports the existing SL/SLS distinction, unknown per-SKU WEB wire counts and conservative US/reference separation. It supplies better coil-dimension evidence, but a family range is not a selected-SKU parameter. The present coil model remains a generic, illustrative length-constrained preview. Complete per-SKU selection, source-bound primary-diameter population, recognizable heat-set shape reproduction and mechanics are separate remaining work; do not imply these are complete because source documents were read.
