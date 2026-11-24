# Step D held-out known-pose virtual X-ray control: frozen protocol

Frozen 2026-11-24, before any scan of the cohort below was opened. The engine
change it checks (bone line-up start search from the finer levels as well,
`bone_edge_compass_v2` under `bone_edge_compass_guarded_v3`) was chosen on the
AVT design control set (`step-d-virtual-xray-control.md`), so that set cannot
confirm it. This protocol is run once. Any later engine change needs a new
cohort.

## What it measures

An engineering control, not clinical accuracy. Each frame is a virtual X-ray
of the same scan the line-up reads, rendered at a known pose. The line-up
reads bone in the scan and the frames. It is scored on vessel points it never
reads: the aorta, both iliac arteries (every 5 mm), their ends and the
bifurcation, named by the installed TotalSegmentator `total` 3 mm weights and
`planner.aortoiliac_model` on that scan. The truth is the known pose, so the
vessel points need not be anatomically exact to score the line-up. The
control says nothing about breathing, device straightening, patient motion
between scan and table, or real detector physics.

## Cohort

- Source: CTPelvic1K clinical set 6, `CTPelvic1K_dataset6_data.tar.gz`
  (Zenodo 4588403, CC BY 4.0, 8,811,634,327 bytes, md5
  `6b6121e3094cb97bc452db99dd1abf56` as recorded at download), already held at
  `Seldinger Data/raw/zenodo-4588403-ctpelvic1k`. No Step D choice has read
  any scan of it; only its member names have been listed.
- Cases: the first 10 `dataset6_CLINIC_NNNN_data.nii.gz` members in archive
  order, streamed into memory. Nothing past the tenth is read.
- A scan whose vessels cannot be named (no aorta or iliac voxel, or the model
  builder refuses) is not measured and is reported as such. Fewer than 6
  measured cases makes the result insufficient, not a pass or a failure.

## Poses and frames

`scripts/research/heldout_control.py` at the commit that adds this file:
2 mm grid over the lowest 360 mm, 4 poses per case (pose 0 the scan as it
lies; poses 1 to 3 random rigid disturbances up to 15 mm across, 30 mm along
the beam and 8 degrees, about the isocentre), seed 20261124 plus the case's
place in the cohort, two planes (AP, and LAO 90), 512 by 512 admitted-form
8-bit frames on a 360 mm detector at 1,200 mm source to detector and 800 mm
source to isocentre. Every line-up starts from the scan as it lies.

## Engines

- Under test: `bone_edge_compass_guarded_v3` (engines `bone_edge_compass_v2`
  and `bone_edge_compass_biplane_v2`), as committed.
- Comparator on the same frames: the same code with
  `CONTROL_VARIANT='{"fine_start_levels":[]}'`, which is the v1 start search.

## Endpoints

Vessel error is the mean over all vessel points of one case and pose.

1. Primary, two frames: share of line-ups with 3D vessel error at most 2.0 mm.
   Passes at 75 % or more. A refused or failed line-up counts against it.
2. Secondary, one frame: share of line-ups with in-plane vessel error at most
   2.0 mm at the isocentre. Passes at 50 % or more.
3. Secondary: bifurcation in-plane error on the first frame, median and
   largest, for one and two frames.
4. Comparison: line-ups where the engine under test is better or worse than the
   comparator by more than 0.5 mm (3D for two frames, in-plane for one).

The design control set reached 25 of 32 two-frame line-ups within 2.0 mm 3D
on bone points (78 %), against 14 of 32 for the comparator.

## Storage

All reads are streamed into memory. Case folders and outputs live only on the
RAM volume `/Volumes/SeldingerRAM`, under `scripts/research/ram_only.py`.
Nothing is written to the internal disk or to git.
