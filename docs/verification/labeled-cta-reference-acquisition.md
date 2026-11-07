# Public labeled CTA acquisition and reference-cohort audit

Internal evidence, not a detection study, anatomical validation or device selection.

## Primary source and rights

Blagosklonova et al., *Open dataset of annotated DICOM images of head CTA for intracranial aneurysm detection*, https://zenodo.org/records/15697196, DOI 10.5281/zenodo.15697196. Landing page retrieved during this execution states CC-BY-4.0, full DICOM anonymization, face removal, expert manual aneurysm isolation followed by threshold-based STL segmentation, and measurements curated by a neurosurgeon and neuroradiologist. These are publisher statements, not an independent deidentification or anatomical-accuracy certification.

The source provides DICOM and STL annotations, **not established native NIfTI voxel masks**. Coordinate-frame and registration checks remain necessary before rasterized meshes can serve as spatial references. Whole-archive MD5 was not verified by partial acquisition.

## Actual metadata acquisition and code execution

Only Metadata.csv was retrieved from exact ZIP ranges. The successful acquisition transferred 3,534 bytes and recovered the 16,458-byte original member after exact local-header name, compressed/uncompressed size, bounded decompression and CRC32 checks. An earlier UTF-8 decoding attempt failed after successful network acquisition; the published CSV is CP1251 with semicolon separators and decimal commas. That failed attempt is not included in the successful receipt's transfer count.

- Metadata SHA-256: `407cd3c35307b491d714c5a7c05a0a9e26ef92faa54d43259a704516bf2bc7f4`.
- Original unchanged: `.runtime/original-public-source/zenodo-15697196/reference-metadata/Metadata.csv`.
- Acquisition receipt: `artifacts/labeled-cta-reference/metadata-acquisition.json`.
- Normalizer: `planner/reference_cohort.py`, with synthetic-source tests only in git.
- Actual derived audit: `artifacts/labeled-cta-reference/cohort.json`.

The normalizer preserves source IDs and lesion tokens; groups multiple aneurysms without counting them as additional patients; parses decimal commas and explicit missing values; excludes demographic/history fields; rejects malformed rows, contradictory negatives, incomplete/duplicate lesion groups, mismatched series counts and missing exact STL members. It does not populate the application's device inputs.

Actual reconciled counts:

| Item | Observed |
| --- | ---: |
| CSV rows excluding header | 212 |
| Unique CTA cases | 172 |
| Aneurysm-positive cases | 82 |
| Aneurysm-free cases | 90 |
| Aneurysm annotations | 122 |
| Exact corresponding STL members found in archive index | 122 |
| Aneurysms with a published neck measurement | 31 |

All published nonmissing image counts agreed with the indexed per-case DICOM counts. Missing repeated-row image counts remain missing source values, not fabricated values; the case-level known count is retained separately.

Reproduce:

```sh
uv run python -m planner.reference_cohort \
  --metadata .runtime/original-public-source/zenodo-15697196/reference-metadata/Metadata.csv \
  --zip-index artifacts/calibrated-source-discovery/zip-members.json \
  --expected-metadata-sha256 407cd3c35307b491d714c5a7c05a0a9e26ef92faa54d43259a704516bf2bc7f4 \
  --output artifacts/labeled-cta-reference/cohort.json
```

## Actual new reference-case acquisition and calibration

Case013 was selected as a **development/reference candidate**, not as a held-out study subject or a treatment recommendation. Its source record describes a saccular bifurcation aneurysm and reports neck 3.2 mm, length 5.3 mm, width 5.2 mm and volume 110.92 mm³. These source column definitions do not supply six current device-sizing inputs and have not been independently adjudicated.

- Acquired exactly 289 DICOM members and `Annotations/an_013.stl`, with per-member size/CRC/hash checks and all saved member hash readbacks.
- Successful bounded transfer: 49,665,427 bytes, under a 64 MiB executed cap and 150-second wall cap.
- Raw assets: `.runtime/original-public-source/zenodo-15697196/case-013-complete/`.
- Receipt: `artifacts/labeled-cta-reference/case-013-acquisition.json`.
- Actual installed SimpleITK/GDCM decoder completed the series; no package installation. Initial pydicom import failed before data processing, and geometry-tag reading was repaired using installed SimpleITK without installing dependencies.
- Checked all slices for orientation/pixel-spacing consistency, positional slice-step consistency and finite native HU. Independently assembled RAS affine from DICOM tags and compared it with the decoder geometry.
- Prepared full volume: `[512,512,289]`, spacing `[0.578125,0.578125,0.625]` mm, HU range `[-3024,3071]`, slopes1/intercepts-1024.
- Saved/reopened NIfTI has mm units and declared qform/sform. Nonpadding native HU samples and DICOM-to-saved world positions agreed on three separated slices; maximum sampled serialization-position error approximately `6.96e-6` mm.
- File: `.runtime/original-public-source/zenodo-15697196/prepared-case-013/cta-mm.nii.gz`, 85,459,853 bytes.
- SHA-256: `56f0e39bb93d31559a62636faa46ab47fd56ae3c1a09515ecf4194073904a5db`.
- Calibration receipt: `artifacts/labeled-cta-reference/case-013-calibration.json`.

This full volume exceeds the application's existing selected-context transport cap. It was **not** silently registered as a live application source, cropped using its expert annotation for a detection claim, or substituted into the existing case ledger. All six real-case sizing fields remain untouched.

## Material finding about the old example

Current application case006 is labeled nonsaccular, type `fusiform-saccular`, with no published neck measurement; published length21.8 mm and width9.5 mm. That is a reason not to manufacture a saccular neck reference from its existing operator plane. Its source classification is not an independent diagnosis by this software.

## Detection and independence boundaries

The exact original model README at upstream revision `1ead0ba4dc00bcd84591269995dde6a8446ca3ad` describes a trained stage1 tri-axial 2D vascular-ROI extractor and a stage2 224-cubed multitask model. Integrating/testing that original localization stage is a concrete alternative to immediately training a new localizer.

Source: https://raw.githubusercontent.com/PengchengShi1220/RSNA2025_Intracranial-Aneurysm-Detection/1ead0ba4dc00bcd84591269995dde6a8446ca3ad/README.md

The README distinguishes Apache-2.0 model/code rights from **CC-BY-NC-4.0, research-only corrected segmentation labels** and states those corrected labels have not been clinically reviewed. Those labels were not downloaded or adopted for this commercial prototype. It lists RSNA/TopCoW/TopBrain training-label sources but does not by itself establish that Zenodo15697196 or CMHA are absent from all training inputs. This acquired cohort is overlap-unknown development/reference data, not proven independent validation.

## Verification at this checkpoint

- New focused synthetic parser/binding tests: **23 passed**.
- Full lightweight suite: **553 passed, 96 skipped**.
- Ruff check, whole-repo Ruff format check and git diff whitespace check passed.
- No frontend/model performance, STL alignment, measurement accuracy, current-device catalog completion or clinical-validity result follows from these checks.
- No database mutation, publication, partner transfer, outreach, spend, installation or raw-data commit occurred in this slice.
