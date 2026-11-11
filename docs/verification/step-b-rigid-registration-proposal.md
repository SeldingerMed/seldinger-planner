# Fusion Step B verification

## Delivered surface

Step B adds **Propose rigid registration** to the reformat and fusion studio. For a loaded and verified secondary source it computes a secondary-to-primary rigid matrix in the browser, enters it in the matrix field as an unconfirmed draft and shows a tri-planar draft preview. Operator instructions and limits are in [Local imaging](../local-imaging.md#propose-a-rigid-registration).

The saved scene contract is unchanged. A proposal is a draft edit: it withdraws the confirmation, and the scene is saved only through the existing operator confirmation. No backend, schema or ingest code changed.

Every input used here was synthetic, except one approved public CTA region of interest (CMHA, doi:10.6084/m9.figshare.26965450.v1, CC BY 4.0, SHA-256 `a712c465...89fd6b1`), which was registered against a resampled copy of itself. No patient or partner source, separately acquired angiogram, model invocation, external data transfer or deployment was used. Nothing here is a validated registration or a clinical accuracy claim.

## Method

`web/src/rigidRegistration.ts`, method id `nmi_pyramid_compass_v1`:

- Both volumes are block-averaged to three levels with 6, 3 and 1.5 mm targets, capped at 4,000, 30,000 and 600,000 secondary samples, and binned to 8, 16 and 32 intensity levels. The intensity range leaves out the extreme 0.1% of voxels at each end.
- The score is normalized mutual information over the secondary samples that land inside the primary. A position with less than 75% of them inside is not scored.
- A translation scan covers the primary's bounding box at 12 mm, or wider so that it visits at most 6,000 positions. The best four positions are refined at the coarsest level in translation only.
- The middle level runs a compass search over all six parameters from 27 starting rotations (0 and ±8° per axis), at the scan's position and at the starting matrix. The finest level scores the best three distinct results and refines the winner.
- Rotation stays within ±20° per axis of the starting matrix. The result is orthonormalized and passes the same `validateRigid` check the fusion view applies.

The search runs as a generator. `RegistrationProposal.tsx` advances it in 12 ms slices between timers (800 ms while the tab is hidden) and drops the run when the matrix, either volume or the disabled state changes.

## Unit evidence

The three Step B test files hold 34 tests. `rigidRegistration.test.ts` (19) recovers known rigid offsets on synthetic phantoms across inverted contrast, a left-handed anisotropic grid, a secondary in an unrelated frame, a primary away from the RAS origin and a small body in a 300 mm field of air. It also checks that rotation beyond the declared range is not recovered, that single-stepping equals the one-shot result, and that constant, nonfinite, non-millimeter, too-small and non-overlapping inputs are refused. `RegistrationProposal.test.tsx` (14) covers slicing, the hidden-tab slice, cancellation and every way a run is dropped, failure text, invalid draft matrices and the preview. `ReformatStudio.registration.test.tsx` (1) covers the studio wiring.

Mutation check in a scratch copy: 28 single-site mutants of the three source files, with the unmodified baseline green before and after. 26 were killed. Two survive:

- Removing the overall cap on search evaluations. The per-search budgets add up to 12,803, under the 13,000 cap, so the cap cannot bind with the present level table. It is kept as a guard against a later retune.
- Removing the yields inside level building. This changes responsiveness, not results; the step timing below measures it.

## Step timing and accuracy outside the unit phantoms

Run in Node on the development Mac Studio, advancing the job one step at a time and timing each step. Error is the largest displacement of a secondary volume corner from the known transform.

| Case | Start error | Proposal error | Compared at | Solve | Longest step |
| --- | --- | --- | --- | --- | --- |
| Analytic 200³ at 0.8 mm, secondary 200³ at 0.5 mm | 18.8 mm | 0.07 mm | 1.5 mm | 3.0 s | 19.4 ms |
| Analytic 200³ at 1.5 mm, secondary 180³ at 1.5 mm | 36.5 mm | 0.20 mm | 4.5 mm | 4.0 s | 18.7 ms |
| Public CTA, started 13.8 mm and 9° away | 13.8 mm | 0.18 mm | 1.8 mm | 0.9 s | 7.1 ms |
| Public CTA, started in an unrelated frame | 525 mm | 0.18 mm | 1.8 mm | 0.5 s | 1.2 ms |

One step in each analytic case exceeded 12 ms and none exceeded 30 ms.

The public CTA secondary is an 80³ block at 0.6 mm, resampled from the same volume under a 9° rotation with a nonlinear intensity change and noise added. This is the easiest real-anatomy case there is: same acquisition, same anatomy, no deformation. The file does not declare spatial units and was treated as millimeters for this check. Earlier tuning on this volume is what led to the 75% overlap floor, the per-level bin counts and the search from the starting matrix; each has a unit test that fails without it.

## Actual application tracer

A synthetic pair was written as DICOM, admitted through the local ingest path with synthetic scope, and used in the running application (scratch API and Vite, real browser): primary 96³ at 1.5 mm, secondary 80³ at 1.2 mm with inverted contrast and noise, true transform 10.0° and (10, -15, 22) mm.

- Load primary, load secondary `stepb-secondary`: "Secondary image verified", identity matrix, preview painted.
- Propose from identity, tab visible: finished in 6.5 s. Status: moved 28.4 mm and 10.2°, normalized mutual information 1.807 (starting matrix 1.038), 99% of the secondary inside the primary, compared in 1.2 mm blocks. Against the known transform the largest corner error is 0.69 mm (40.78 mm at identity) and the residual rotation 0.46°. The matrix determinant is 1.000000.
- Confirm and save: scene revision saved as confirmed. After a full reload the saved matrix equals the proposed one.
- Tab in the background: the run did not finish in 25 s while hidden, and finished 2.2 s after the tab was shown again, with the same matrix. Browsers give a background tab little processor time, so the status line says the run waits. How much time a hidden tab gets depends on the browser: in an earlier pass on older code, a tab reported as hidden finished in 2.8 s.

## Limits

- Checked on synthetic phantoms and one public CTA against itself. Not checked on separately acquired 3D angiography, across modalities, with different contrast phases, or with anatomy that moved or deformed between acquisitions.
- The score is not an accuracy measure. The search can settle on a wrong alignment, and it cannot tell that two sources show different anatomy. The operator's review of the preview is the control.
- A secondary that extends well beyond the primary is refused. A turn of more than 20° per axis from the starting matrix is not searched.
- Step timing was measured on one machine. A background tab pauses the run.

## Observed checks

- `uv run ruff check .` and `uv run ruff format --check .`: clean.
- `uv run pytest -q`: 1071 passed, 125 skipped (optional runtimes).
- `npm test`: 77 files, 686 tests passed. `npm run build`: passed. `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `npx tsc --noEmit` and Prettier on the Step B files: clean.
- Ten consecutive full `npm test` runs on this branch and ten on `main` each had nine clean runs and one single-test failure, in different tests outside Step B (`aneurysm-integration` on the branch, the C-arm projection preview on `main`). Two earlier branch runs each failed one `DeviceScenarioSync` test. Each passed when rerun. They are timing-sensitive tests under full-suite load and are not changed here.
