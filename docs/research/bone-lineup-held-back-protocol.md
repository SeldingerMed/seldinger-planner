# Bone line-up held-back protocol

Protocol `bone-lineup-held-back-v1`. Committed before its one run on the held-back specimens and cases.

## Question

Does the bone line-up (`web/src/boneLineup.ts`), as built and tuned on the design specimens and cases, place the bone on a frame of a specimen or patient it has not been run on?

## Data

- DeepFluoro pelvis, the xvr-data copy: internal research evaluation only. Specimens 1 to 3 were used for design. Specimens 4 to 6 are held back. The format step has converted them; no evaluation has read them.
- C-ArmLSpine (CC BY 4.0): cases 1 to 49 were used for design. Cases 50 to 149 are held back, converted and not read by any evaluation. Case 134 has no usable frame pair and is left out by the format step, which leaves 99.

## Runs

- Pelvis, one frame at a time: 12 frames of each specimen, taken evenly through its frames (`pelvisFrames`). For each frame one run from the reference pose and three from disturbed starts: up to 15 mm across the frame, 30 mm along its beam and 8 degrees about each axis, drawn from the fixed seed. The femurs are left out of the bone by the set's own labels.
- Lumbar, both frames and the front frame alone: for each case one run from the stated geometry and six from disturbed starts of the same ranges and seed.

## Reference

- Pelvis: the stored pose with the scan held half a voxel along each index axis from where its header puts it (`PELVIS.grid_offset_voxels`). This was measured on the design specimens without the line-up and is fixed here. The stored poses are the outcome of the set authors' own registration.
- Lumbar: the set has no reference pose. A case's reference is its own answer from the stated geometry, so the lumbar result is how consistently the line-up returns to one answer, and how far that answer lies from the stated geometry.

## Measures

- Pelvis: mean distance at the set's 14 landmarks between the proposal and the reference, across the beam and in 3D. Runs under 0.5, 1 and 2 mm across the beam, the median and the worst. The same against the stored pose as its files give it. Runs refused. Seconds per run.
- Lumbar: disturbed starts back within 1 mm and 2 mm of the case's own answer, on a 27-point grid of 40 mm half side, in 3D with both frames and across the beam with one. Cases with every start back. Cases whose answer lies within 3 mm of the stated geometry, and the others by name. Runs refused. Seconds per run.

## Primary results

- Pelvis: disturbed starts that end under 1 mm across the beam from the reference, of 108.
- Lumbar: disturbed starts back within 1 mm of the case's own answer with both frames, of 594.

## Design results, for comparison

Measured before this protocol, on the design specimens and cases, with the same runs and measures.

- Pelvis, specimens 1 to 3, 36 frames: 105 of 108 disturbed starts ended under 1 mm across the beam from the reference and all 108 under 2 mm; median 0.49 mm, worst 1.14 mm. The starts lay a median 12.9 mm off.
- Lumbar, cases 1 to 49: with both frames 289 of 294 disturbed starts came back within 1 mm of the case's own answer, every start in 48 of 49 cases; with the front frame alone 288 of 294. Case 34 is the one case short, with both frames: its answer lies 78 mm from the stated geometry.

## Check of the pelvis reference

After the pelvis run, the check that fixed the reference on the design specimens is repeated on the 36 held-back frames, without the line-up: a ray-cast picture of the bone at the stored pose is compared with the real frame by gradient correlation over small shifts, once on the header's grid and once with the scan half a voxel along each index axis. Reported: the median and worst shift on each grid. If the half-voxel grid does not hold on the held-back specimens (median shift not smaller than on the header's grid), the result against the stored pose as its files give it is the pelvis result, and the page says so.

## Conduct

One run of each evaluation with the set `held_back`, at the commit that holds this file: `web/src/research/pelvisBoneLineup.eval.ts` and `web/src/research/lumbarBoneLineup.eval.ts`. Each results directory is named by that commit and is refused if it exists. Nothing is tuned on the held-back specimens and cases afterwards. A refusal by the line-up is recorded as a refused run and counts against the result: a refused pelvis run is not under 1 mm, and a lumbar case refused from the stated geometry has none of its starts back. Any other error stops the run.
