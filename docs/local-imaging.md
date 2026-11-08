# Local DICOM and native-volume studio

Run conversion from the repository root, in the environment approved for the selected data. The converter is a local operator command, not an upload endpoint or a model tool.

## Install the optional converter

```sh
uv venv --python 3.12 .runtime/ingest-runtime
uv pip sync --python .runtime/ingest-runtime/bin/python --require-hashes requirements/ingest.txt
```

Convert an explicitly selected flat directory containing one synthetic series:

```sh
env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
  -m planner.dicom_ingest /approved/synthetic-dicom .runtime/installed-sources \
  --source-id synthetic-series --scope synthetic
```

`--scope` must be `synthetic`, `public`, or `authorized`. It records the operator's declared scope; it grants no data-use permission. For clinical or partner material, establish the exact approved environment, approvals, rights, retention and privacy requirements before selecting or converting any files.

The destination must not exist. A successful conversion creates `SOURCE_ID/volume.nii` and `SOURCE_ID/manifest.json`. The complete staging bundle must pass the existing installed-source reader before publication; the manifest is published last as the atomic admission point. Open the resulting NIfTI with **Open volume**. Its bytes must match the server-installed source before the native studio is enabled.

## Supported input and bounds

- DICOM Part 10, native uncompressed Implicit VR Little Endian or Explicit VR Little Endian.
- Classic single-frame CT/MR series, or Enhanced CT, Enhanced MR and X-Ray 3D Angiographic Image Storage with explicit patient-coordinate plane position, plane orientation and pixel-measures functional groups.
- One coherent study, series, patient frame and acquisition state; uniform calibrated slice displacement and consistent native scalar encoding. Physical positions determine order, never filenames or instance numbers.
- MONOCHROME2, 8/16-bit integer scalar input. Linear rescale is baked into output values. Variable per-frame coefficients are identified as `per_frame_linear`, without misleading fixed coefficients.
- At most 512 input files, 16 MiB per file, 256 MiB total; dimensions at most 2048 per axis, 8 million output voxels and 16 MiB output image. No automatic cropping, truncation or downsampling.
- Reject symlinks and linked ancestry, projection XA/Enhanced XA, unsupported compression, duplicate/nonuniform spatial positions and malformed pixel lengths. A volumetric reconstruction is not inferred from `Modality=XA`.

Absent linear-rescale macros use identity scaling (1, 0). Slice-displacement consistency uses absolute and relative tolerances of `1e-4`; accepted residual jitter is represented by the mean slice step.

The output has a newly authored NIfTI header and whitelisted manifest, not copied DICOM tags. Patient text, source filenames/paths, raw instance/study/series UIDs, private tags and header extensions are not retained. Pixel content is not redacted or anonymized by this command.

## Confirm a path and registration

The native studio is available in either planning workspace for a verified millimeter source. Append physical RAS points from the linked viewer cursor or signed coordinate fields. Alternatively, copy a current saved coronary or aortic workflow path. Copies become independent drafts; they are not automatically confirmed or kept live-linked to later workflow edits.

Confirm and save the path before rendering. Scene revisions are independent of the main case revision. An ambiguous save locks further writes until **Reload saved scene**, including when the server committed without a usable acknowledgement.

- **Straightened CPR:** arc-length sampling with transported transverse frames.
- **Stretched CPR:** the same arc-length sampling using the initial fixed transverse direction. This is a ruled view, not a cross-sectional diameter definition.
- **Endoluminal flythrough:** first-person intensity-boundary raycasting with a threshold, physical station and roll. It is not a segmentation. A station outside the selected bright region suppresses this view without discarding valid CPR.
- **Registered cross-section:** select and load an installed secondary source, then explicitly confirm a proper rigid 4×4 secondary-RAS-to-primary-RAS matrix. Dimensions or modality do not establish registration. Missing secondary coverage preserves the primary sample.

Windows, span, roll, station and secondary opacity control the local rendering. Changed source, path, registration or display settings hide mismatched rasters before recomputation. Out-of-grid samples are unavailable, not synthesized.

## Export

**Export source-bound brief** reads `/api/cases/{case_id}/local-brief`, verifies the exact displayed scene ID/revision and source binding, and downloads Markdown locally. The server composes current scalar territory/geometry/sizing evidence from frozen provider snapshots. The browser appends the settings and diagnostics of its current native render.

The export includes hashes, result/scene revisions, method labels and known scalar values. It excludes pixels, raw contours/paths, transform arrays, raw DICOM identifiers and arbitrary provenance dictionaries. Non-current results remain explicitly unavailable. Model calls and external uploads are not part of conversion, native rendering or export.

## Tests

```sh
env -u PYTHONPATH -u PYTHONHOME SELDINGER_RUN_INGEST_TESTS=1 \
  .runtime/ingest-runtime/bin/python -m pytest -q tests/ingest_runtime
```

The optional test modules skip before importing imaging dependencies in the base API suite. `native-ingest.yml` exercises the locked conversion runtime separately. Final exact-candidate evidence is recorded in `docs/verification/phase4-local-imaging.md`.
