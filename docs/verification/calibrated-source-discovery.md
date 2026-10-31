# Calibrated CTA candidate: original-source verification

Internal acquisition receipt, not a completed series import, clinical validation or permission to relabel the existing CMHA source.

## Source and rights actually checked

- Original record: https://zenodo.org/records/15697196
- Version DOI: `10.5281/zenodo.15697196`.
- Original title: *Open dataset of annotated DICOM images of head CTA for intracranial aneurysm detection*, Blagosklonova et al.
- Parent retrieved both the original record page and JSON API. The API states `access_right: open` and license ID `cc-by-4.0`. The record describes 172 anonymized, defaced CTA series, 82 aneurysm cases and 90 controls, with expert annotations. These are source statements, not independently audited privacy or annotation-quality conclusions.
- Attribution and source citation must accompany later use. The record links data paper DOI `10.3390/data11040074`; the publisher page returned Access Denied during this pass, so no full-paper review is claimed.

The single `Dataset.zip` is 25578845008 bytes. Original archive checksum: `md5:264ff9ee868c022d108b7c7aa7396d32`, recorded from the API but **not independently verified** because the full archive was not downloaded.

## Bounded acquisition actually exercised

Parent verified HTTP 206 with exact `Content-Range` and downloaded only the 65557-byte tail, parsed ZIP64 metadata, then fetched the 11207225-byte central directory. Python's ZIP parser listed 149452 non-directory members. No 25.6 GB full download was attempted.

The directory lists:

- `Studies/006/`: 332 DICOM members, 47234315 compressed bytes and 52102268 uncompressed bytes, excluding local ZIP headers.
- `Annotations/an_006.stl`: 76853 compressed bytes, 1338841 uncompressed bytes. This annotation is listed but not acquired or spatially verified.

Thus one candidate series has an enumerated payload well below the proposed bulk-archive size. Its actual complete download remains separate work, with explicit transfer and decompression caps required.

## Actual geometry-header probes

Parent independently fetched exactly these original members by checked HTTP ranges, decoded bounded raw ZIP deflate streams, verified each declared uncompressed length and CRC32, saved the untouched public DICOM bytes under ignored `.runtime/`, then read only selected geometry/intensity tags with `pydicom==3.0.1`. Pixel data was not decoded, and identifying fields were not printed.

| Exact source member | PixelSpacing | ImagePositionPatient | ImageOrientationPatient |
|---|---|---|---|
| `Studies/006/0.dcm` | 0.48828101158142, 0.48828101158142 | -116.5, -135.6, -125.75 | 1,0,0,0,1,0 |
| `Studies/006/248.dcm` | same | -116.5, -135.6, 29.25 | same |
| `Studies/006/99.dcm` | same | -116.5, -135.6, -63.875 | same |

Each probe also reports 512 rows, 512 columns, CT modality, one frame, SliceThickness 1.25, SpacingBetweenSlices 0.625, RescaleSlope 1 and RescaleIntercept -1024. DICOM defines PixelSpacing and ImagePositionPatient in millimeters; these are actual nonzero geometry attributes, not inferred NIfTI units. The probe selection was lexicographic by member name, not physical slice order or numeric first/middle/last.

This is a credible calibrated-source candidate. It is not yet a verified complete volume: all slice positions, orientation, dimensions, pixel spacing, series consistency, gaps, duplicates, pixel decoding, rescale behavior and native-volume affine still need checking. SliceThickness must not be substituted for the actual position-derived interslice step. Annotation frame/registration and clinical measurement agreement are separate checks.

## Artifacts and limits

Ignored evidence: `artifacts/calibrated-source-discovery/{zenodo-record-15697196.json,zip-directory-location.json,zip-members.json,zip-member-summary.json,case-006-header-probes.json,probe_case_headers.py}`. Exact source-member SHA-256 values and geometry tags are recorded in the probe JSON. Raw probes remain under `.runtime/original-public-source/zenodo-15697196/case-006-header-probes/`; neither source DICOMs nor bulk indexes belong in git.

## Complete-case acquisition and parent verification

Subsequent acquisition fetched the case DICOM block and one STL by bounded HTTP ranges, not the full archive. Parent independently read all 333 saved members and checked their exact paths, lengths, SHA-256 values, central-directory CRC32 values, compressed sizes and original offsets against the earlier original-archive index.

Parent also re-read only selected header tags across all 332 DICOM files and independently verified every orientation component, dimensions, modality, frame count, pixel spacing and three-component position step. Result: one series/frame of reference; 331 steps exactly `(0,0,0.625)` mm; first position `(-116.5,-135.6,-125.75)` and last `(-116.5,-135.6,81.125)` in DICOM LPS. All files are 512 by 512 CT, single-frame, 16-bit signed, JPEG Lossless transfer syntax `1.2.840.10008.1.2.4.70`. RescaleSlope is 1, RescaleIntercept is -1024 and RescaleType explicitly states `HU` throughout.

The incoming header-QA script used `max(Boolean checks)` instead of `all`, so its orientation pass flag alone was invalid evidence. Parent's independent all-component check passed on the actual files. The incoming script read all pre-pixel headers despite the requested specific-tag-only scope; the parent verification uses specific tags and emits no instance/series identifiers. The acquisition helper checked Content-Range start/end but did not assert the total archive size, and its wall-time check was a between-reads check rather than an independent hard alarm. Actual successful range timings were reported as 17.7 and 1.4 seconds; do not treat that helper as a fully reviewed general-purpose downloader or claim every requested guard was implemented. The child used 14 calls versus the requested eight.

Canonical parent receipt: `artifacts/calibrated-source-discovery/complete-case-006/parent-verified-geometry.json`; executable verifier in the same directory is `parent_verify.py`. Complete raw source members are under `.runtime/original-public-source/zenodo-15697196/case-006-complete/`. Pixels remain undecoded, volume affine/roundtrip and STL registration remain unverified, and the full-archive MD5 remains unverified. These are still real gates despite the child's "no unresolved gates" summary.

The earlier CMHA AHMU1218001 image still has unspecified spatial units. This new source does not establish its calibration and must not unlock its measurement/sizing controls. No new case was installed in the application during this pass.
