# Step D evidence ledger: raw CTA to measured vessel placement

Task `t_90a7a29b`, branch `feat/fusion-d-paired-verification` from `60b1b18`.
Three acceptance tests, kept separate. Each entry states what kind of evidence
it is. Nothing here is a clinical result.

| Test                                                  | State                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1. Real raw design CTA through segmentation           | Done, design data                                                                                        |
| 2. Product line-up, confirm, save, reopen; control    | Done: product path on one case; held-out control 40 of 40 two-frame line-ups within 2 mm (protocol pass) |
| 3. Real same-subject paired vessel-placement accuracy | Not measured: no open legal source found                                                                 |

All runs read approved public inputs into memory and wrote only to the RAM
volume `/Volumes/SeldingerRAM`, under `scripts/research/ram_only.py`, which
confines writes to that device. The research drive had 28 GiB free, under the
40 GiB floor, so nothing was staged on it. No cloud spend, upload, outreach or
access change.

## 1. Raw design CTA through segmentation to named geometry

Validated infrastructure on design data.

- Input: the raw CT of every odd-numbered (design) AVT case (figshare
  14806362, CC BY 4.0), 28 cases from the Dongyang, KiTS and Rider archives,
  read from the fetched zip into memory. Even-numbered cases are refused by
  the script; that set has been read once already.
- Segmentation: the installed TotalSegmentator `total` 3 mm weights
  (`Dataset297_TotalSegmentator_total_3mm_1559subj`, release
  `v2.0.0-weights`, release SHA-256 `0baa2c8d...3394`, checkpoint SHA-256
  `1e38e403...79ac`), run in memory through nnU-Net
  (`planner/aortoiliac_nnunet.py`, backend
  `nnunetv2_in_memory_installed_weights_v1`), CPU only. Every weight file is
  checked against its pinned digest before use. Runtime: Python 3.11.15,
  torch 2.15.0, nnunetv2 2.8.1, nibabel 5.4.2, numpy 2.4.6, scipy 1.17.1.
- Geometry: `planner.aortoiliac_model` names the aorta and both iliac
  arteries from the inferred mask.
- Reference: the AVT annotators' own mask of the same scan, never an input,
  read only to score (`scripts/research/aortoiliac_raw_cta.py`).
- Results, 28 design cases:
  - Aorta named in 28 of 28. Mean distance of its line from the reference
    line, median 0.75 mm (range 0.58 to 2.06).
  - All three branches named in 24 of 28. In D9, D15, D17 and K19 only the
    aorta was returned. Both iliac lines scored in 22; mean line distance
    median 0.85 mm right and 0.82 mm left.
  - Bifurcation, 23 cases with both: median 1.88 mm from the reference's;
    20 of 23 within 5 mm. R1 (96 mm) and R5 (191 mm) are wrong splits.
  - Right iliac on the patient's right in 24 of 24 cases with iliacs.
  - Share of inferred voxels within 2 mm of the annotated lumen: median 0.96.
  - Median 18.6 s per scan on CPU, peak 10.7 GB memory.

## 2. Product line-up from that proposal, and the virtual X-ray control

### Product path, one case

Validated infrastructure, engineering control.

- Case: AVT design case D1, resampled and installed as the case's scan
  (`avt-d1-control`, SHA-256 `00f6e862...14ee`). Its aorta and iliac model is
  the raw-CTA inference of test 1 (`aortoiliac_export.py --weights`, method
  `aortoiliac_totalsegmentator_total_v1`), not the annotators' mask.
- Frames: virtual X-rays of the same scan at a known pose, which puts the
  vessel points a mean 12.2 mm across the beam from the scan as it lies,
  written in the form frame ingest keeps.
- In the operator studio, served from a RAM build: load the scan, open the
  frames, line up on bone, review, confirm and save; reload the page, load the
  scan again and show the saved overlay.
  - One frame: saved as revision 3, "Placed across the frame from one frame;
    depth along its beam is not determined. Moved 11.7 mm and 3.7 degrees."
  - Two frames (AP and LAO 90): saved as revision 4, "Placed in 3D from two
    frames. Moved 12.1 mm and 3.7 degrees." Reopened from the server after
    the reload.
- Scored offline from the saved revision against the known pose, on the
  model's vessel points (every 5 mm along each branch, the ends and the
  bifurcation), which the line-up never reads (`lineup_control.py score`):
  - One frame: vessel points 0.76 mm mean, 1.26 mm worst across the beam at
    the isocentre, from 12.2 mm at the start. In 3D 2.1 mm mean, almost all
    along the beam, which one frame does not fix.
  - Two frames: 0.70 mm mean and 0.99 mm worst in 3D; bifurcation 0.45 mm
    and 0.72 mm across each beam.

### Engine change found by the control

Before the change, the control on this case drifted from a right start: the
coarsest working picture of an abdominal CT carries broad soft-tissue shadows
that pulled the search off. Engine v2 (`bone_edge_compass_v2`,
`bone_edge_compass_biplane_v2`, under `bone_edge_compass_guarded_v3`) also
searches the start from the finer levels and lets the finest level decide.
Line-ups saved under `bone_edge_compass_guarded_v2` still validate and keep
their name. A synthetic phantom did not reproduce the failure under either
search, so the unit test holds the property, not the failure.

Design control set, 8 AVT design cases (D5, D9, K3, K7, K11, R3, R9, R13),
4 poses each, starts a median 14.2 mm off, bone points:

| Engine | Frames | Within 2 mm across the beam | Within 2 mm in 3D | Worst across |
| ------ | ------ | --------------------------- | ----------------- | ------------ |
| v1     | 1      | 11 of 32                    | 2 of 32           | 74.5 mm      |
| v2     | 1      | 18 of 32                    | 2 of 32           | 21.4 mm      |
| v1     | 2      | 14 of 32                    | 14 of 32          | 74.5 mm      |
| v2     | 2      | 27 of 32                    | 25 of 32          | 21.4 mm      |

v2 was chosen on these cases, so they cannot confirm it. The held-out check
is `step-d-heldout-virtual-xray-protocol.md`, frozen at `a1482eb` before any
of its scans was opened. Its result is below.

Regression check on the spine, C-ArmLSpine design cases 1 to 12 (design
only), six disturbed starts each, against the recorded `af2123a` run: both
frames 72 of 72 starts back within 1 mm (was 72 of 72), front frame alone 72
of 72 within 1 mm across the beam (was 72 of 72). Each case's answer lies
within 0.4 mm of its earlier distance from the stated geometry. A line-up
takes about 15 % longer (median 5.4 s against 4.6 s with both frames).

### Held-out control

The protocol file is unchanged since the commit that froze it. Where it
cites the design control as `step-d-virtual-xray-control.md`, that record is
the section above in this file; no separate file was written.

Candidate result under a frozen protocol, engineering control. One run at
`a1482eb` (the commit that froze the protocol), 2026-11-24.

- Cohort: the first 10 CTPelvic1K set-6 scans in archive order. All 10 were
  measured; none refused.
- Vessel points: the 3 scans with a whole tree gave the aorta and both
  iliacs. In the other 7 the scan stops near the bifurcation and the model
  gave one line named "aorta" that runs through an iliac artery (see the
  guard below). Its points still lie in real vessel lumen and the truth is
  the known pose, so the control is scored on all vessel points regardless
  of their names.
- Starts: the vessel points lay a median 10.4 mm across the beam from where
  the known pose puts them.

| Endpoint                                                                 | v3 (under test)                                    | v1 (comparator)                  |
| ------------------------------------------------------------------------ | -------------------------------------------------- | -------------------------------- |
| 1. Two frames, 3D vessel error at most 2 mm (pass at 75 %)               | 40 of 40, pass                                     | 36 of 40                         |
| 2. One frame, across-beam vessel error at most 2 mm (pass at 50 %)       | 40 of 40, pass                                     | 36 of 40                         |
| Two frames, 3D vessel error, median and worst                            | 0.49 mm, 1.4 mm                                    | 0.54 mm, 126.7 mm                |
| One frame, across-beam vessel error, median and worst                    | 0.52 mm, 1.9 mm                                    | 0.52 mm, 72.3 mm                 |
| 3. Bifurcation across the first beam, 12 line-ups each, median and worst | 0.50 and 1.2 mm (one frame); 0.42 and 0.6 mm (two) | 0.51 and 1.3 mm; 0.41 and 0.7 mm |
| 4. Better or worse than the other by more than 0.5 mm                    | better in 8, worse in 0                            |                                  |

The comparator's eight misses are two poses each of C0015 and C0025, from
starts of 13.6 to 18.9 mm, where it settled 45 to 127 mm off; v3 brought the
same eight within 0.45 to 1.15 mm. One frame leaves depth along its beam open
(3D median 2.09 mm, worst 5.4 mm), as designed.

Outputs on the RAM volume: `results/heldout/prepare.jsonl` (SHA-256
`6b041893...dc50`), `v3.jsonl` (`7a0f99e8...409d`), `v1.jsonl`
(`1b54fd35...e42c`).

### Naming guard found by the held-out cohort

The model names its lines from the mask's shape alone. On 7 of the 10 pelvic
scans the widest path was an iliac artery named "aorta"; in C0051 the
segmentation held no aorta voxel at all. The product path
(`propose_aortoiliac_model_from_cta`) now checks every named line against
the segmentation's own labels and refuses the proposal, with the reason,
when under half of the line lies in voxels of its name.

Design check, after the run (these scans are now read):

- AVT design CTA: 28 of 28 still proposed; lowest agreement 0.82.
- The 10 pelvic scans: the 7 misnamed ones refused, the 3 whole trees
  proposed (lowest agreement 0.78).
- The product case D1: proposed, agreement 1.0, 0.96 and 0.96.

The research scripts that score segmentation (`aortoiliac_raw_cta.py`,
`heldout_control.py`) call the model directly and are unchanged. The guard
commit `74a61d8` changes nothing under `scripts/` or `web/`, nor the model or
weights runner; `heldout_control.py` imports only the label map from the
edited module, and that map is unchanged. So the held-out numbers above stand
for the code as merged. Removing the guard (agreement floor 0) fails the
lone-iliac test.

## 3. Same-subject paired vessel placement

Not measured. Every candidate checked fails at least one of: same patient,
abdominal or peripheral vessels, raw CT (not a derived mask), an acquired
angiogram or fluoroscopy frame, projection geometry or a way to recover it, a
genuine vessel reference, and an open licence with no gating. Spent sets were
not proposed (C-ArmLSpine, DeepFluoro, Ljubljana, TotalSegmentator and AVT
held-back).

| Source                                                                               | What it holds                                                                                                                  | Why it cannot measure vessel placement here                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| FEVAR path planning repo (Zheng et al., ICRA 2019; GitHub, Apache-2.0 code)          | One phantom X-ray (512 by 512 JPEG), its 2D aorta mask, a 3D label and two 3D skeletons (512 cubed)                            | Phantom, not a patient; no raw CT; no projection geometry; no bone, so the bone line-up does not apply. The paper's patient data are not released. |
| EVAR automated fusion study (Smorenburg et al. 2023, PMC10363050, article CC BY 4.0) | 10 Amsterdam UMC EVAR patients: preoperative CTA and intraoperative DSA, exported from the hospital PACS under ethics approval | The images are not released; the only supplement is a 14 KB Word file (the procedure appendix).                                                    |
| TCIA, every public XA and RF series (NBIA census: 41 XA, 12 RF)                      | XA from CMB-MML, CMB-AML, CMB-CRC and EAY131; RF from VAREPOP-APOLLO (labelled barium fluoroscopy) and CMB-PCA (voiding)       | 48 frames from the small XA series reviewed: iliac-crest biopsy fluoroscopy, no opacified vessel. No paired CTA of a vessel procedure.             |
| TAIR, ARPA-H AIR release 1 (CC BY 4.0)                                               | Cerebrovascular CTA, MRA and DSA                                                                                               | Intracranial, not abdominal or peripheral. Kept for neuro work.                                                                                    |
| guide3d (Hugging Face airvlab/guide3d, CC BY-NC 4.0)                                 | Biplane fluoroscopy of a guidewire in a vascular phantom                                                                       | Phantom, not a patient; non-commercial.                                                                                                            |
| Thorax X-ray and CT (Zenodo 1400558, CC BY 4.0)                                      | Same-patient chest CT and interventional X-ray, anatomical landmarks                                                           | Thorax; landmarks, not a vessel reference. Already used for the breathing term (negative).                                                         |
| TAVI aortic root (Zenodo 15094600) and BAMNet (Zenodo 19219901), CC BY 4.0           | Real procedure fluoroscopy with aortic root masks                                                                              | No CT of the same patients.                                                                                                                        |
| WEISS catheter (figshare 24624243, CC BY 4.0)                                        | Phantom and patient fluoroscopy with catheter masks (`Phantom`, `T1T2`, `T3-T6` frame files and labels)                        | Frames and masks only; no CT of the same subjects in the release.                                                                                  |

What a legitimate measurement needs, recorded for when a source appears:
the raw CT and the frames of one patient in one episode; each frame's
C-arm angles, source to detector and source to isocentre distances and
pixel spacing, or a calibration that recovers them; a vessel reference
not drawn from the line-up (contrast-filled lumen in the frame, or a
device in a known vessel); and a frozen protocol on cases no Step D
choice has read. Device straightening and breathing against rigid, and
leg or peripheral position, need the same and are not measured. They are
not negative results.

The bone line-up was measured against real paired frames only on bone
(pelvis and lumbar held-back sets, `docs/research/bone-lineup-held-back-results.md`).
Vessel placement on real frames remains unmeasured.
