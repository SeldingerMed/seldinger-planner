# Native CTA application identity review

Internal engineering review of the uncommitted native-section slice over base61c1b59. This is not anatomical/clinical clearance. The sampler mathematical review is reconciled in `native-cta-sampler.md`; it found no reproducible blocker in its inspected contract and tests.

## Independent review and parent reconciliation

Read-only reviewer `deleg_3945adf3` inspected Viewer, App, MorphometryResults and ObliqueSection. No reproducible blocker was identified in the file/image/case/source/plane/window/currentness chain. Parent verified those four code files still match the exact hashes in `artifacts/native-oblique-sections/source-inventory.json`; no intervening production-code change is hidden by referring only to the old HEAD.

Parent evidence is separate from the reviewer's assertions:
- Real-App synthetic integration exercised wrong-File rejection and exact-File binding.
- Viewer lifecycle exercised exact File/NVImage notification and clearing after a failed replacement.
- Window-resampling failure test suppresses the old successful PNG and reports contour-only failure.
- Actual approved-public-case browser run rendered all three native sections; independently computed source intensities matched18sampled PNG pixels exactly, and window restoration reproduced all three original image URLs.
- Whole frontend159passed, typecheck/build passed. These are display/integration checks, not a guarantee against every interleaving or an anatomical validity study.

## Nonblocking observations retained

1. acceptFile has no internal busy reentrancy guard. UI controls already disable ordinary concurrent requests; a stronger programmatic duplicate-request lock is not required for this read-only display slice. No mismatched digest/File pair or visible wrong-plane image was reproduced. The review's atomic-pair argument is not promoted into a broader concurrent-upload guarantee.
2. ObliqueSection retains an old failure record after props change, but the exact volume/section/window key suppresses it. Do not add state churn merely to clear an invisible record; no false error/success caption was reproduced.
3. The sampler receives the range reconstructed from its stable window key. This is redundant parsing, not a correctness finding; actual preset lifecycle and failed resampling were exercised.

No production change was made solely in response to these nonblocking observations. Further concrete failures require a regression through the full parent guard chain, not a static claim that a key/remount or retained object bypasses it.
