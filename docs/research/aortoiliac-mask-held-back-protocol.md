# Aorta and iliac centerlines from an existing vessel outline

Protocol `aortoiliac-mask-held-back-v1`. Freeze before opening the unseen cases. The input is an existing outline, not a raw CT. No weights, alignment on X-rays, or clinical decisions are being evaluated here.

## Two questions, two cohorts

1. **TotalSegmentator v2:** does a single binary outline yield the aorta and the correct left and right iliac centerlines? Use the union of the three provided artery labels as input; retain their identities only for scoring. Use all 57 validation and 89 test cases once, without sampling. All 1,082 train cases were for development.
2. **AVT:** on a mask that includes other branches, how often does the model produce a split, and do the two returned lines separate near it? Use all 28 even-numbered subjects across the three collections once. The 28 odd-numbered subjects were for development. AVT has no separately named iliac labels: neither left/right ordering nor agreement with the separation height proves that the model chose the anatomical bifurcation. Do not pool these numbers with TotalSegmentator.

## Frozen scoring and conduct

Use the centerline code from `783a5b3308fb44501098c601553d9ea3f9879add`, and both scorers at this protocol's commit. No tuning from either unseen set. Run `aortoiliac_eval.py` on `ts-aortoiliac` and `aortoiliac_single_mask.py` on `avt-aortoiliac`, each with `--set held_back` only. Preserve both the complete records and failures. One attempt per cohort; a partial or aborted run is recorded, never overwritten or resumed as a fresh measurement.

- TotalSegmentator primary: among cases with both iliac labels contacting the aorta and all three spans at least 60 mm, report correct names/sides and splits within 10 mm, both over **every eligible case**, including failures to return a split. The reference split is the midpoint of the two labeled contacts. Report median and worst 3D distance separately among cases with a returned split. Also give the aorta-only count for scans without either iliac label, and count partial, missing-aorta and unreadable cases separately. Refusals in an eligible group count against success. Report unexpected processing errors separately and invalidate an affected measurement rather than treating software errors as anatomical refusals.
- AVT: count refusals, aorta alone, proposed splits, endpoint ordering and splits within 10 mm vertically of mask separation, with both the proposed-split denominator and total case count. Report missing separation and the greatest absolute difference. This is a consistency check. Use the corrected global slab origin for the separation calculation. Do not choose cases for the headline based on their appearance.
- Report descriptive results regardless of performance; this test alone does not decide whether to ship the raw-CT workflow. Keep the operator confirmation requirement.

## Development comparison and input identity

The completed TotalSegmentator development run at `783a5b3`: 366/398 full cases named correctly, 362/398 within 10 mm; 431/432 aorta-only cases returned the aorta alone. The AVT development run returned splits in 23/28. Its old separation statistic is superseded: recompute the odd-numbered group with the corrected scorer before its even-numbered comparison, without changing the engine. Never use the mixed-code TotalSegmentator run.

| Prepared input | set.json SHA-256 | labels.zip SHA-256 |
| --- | --- | --- |
| TotalSegmentator | `0dfc222e127403cd965597920e7c042015edb65a60939c9b587c8bbc09cc6b8c` | `4b95cff44e9bf5ca5dd2e0ebe6988e7b3fa744cf58714e11536a0d475bf5cca9` |
| AVT | `0d8de3bdf6b33942729e5c438a82ee43fc52b7f5093db51037ab11a9d31ecf8b` | `db6e257ed32ad87e1495b3e99cf1818df9415403c5cdb9730540b2f9e8760249` |

Launch under shared compute admission, from a clean detached checkout of this commit. Require the verified external volume, at least 40 GiB free, matching prepared-input hashes and absent output directories. Retain results, diagnostic images, temporary files and logs on that drive. Check the subject IDs against their manifest group, per-case code digests against the frozen files, actual row counts and refusals before reporting. Publish only aggregates in the repository.
