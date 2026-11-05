# Initial workspace review reconciliation

Scope: the fresh local workspace introduced in PR #1. This records source/test review and the subsequent local browser functional smoke, not clinical validation.

## Atomic revisions

The initial in-process lock did not protect independent server processes. The write now compares the exact string revision inside one conditional SQL UPDATE. `test_atomic_revision.py` reproduces an interleaving between separate SQLite connections: the old implementation accepted both writes and reached revision 3; the corrected implementation does not. This fix is in the initial workspace commit.

## Coordinate convention: do not apply an unconditional x flip

The review's proposed RAS-to-LAS inference from `isRadiologicalConvention` was not supported by the upstream implementation. The official [NIfTI FAQ, Q14 and Q15](https://nifti.nimh.nih.gov/nifti-1/documentation/faq) distinguishes voxel storage orientation, real-world coordinates, and display convention. Radiological/neurological display does not itself change world coordinates.

Inspected installed `@niivue/niivue` version 0.68.2:

- `src/niivue/index.ts:10362` emits location callback `mm` using `frac2mm(crosshair, 0, true)`.
- `src/niivue/index.ts:10930-10995` delegates physical/fractional coordinate conversions without consulting the radiological display flag.
- `src/nvimage/CoordinateTransform.ts:114-120` uses the physical `frac2mm` matrix when the force flag is true and `frac2mmOrtho` otherwise.
- `src/nvimage/CoordinateTransform.ts:135-159` similarly selects the appropriate inverse.

Executable tests load analytic, in-memory NIfTI-1 volumes using the real NiiVue/NVImage package, not a mocked transform. They check a reflected LAS voxel ordering against expected RAS world coordinates, both radiological display settings, and an oblique affine round trip. An unconditional x flip is therefore not applied.

A real adapter inconsistency was found: the initial crosshair and evidence-focus paths used default conversion flags, unlike NiiVue's callback. They now explicitly select the same physical-affine transform. Adapter regression tests fail without that change. Missing qform/sform orientation declarations are rejected; spatial units remain a separate check.

## Display preset preservation

The asynchronous load no longer replaces the selected display range with 0..600. It reads the latest display preset through a ref, avoiding volume reload on every preset change. A lifecycle regression test covers loading under the bone preset, then changing the preset without reloading.

## Failed-load recovery

The app clears image identity, digest, case state, endpoints, coordinates, confirmation and old model output after a volume error. The file chooser is reset to allow retrying the same file. WebGL initialization failure is reported once with a distinct message rather than being overwritten by a generic NIfTI error. Cleanup accesses the nullable underlying GL context instead of the getter that throws when initialization failed. Synthetic lifecycle tests exercise these paths.

## Browser verification and remaining gates

- Real-image browser smoke is now exercised: the actual public CMHA crop renders in all five layouts, with crosshair/preset changes and 3D camera motion. Notes survive reopening the same image; the exported brief and live Muse tool result reflect the saved case.
- The measurement UI separately saved a RAS point-to-point distance from an explicitly synthetic, millimeter-declared NIfTI fixture. This is functional/geometry smoke evidence, not clinical morphometry validation. See `docs/verification/browser-smoke.md`.
- The local public CMHA sample has sform_code 2 and unspecified spatial units; millimeter measurement creation remains disabled for it pending unit corroboration.
- No segmentation inference, aneurysm morphometry, device compatibility, treatment efficacy or clinical validity is established by these tests.
