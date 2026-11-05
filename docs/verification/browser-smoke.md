# Browser verification: first planning-workspace slice

Application code under test: `6fcd9206558b5e31caf3ac925420196c2a3bcf72`.

This is a local functional and rendering smoke check. It is not an imaging-accuracy study, validated device-sizing workflow, or completed clinical planning product. Evidence screenshots and JSON receipts are local ignored artifacts under `artifacts/browser-smoke/`; no image assets are added to git.

## Real public CTA

Source: Song et al., CMHA (2024), CC BY 4.0, DOI `10.6084/m9.figshare.26965450.v1`. The existing public demo crop preserves source intensities. The frontend loads it into the browser, not into a model prompt.

The attached browser at a 1440 × 1000 viewport exercised:

- Real volume load and connection to the corresponding persisted case.
- All five distinct layouts: linked, axial, coronal, sagittal, and 3D.
- Crosshair selection updating the physical-RAS coordinate readout.
- CTA/bone display-preset changes.
- 3D camera motion. Canvas-region before/after pixel differences were nonzero; changes were not limited to toolbar labels. A raw CDP input helper timed out once; the page remained responsive, and canvas mouse-event interaction completed the motion check.
- Saving case notes, reloading the page, and reopening the same image. The saved notes and revision were restored and the model-data confirmation checkbox reset.
- Exporting the case brief, HTTP 200, containing the exact persisted notes.
- A live Muse/Baseten tool call reading the saved public-case metadata and notes at revision 2. The response distinguished notes from measured facts, reported zero measurements and unknown units, and did not infer anatomy or recommend a device.

Captured `window.error` and unhandled-rejection observers recorded no errors during the exercised interactions after initial loading. The observed case-write requests contained small JSON note/agent payloads, not image bytes.

The actual source header leaves spatial units unspecified. The UI labels coordinates as source units and disables millimeter measurements for this case. Rendering and plausible CTA spacing do not constitute corroborated calibration.

## Separate synthetic measurement conformance check

An explicitly named analytic NIfTI fixture, not replacement demo anatomy, exercised the real file-open, point-selection, and measurement-save UI:

- Grid: 16 × 16 × 16; declared spatial units: millimeters.
- Known sform: diagonal scales 2, 3, 4 with translation −15, −25, 5.
- The UI enabled measurement controls, selected two points, and saved one RAS measurement at revision 2.
- Stored endpoints: `[7.215686798095703, 6.50391960144043, 35]` and `[-2.8235292434692383, -1.025491714477539, 35]`.
- Stored distance: `12.549019622802748` mm, matching the independently recomputed Euclidean distance within `1e-8` mm.
- The public CTA was reopened afterward. Its saved notes returned, and the synthetic measurement did not appear in the public case.

This checks the UI/persistence path and declared-unit behavior. Oblique/sheared coordinate conventions have separate automated conformance tests. None of these checks validates orthogonal vessel diameters, aneurysm morphology, device sizing, or treatment selection.

## Remaining product and evidence work

- Corroborate real-case spatial units from source provenance before enabling calibrated measurements.
- Add actual segmentation/correction, lesion-focused morphometry, device evidence, and treatment-option comparison with provenance and explicit limitations.
- Keep image-derived/model-derived output distinct from curated annotations and clinician edits.
- Review the exact current revision and pass required CI before merge. Browser consent is not merge approval or authorization to publish a clinical claim.
