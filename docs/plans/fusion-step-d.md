# Fusion Step D

Step D takes the fusion work from the head and neck to the aorta, the iliac arteries and the legs. The roadmap and the dataset survey are in the Obsidian note `Seldinger Intraprocedural Fusion Plan and Paired Dataset Survey`.

## What the step adds

In the head, a frame is lined up on the vessels, because every angiogram frame shows them filled with contrast. In an aortic or iliac case most of the fluoroscopy shows no contrast, and the lumbar spine and pelvis are in every frame. Step D lines the CT up with a frame on the bones, and the aorta and iliac model from the same CT then lies where the vessel is.

| Part | What the operator gets | Data it is built and measured on |
|---|---|---|
| 1 | Bone line-up: the CT is lined up with one or two X-ray frames of the abdomen or pelvis, starting from the C-arm angles | DeepFluoro pelvis (6 specimens, 366 frames with reference poses), C-ArmLSpine (149 patients, front and side frame with the 3D scan of the same session) |
| 2 | Aorta and iliac model from the CT, with its centerlines | AVT, TotalSegmentator v2, CTPelvic1K |
| 3 | The model drawn over the frame in the overlay studio after a bone line-up, saved as an operator-confirmed registration | Virtual angiograms from AVT and TotalSegmentator scans; BAMNet and aortic-root TAVI frames |
| 4 | Correction for what the bones do not carry: iliac arteries straightened by a stiff wire, and movement with breathing | Thorax X-ray and CT landmark set; synthetic straightening of iliac centerlines |

Every result is a proposal the operator confirms. Nothing is accepted automatically.

## Boundaries

- No dataset files, derived arrays, weights or per-run detail in the repository. They stay on the external research drive; the repository takes aggregates and small synthetic fixtures.
- DeepFluoro and Femur are under non-commercial licences (CC BY-NC 4.0 and CC BY-NC-ND 4.0): internal measurement only. C-ArmLSpine, AVT, TotalSegmentator v2, CTPelvic1K, the thorax set and the TAVI sets are CC BY 4.0.
- Saved registrations from Steps C1 to C4 replay to the same numbers. The bone line-up is a new method with its own identifier.
- A protocol is committed before its run. Design cases are used to build and tune; held-back cases are read once.
- Live in-room overlay is outside this step. Step D works on saved frames and replayed recordings.

## Part 1: bone line-up

### What was checked on the data before the design, 2026-11-22

- C-ArmLSpine: every case holds a front and a side frame (147 cases with two frames, one with three) and a 394-cubed scan at 0.5 mm from the same C-arm, taken about a minute after the frames. The frames carry the C-arm angle (0 and 90 degrees), 1140 mm source to detector and 745 mm source to patient. The stated pixel size (1 mm at 2048 pixels) is a placeholder, so the detector size is fitted. A virtual X-ray of case 1 at the stated angles with a 300 mm detector shows the same vertebrae at nearly the same place and size as the real front frame; the side frame is mirrored against the first guess of its orientation. The scan is therefore in the C-arm's own frame, and the stated geometry is the reference the line-up is measured against. There are no fiducials.
- DeepFluoro and Femur (xvr-data copy): the same file layout as the Ljubljana copy read in Step C2: per frame a stored pose and intrinsics, per subject 14 fiducial points, a CT at 1 mm. `web/src/research/ljubljanaGeometry.ts` already reads these conventions.

### Acceptance criteria

1. An engine `bone_gradient_compass_v1` that takes bone samples from a CT, one or two frames with their views, and a start, and returns a pose proposal with its score, the same job shape as the vessel engines (resumable, bounded, operator-confirmed).
2. Synthetic check, gated: on virtual X-rays of a synthetic bone phantom at known poses, from starts up to 10 mm and 10 degrees away, the proposal returns to within 1 mm mean target error in at least 90 percent of runs for two planes, and to within 1 mm in the detector plane for one.
3. DeepFluoro, reported: mean target error at the 14 fiducials against the stored reference pose, single frame, from starts drawn around the reference under a committed protocol. Subjects 1 to 3 are for design, 4 to 6 are held back.
4. C-ArmLSpine, reported: distance of the proposal from the C-arm's stated geometry at points on the vertebrae, front and side frame alone and together, from the stated start and from disturbed starts. Cases 1 to 49 are for design, 50 to 149 are held back.
5. The measured numbers go into `docs/research/` with their protocol. A part that measures no gain over its start is fixed or removed, not shipped.

### Design

- 3D side: voxels above a bone threshold are thinned to a bounded set of samples, each with a weight from its intensity above the threshold. Projecting and adding the samples into a small image gives a bone-only virtual X-ray in a few milliseconds, which is what makes a search of several thousand poses practical in the browser.
- 2D side: the frame is reduced, its slow background removed, and its gradients taken at two or three blur widths.
- Score: the correlation between the gradients of the virtual X-ray and of the frame, inside the part of the frame both cover. With two planes the scores are added for one shared pose.
- Search: the compass search already used by the vessel engines, coarse blur to fine, over three turns and three shifts, plus detector size when the frame is uncalibrated.
- Start: the C-arm angles and distances from the frame, the CT centered on the central ray.

### Phases

1. Prepare DeepFluoro and C-ArmLSpine into plain arrays on the research drive (format change only, checked against the fetch record).
2. Engine and its synthetic tests.
3. Evaluation harness, design-case runs, tuning on design cases only.
4. Protocol committed; held-back run; results page.
5. Bone line-up offered in the overlay studio (with part 3).

## Decisions log

- 2026-11-22: Step D started. All 17 open datasets for Steps D and E are on the research drive, each checked against its checksum.
- 2026-11-22: C-ArmLSpine has no fiducial reference. Its reference is the C-arm's own geometry, since the scan and the frames come from the same machine in one session. DeepFluoro supplies the fiducial-based reference.
- 2026-11-22: the format step (`scripts/research/prepare_bone_sets.py`) wrote DeepFluoro subjects 1 to 3 and C-ArmLSpine cases 1 to 49, the design sets, to the research drive. Frames are averaged over 4 by 4 pixels and the lumbar scans over 2 by 2 by 2 voxels, to 1 mm. The lumbar scan is reduced slice block by slice block so the step stays small in memory on a machine that is also training.
- 2026-11-22: all 49 design cases hold two frames, at 0 and 90 degrees to within a degree. A few cases also keep the sweep's own projections beside the scan (case 39: 301 frames of 1024 pixels a side). They are listed in the record and not read; they are a later source of frames at many known angles.
- 2026-11-22: a DeepFluoro frame is stored at 1536 pixels a side while its stored intrinsics describe a 1436-pixel frame cut from it. The format step keeps the whole frame and records both; the cut is read in the evaluation's geometry code.
- 2026-11-22, first look at the method on six design cases of C-ArmLSpine (a Python sketch of the planned engine, 41,000 bone samples on a 2 mm grid, 128-pixel working frame, 1.7 ms a pose; working files and per-run numbers on the research drive under `fusion-d/look`). Not a protocol run.
  - The side frame is the front frame's geometry turned 90 degrees and mirrored left to right.
  - Front frame alone: from starts up to 15 mm across, 30 mm in depth and 8 degrees off, 31 to 34 of 36 runs came back to the case's own answer within 1 mm across the frame. Depth stays loose with one frame.
  - Side frame alone is weak. Skin and soft-tissue outlines carry most of the gradient strength. Pressing the frame's gradient strength flat and keeping its direction raised the side frame's returns from 15 to 18 of 36 and is kept; a wider opening blur sent the side frame far off and is dropped for it.
  - Both frames, from the stated pose, detector size free: every one of the six cases landed within 2 mm of the stated geometry, with nearly the same small offset (about 1 mm) and the same fitted detector sizes (0.89 to 0.94 of 300 mm for the front, 1.01 to 1.02 for the side). The offset and the size are properties of the machine, so the size is fitted once on design cases and then held.
  - Both frames, from disturbed starts: 16 of 36 back within 1 mm with a narrow opening blur. With a wide one 28 of 36 agreed with each other, but on an answer about 16 mm deep of the stated pose with the side frame's size pulled to 0.81: a free size per frame lets the coarse level trade size for position.
- 2026-11-22, second look, ten design cases, size held:
  - Order of the search decides it. Lining up the front frame first (three blur levels), then scanning depth with both frames, then searching with both: 57 of 60 disturbed starts came back within 1 mm in 3D of the case's own answer. Both frames together from the start: 36 of 60.
  - The three misses stopped 20 mm deep of the answer at a lower score; the depth scan was too short. It now runs 60 mm each way in 4 mm steps at the coarse blur and the three best separate depths are searched.
  - The front frame's beam runs from the patient's back to the front. With that, the score rose on each of the four cases tried (0.45 to 0.50, 0.42 to 0.48, 0.50 to 0.55, 0.50 to 0.56 with both frames) and both frames fit one detector size, 1.02 of 300 mm, 306 mm. Earlier runs had the beam reversed and absorbed it in a front size of 0.92.
  - So the set's two frames enter this planner's view model as stored, at the stated angles (primary 0 and 90), with no mirroring, a 306 mm detector, and the scan's RAS frame as the C-arm frame.
  - The line "the side frame is mirrored" above described the sketch's own axes, not the planner's.
- 2026-11-22: the bone line-up is built in the browser engine, in the pattern of the vessel engines, and measured by an offline harness that runs the same engine code.
