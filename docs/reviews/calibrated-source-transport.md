# Calibrated source transport: parent reconciliation

`deleg_a358715e` delivered only `web/src/calibratedSource.ts` and its transport tests, as scoped. Parent read both files and independently reran the original six tests and TypeScript check successfully.

Two claimed guards were incomplete in the actual code:

- The voxel cap used `8 * 1024 ** 2`, not the contracted 8000000. A 200×201×200 fixture was incorrectly accepted. Parent observed RED, corrected the exact cap, then GREEN.
- Affine validation checked finite values and the 3×3 determinant but omitted the homogeneous last row. Parent observed acceptance of `[0.1,0,0,1]`, added the row check, then GREEN. Nonfinite computed determinants also fail closed.

Parent also observed an oversized declared response being materialized before rejection. A Content-Length guard now rejects invalid/oversized declarations before arrayBuffer; the existing post-read body-size and SHA checks remain. This does not claim streaming memory enforcement for responses without Content-Length. The server-owned source has its own fixed file-size/hash guards; no arbitrary image URL is accepted.

Final focused tests: **9 passed**, including literal revision-newline rejection coverage. Whole frontend: **47 passed**; TypeScript/Vite build passed with the existing chunk-size warning. These are transport/component checks using explicitly synthetic bytes, not real NIfTI, real producer-shape conformance or browser/model integration.

The helper is not yet imported into App, so the successful build is not evidence that the new source is visible in the application. Pinned provider delivery/parent verification, actual producer payload conformance, App/SegmentationPanel wiring and real approved-source browser/model exercise remain open. No curated annotation, independent localization, validated anatomy, STL registration or clinical clearance is implied.
