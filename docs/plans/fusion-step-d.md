# Fusion Step D

Step D takes the fusion work from the head and neck to the aorta, the iliac arteries and the legs. The roadmap and the dataset survey are in the Obsidian note `Seldinger Intraprocedural Fusion Plan and Paired Dataset Survey`.

## What the step adds

In the head, a frame is lined up on the vessels, because every angiogram frame shows them filled with contrast. In an aortic or iliac case most of the fluoroscopy shows no contrast, and the lumbar spine and pelvis are in every frame. Step D lines the CT up with a frame on the bones, and the aorta and iliac model from the same CT then lies where the vessel is.

| Part | What the operator gets                                                                                                 | Data it is built and measured on                                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Bone line-up: the CT is lined up with one or two X-ray frames of the abdomen or pelvis, starting from the C-arm angles | DeepFluoro pelvis (6 specimens, 366 frames with reference poses from the set authors' own registration), C-ArmLSpine (149 patients, front and side frame with the 3D scan of the same session) |
| 2    | Aorta and iliac model from the CT, with its centerlines                                                                | AVT, TotalSegmentator v2, CTPelvic1K                                                                                                                                                           |
| 3    | The model drawn over the frame in the overlay studio after a bone line-up, saved as an operator-confirmed registration | Virtual angiograms from AVT and TotalSegmentator scans; BAMNet and aortic-root TAVI frames                                                                                                     |
| 4    | Correction for what the bones do not carry: iliac arteries straightened by a stiff wire, and movement with breathing   | Thorax X-ray and CT landmark set; synthetic straightening of iliac centerlines                                                                                                                 |

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

1. An engine (`bone_edge_compass_v1`, with two frames `bone_edge_compass_biplane_v1`) that takes bone samples from a CT, one or two frames with their views, and a start, and returns a pose proposal with its score, the same job shape as the vessel engines (resumable, bounded, operator-confirmed).
2. Synthetic check, gated: on virtual X-rays of a synthetic bone phantom at known poses, from starts up to 10 mm and 10 degrees away, the proposal returns to within 1 mm mean target error in at least 90 percent of runs for two planes, and to within 1 mm in the detector plane for one.
3. DeepFluoro, reported: mean target error at the set's 14 landmarks against its reference pose, single frame, across the beam and in 3D, from starts drawn around the reference under a committed protocol. Subjects 1 to 3 are for design, 4 to 6 are held back.
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
- 2026-11-22: C-ArmLSpine has no reference pose. Its reference is the C-arm's own geometry, since the scan and the frames come from the same machine in one session. DeepFluoro supplies reference poses: the outcome of its authors' offline registration of each frame (Grupp et al. 2020, "poses recovered from successful registrations in this phase were treated as ground truth"), with 14 anatomical landmarks marked in each CT. (This line first called the DeepFluoro reference fiducial-based; it is not.)
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
- 2026-11-22: the engine is `web/src/boneLineup.ts`, methods `bone_edge_compass_v1` and `bone_edge_compass_biplane_v1`. Decisions made while building it against a phantom with a known answer:
  - The score is the agreement between the bone picture's edges and the frame's flattened edges, divided by the picture's total edge strength. The sketch divided by the root mean square, as gradient correlation does. Against a flattened frame that rewards any pose that smears the picture's edges: from the true pose the search turned 4 to 5 degrees out of the plane and moved 20 mm toward the source for a score gain of 0.005. With the total edge strength the same search stays within 0.1 to 0.7 mm of the true pose.
  - No shading removal on the frame. It put a halo inside every bone that the bone picture does not have.
  - A point's weight is multiplied by its depth squared, so a pixel of the bone picture holds the beam's path through bone.
  - Coarse levels are smaller working pictures (32, 64, 128 pixels) at one blur, not one picture at wider blurs. A front and side line-up takes 2 to 5 seconds.
  - Frames are taken as frame ingest delivers them, bone dark. A first version chose the polarity from the coarse search; on a side frame alone it chose wrong on two of three cases.
  - Before the first frame's search, a coarse look across the frame (48 mm each way) adds up to three other places to search from, and the finest level picks among them. On case 8 two of six disturbed starts had settled one vertebra off, at a score of 0.25 against 0.32.
- 2026-11-22: the design-case evaluation is `web/src/research/lumbarBoneLineup.eval.ts`, with its reading of the set in `web/src/research/lumbarSet.ts`. Held-back cases are reached only by the set name `held_back`, for the protocol's one run; a named list of cases cannot reach them.
- 2026-11-22: cases 8 and 9 lined up about 20 and 16 mm along the front beam from the stated geometry, from every start. This was first read as the patient lying off the stated geometry. It was the search: see the depth entry below. The count of cases near the stated geometry is still reported beside the count that come back to one answer.
- 2026-11-22: the bone line-up is built in the browser engine, in the pattern of the vessel engines, and measured by an offline harness that runs the same engine code.
- 2026-11-22: the sketch with the beam corrected, 30 design cases, six disturbed starts each: 180 of 180 back within 1 mm of the case's own answer, 27 cases within 3 mm of the stated geometry, and cases 8, 9 and 17 about 21, 16 and 22 mm deep of it.
- 2026-11-22, changes to the engine after its first design runs, each measured on design cases:
  - A spine repeats itself every vertebra. A start one level off settled on the wrong level in 3 of 54 runs. The first frame is now searched from the start and from the best places a coarse look across the frame finds, and the same look is repeated around the answer at the finer levels: 54 of 54 on the same nine cases with one frame and with two, 108 of 108 on 18 cases.
  - A pose is scored while each frame holds at least half the bone it held at the start. The earlier rule asked for a share of the whole scan in the frame, which a scan much longer than the frame cannot meet.
  - With two frames, depth along the first beam is scanned in 2 mm steps and searched at the finest level only. At the coarser level cases 8, 9 and 17 settled 16 to 23 mm deep at a lower score than at their start; a lateral spine scores as well a vertebral body's depth off as in place when it is blurred. All three now end within 2 mm of the stated geometry.
  - Bone that moves against the rest between the scan and the procedure can be marked in the scan and is left out. In the pelvis set the femurs turn at the hip, and the stored pose is the pelvis's. On five frames of specimen 1 the error across the beam went from 0.6 to 2.9 mm, to 0.7 to 1.0 mm, with the femurs left out. The format step now writes the set's bone labels beside the scan.
  - The working picture is the mean of the source pixels each of its pixels covers, part pixels by their share. Averaging whole pixels only set a frame half a source pixel off when its size is not a multiple of the working size: 0.6 mm at the bone on a 180-pixel frame, 0.25 mm on the 358-pixel pelvis frames. On the phantom the offset is now under 0.1 mm at both sizes.
- 2026-11-22: the format step and the evaluations run beside a training job that holds the machine's heavy-job slots, and a process above about 250 MB is paused. The format step reads poses without torch and streams the scan and labels from file to file (peak 129 MB for specimen 1, from over a gigabyte); the pelvis evaluation holds a scan only while its bone is sampled.
- 2026-11-22: a whole-set lumbar format run prepared 148 cases. Case 134 carries its frames in a further folder only and is left out, listed in `left-out.json`. Preparing the held-back cases is a format change; no evaluation has read them.
- 2026-11-22: the DeepFluoro stored poses hold the scan half a voxel along each index axis from where the scan's header puts it.
  - The line-up ended 0.4 mm right and 0.6 mm up of the stored pose on average, the same way on every frame of the three design specimens.
  - Checked without the line-up (`fusion-d/look/pelvis-offset/independent.py` on the research drive): a ray-cast picture of the bone at the stored pose, in numpy, is compared with the real frame by gradient correlation over small picture shifts. The measure reads a known shift of 0.4 and 0.7 pixels back to 0.01 pixel on average.
  - On the header's grid the frame's bone sits a median 0.74 mm from the ray-cast one (0.55 mm right, 0.45 mm up, at the bone; worst 0.87 mm), on all 36 frames. With the grid moved half a voxel along each index axis it sits 0.10 mm away (worst 0.23 mm), and the correlation at the stored pose rises from 0.68 to 0.77. Along the beam the half voxel is the best of minus a half, none and a half (worst shift 0.65, 0.37 and 0.23 mm).
  - The scan file's two header transforms agree and the format step keeps the grid as stored, so the offset is between the set's poses and its scan header, not in the preparation. DiffDRR's own reader centers a scan the way this code does. Where the offset came from in the set's making was not established.
  - The evaluation therefore measures against the stored pose with the scan held there (`PELVIS.grid_offset_voxels`), and keeps the distance from the stored pose as its files give it beside every run.
- 2026-11-22, pelvis design specimens 1 to 3, 12 frames each taken evenly through the specimen, one frame at a time, engine at `af2123a`, evaluation at `d9d9259`. Views run from 2 to 37 degrees off the straight front.
  - From the reference pose: median 0.48 mm across the beam, worst 1.19 mm; 35 of 36 under 1 mm.
  - From 108 disturbed starts (median 12.9 mm across the beam and 22 mm in 3D from the reference, turned up to 8 degrees): none refused, median 0.49 mm across the beam, worst 1.14 mm; 58 under 0.5 mm, 105 under 1 mm, 108 under 2 mm. Median 3.4 seconds a run.
  - In 3D the median is 1.7 mm and the worst 8.9 mm: one frame does not place depth along its beam.
  - Against the stored pose as its files give it: median 0.84 mm across the beam, 83 of 108 under 1 mm.
  - By specimen, disturbed starts: medians 0.55, 0.54 and 0.42 mm; 36, 33 and 36 of 36 under 1 mm.
- 2026-11-22, lumbar design cases 1 to 49, engine at `af2123a`, six disturbed starts a case (up to 15 mm across, 30 mm along the beam, 8 degrees about each axis). The set has no reference pose, so this is how consistently the line-up returns to one answer.
  - Both frames: 289 of 294 starts back within 1 mm of the case's own answer, every start in 48 of 49 cases; the answer lies a median 1.8 mm from the stated geometry and within 3 mm in 48 cases. Median 4.6 seconds a run.
  - Front frame alone, across its beam: 288 of 294, every start in 48 of 49 cases. Median 3.3 seconds a run.
  - Side frame alone: 116 of 294, every start in 5 of 49 cases.
  - Case 34 is the one case short with both frames: its answer lies 78 mm from the stated geometry and one start of six comes back. Its side frame shows the spine faintly. Trials of a field-size search and of setting the second frame aside did not separate it from the other cases on the phantom, and neither is in the engine. It stays in the count.
- 2026-11-22: frames are taken in any order and the one nearer the patient's front is searched first. One frame alone is taken within 60 degrees of the front-to-back axis and a lone side frame is refused: one frame placed the bone at every angle measured on the pelvis frames (2 to 37 degrees), and a side frame of the spine alone brought 116 of 294 starts back. Three lumbar design cases and the 12 frames of pelvis specimen 3 give the same answers, to the last digit, before and after the change.
- 2026-11-22: the held-back measurement is `docs/research/bone-lineup-held-back-protocol.md` (`bone-lineup-held-back-v1`), committed before its one run.
