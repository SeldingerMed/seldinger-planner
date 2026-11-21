# Angiogram overlay and 2D-to-3D registration proposal (fusion Steps C1 to C4)

Step C1 lays the accepted 3D vessel mask of a case over one acquired angiographic frame. Step C2 adds a proposal that fits one pose to a frame from each plane of a pair, described under [Two planes](#two-planes). Step C1 adds four things:

1. Admission of a few angiographic pixel frames as their own bounded, hash-bound store.
2. A browser engine that proposes a rigid pose for the volume under the Step A camera.
3. An overlay studio where an operator reviews the proposal and confirms it or discards it.
4. An immutable record of each confirmed proposal.

Everything here is retrospective. No live video is read. A proposal is not a validated registration and no accuracy is claimed for it. The angle convention is the one Step A declares (`dicom_xa_patient_longitude_latitude_ras_v1`), which has not been verified against a vendor system, a detector rotation or an image flip.

Step C2 added joint refinement across two planes and an evaluation against public data with a known pose. Step C3 added the vessel-presence report and a section of the brief, described under [Vessel-presence report](#vessel-presence-report). Step C4, part 1, added a second pair of proposal methods that read the frame with no threshold, described under [Vessel evidence](#vessel-evidence). The centerline distance methods of Steps C1 and C2 are unchanged and remain the default.

## Frame admission

Step A's projection manifest keeps acquisition geometry and no pixels. That is unchanged. Pixel frames are a second, separate source kind with their own store under `.runtime/installed-frames/<source-id>/`.

Bounds:

| Quantity                       | Bound                             |
| ------------------------------ | --------------------------------- |
| Planes per bundle              | 1 or 2 (`single`, or `a` and `b`) |
| Frames per plane               | 1 to 8                            |
| Stored frame side              | 64 to 1024 pixels                 |
| Source frame side              | at most 4096 pixels               |
| Redaction rectangles per plane | at most 16                        |
| Frame index                    | 0 to 1,000,000                    |
| Manifest                       | at most 64 KiB                    |

A stored frame is raw row-major 8-bit grayscale, where a larger byte is a brighter display pixel. The manifest (`frames.json`) records, per frame, its index in the source, the SHA-256 of the stored bytes and the SHA-256 of the file it came from. No name, date, device or other source metadata is retained. The manifest revision is the SHA-256 of its exact bytes.

### Deidentification

The rule from Step A carries over and becomes a gate, because pixels are now kept:

- A DICOM XA object whose Burned In Annotation (0028,0301) is `NO` is admitted on that declaration.
- Any other input needs `identifiers_removed: true` in the request. That is the operator's attestation that the recorded crop and redaction rectangles removed every identifier. PNG frames carry no tag, so they always need it.

Redaction rectangles are blanked first, in source pixel coordinates, and the crop is applied after. Both are recorded in the manifest. The command cannot see whether text remains. The attestation is the operator's, and the studio shows which basis a plane was admitted on.

### Geometry

A DICOM plane keeps its acquisition geometry only when Step A's converter calls it calibrated and no crop was applied, because a crop moves the image center off the central ray. Every other plane has no geometry, and the operator enters it in the studio, where it is labelled assumed.

Two planes in one bundle are linked by operator declaration only. Either plane can be registered on its own, or both together with one pose.

### Commands

Frames of a video are extracted outside the app. The app has no video decoder.

```sh
python3 scripts/extract_angio_frames.py RUN.mp4 OUT_DIR --frames 120 133
```

This runs ffmpeg once per extraction, selecting all requested frame indexes in one decoder pass, and writes 8-bit grayscale PNGs with container metadata stripped, a `request.template.json`, and an `extraction.json` with the video and frame hashes. If ffmpeg is not on `PATH`, the helper downloads the static build packaged in the `imageio-ffmpeg` 0.8.1 wheel for the current platform from PyPI, checks it against a SHA-256 pinned in the script, confirms it runs, and installs it under `.runtime/tools/`. `--no-download` refuses the download. An ffmpeg already on `PATH` is used as it is; the pin covers only the build the helper downloads. Pinned builds exist for macOS (arm64, x86_64), Linux (x86_64, aarch64) and Windows (AMD64).

Extraction uses one decoder pass with exact frame-index selection and passthrough timestamps, capped at eight output frames and a 600-second timeout. It does not infer a frame number from time or assume a constant frame rate. The eight spread-out frames of the already used 4,650-frame TAIR clip extracted in 0.31 seconds locally and were byte-identical to the previous per-index extraction.

Use a destination without previous `frame-*.png`, `request.template.json` or `extraction.json` artifacts. The helper refuses those paths rather than deleting or overwriting an earlier run; unrelated operator notes and a video beside the outputs are allowed. All requested frames and both JSON files are prepared in private same-filesystem staging. Publication uses non-overwriting hard links, with the incomplete request template last. A handled extraction failure leaves no new public outputs; a handled publication failure withdraws only paths this run created. This is not a crash-atomic directory transaction: forced termination or filesystem cleanup failure can leave partial artifacts, which require a fresh destination or manual cleanup before retry. Keep the input and output ancestry operator-controlled during this standalone conversion.

The template is deliberately incomplete. Its scope is a placeholder, it has no crop and `identifiers_removed` is false, so admission refuses it until an operator has looked at the frames and completed it.

```json
{
  "scope": "public",
  "planes": [
    {
      "plane": "single",
      "kind": "png",
      "container": "RUN.mp4",
      "frames": [{ "path": "frame-000120.png", "index": 120 }],
      "crop": [206, 32, 412, 444],
      "redactions": [],
      "identifiers_removed": true
    }
  ]
}
```

`scope` is `synthetic`, `public` or `authorized`. Rectangles are `[x, y, width, height]` in source pixels. A DICOM plane uses `"kind": "dicom"` with `"path"` and `"frame_indexes"` in place of `frames` and `container`. It must be uncompressed, unsigned, single-sample monochrome. Its selected frames share one linear scale to 8 bits, and MONOCHROME1 is inverted so stored bytes are display brightness.

```sh
env -u PYTHONPATH -u PYTHONHOME .runtime/ingest-runtime/bin/python \
    -m planner.frame_ingest .runtime/installed-frames REQUEST.json --source-id my-run
```

The command writes to a private staging directory, claims the destination by creating it (which fails if the source ID already exists), moves the frames in and renames the manifest last. Nothing is readable before the manifest is in place. It then reads every published frame back through the installed-store reader and withdraws the whole bundle if any read fails. A bundle is never modified in place. An admission interrupted partway can leave a bundle directory with no `frames.json` and a `.frames-staging-*` directory beside it. Nothing reads either, and that source ID stays refused until both are removed by hand.

## Server interface

| Route                                                                  | Purpose                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/projection-frames/{source_id}`                               | The validated manifest and its revision                           |
| `GET /api/projection-frames/{source_id}/planes/{plane}/frames/{index}` | One frame's bytes, with `X-Frame-Manifest-Revision`               |
| `GET /api/cases/{case_id}/projection-registration`                     | The saved proposal for the case, if any                           |
| `PUT /api/cases/{case_id}/projection-registration`                     | Save an operator-confirmed proposal                               |
| `GET /api/cases/{case_id}/vessel-presence`                             | The saved vessel-presence report for the current proposal, if any |
| `PUT /api/cases/{case_id}/vessel-presence`                             | Save an operator-confirmed vessel-presence report                 |
| `GET /api/view-network`                                                | The view network's weights, verified on every read; no parameters |

The frame routes are read-only and re-verify every frame against its manifest digest before serving it. Nothing accepts pixels: the `PUT` body holds identifiers, hashes, six view numbers, a 4 by 4 matrix and scalar scores. The vessel-presence `PUT` body holds identifiers, hashes, and counts and lengths per segment, with no pixels and no coordinates.

## The proposal engine

All computation runs in the browser (`web/src/projectionRegistration.ts`, method ID `centerline_distance_compass_v1`).

- **3D side.** `maskPoints.ts` takes the accepted vessel mask and keeps its medial voxels, found with an exact Euclidean distance transform, as points in RAS millimeters. It is an unordered point set, not a topological centerline. Masks whose vessel bounding box exceeds 8,000,000 voxels are coarsened by a whole factor of at most 8, and the studio says so.
- **2D side.** `vesselness2d.ts` runs a multi-scale Hessian ridge filter of the declared polarity on a copy of the frame no longer than 384 pixels per side, keeps the crests of line-like structures, and builds a distance map from them. It is a matching target, not a vessel segmentation. It misses faint vessels and can mark catheters, sutures and bone edges.
- **Score.** Projected 3D points are scored by their distance to the nearest 2D crest, and 2D crests by a separate coarse cell-coverage heuristic. Distances are capped at 8 mm at the isocenter plane of the entered geometry, so a vessel present on one side only costs a bounded amount. The cap is held as a fixed number of pixels during the search, so a fitted field size cannot lower the score by changing it. A field so small that 8 mm is more than 96 working pixels is refused. A point counts as inside the frame anywhere from edge to edge.
- **Search.** A compass search over the six rigid parameters from the starting pose: 60 mm in the image plane, 60 mm in depth and 15 degrees about each camera axis, within 30,000 score evaluations. It starts from the entered pose and from in-plane turns of 7 degrees either way, and refines the best three. It runs as a resumable job in 12 ms slices.
- **Depth and out-of-plane turns.** One plane sees depth only as a small change of magnification, and a turn about an in-plane axis mostly as foreshortening. Both carry a weak pull toward the starting pose, so they stay near it unless the frame gives clear evidence. Neither should be read as determined. With entered geometry the operator can let the field size be fitted between 0.7 and 1.45 times the entered width. That replaces the depth search, because the two are one freedom.

Detector pixels must be square. A pose that leaves fewer than half the points inside the frame is not scored.

### What the numbers mean

The studio reports the mean capped distance from projected 3D points to 2D crests, the share of points within 2 mm of a crest, the share inside the frame, and the share of 2D crest samples whose coarse neighborhood has no projected point. This last fraction is not a physical 2 mm test: a coverage cell is `max(1, round(cap / 3))` working pixels wide and each projected point covers its own cell and the eight adjacent cells. The reverse-coverage term is an approximate search heuristic, not a vessel-presence measurement. It must not be interpreted as the fraction of vessels absent from either image. Millimeters are at the isocenter plane of the proposed geometry, so they use the fitted field size when one was fitted. These compare two automatically extracted line sets. They are not a registration accuracy, and on the one real case tried they did not separate plausible from implausible poses (see the [verification record](verification/step-c1-angiogram-overlay.md)).

## Two planes

`web/src/biplaneRegistration.ts`, method ID `centerline_distance_compass_biplane_v1`, proposes one rigid pose against one frame from each plane of a declared pair.

- **Why.** A second plane far enough from the first sees the first plane's depth as an in-plane shift. One pose scored against both frames then has its depth set by the second plane's evidence, so the search carries no pull toward the starting pose. Whether the answer it reaches is right is a separate question, taken up under "What was measured".
- **Score.** Each plane is scored the way the single-plane method scores it. The joint cost is the mean of the two. The single-plane method is unchanged, so a saved single-plane record still replays to the same numbers.
- **Search.** A scan over shifts at the starting rotation, then a compass search from the best four shifts and the start, each also from a 7 degree turn either way about each axis, then refinement of the best three. The range is 60 mm along and 15 degrees about each of plane A's camera axes, within 60,000 evaluations. An evaluation scores both planes, or stops at the first plane that leaves too few points inside its frame. A last refinement caps distances at 2 mm instead of 8 mm, so a point with no partner costs the same wherever it lands and stops pulling the pose toward an unrelated line.
- **Plane angle.** The central rays must be at least 30 degrees apart. Closer planes add too little to determine depth, and the engine, the saved-record parser and the server all refuse them.
- **Detector scale.** Each uncalibrated plane can have its own field size fitted. On public clinical frames the fit was unreliable (see below), and the studio says so.

**Same patient position.** The two frames must show the same anatomy in the same position: acquired together, or with no patient or table movement between them. Nothing in the software can check that. The operator attests to it before a two-plane proposal can be saved, and the record says the position was attested and not checked.

**What was measured.** On a synthetic phantom, from about 10 mm and 10 degrees off, the two-plane proposal comes back within 1 mm and 1 degree in three dimensions. On ten public clinical subjects with a reference pose it was better than either single plane at the median, its worst runs were worse, and it was more than 1 mm from the reference in about three runs out of four. Started at the reference pose it moved away, and its score did not mark the reference as a good pose. Fitting the detector size did not work on that data. The protocol and the aggregate numbers are in [docs/research](research/ljubljana-known-pose-results.md). A two-plane proposal is therefore a starting point for an operator to correct, and its score is not a sign that it is right.

## Vessel evidence

`web/src/evidenceRegistration.ts`, method IDs `vessel_evidence_compass_v1` for one plane and `vessel_evidence_compass_biplane_v1` for two. The operator chooses between these and the centerline distance methods in the studio. A saved record of one kind is never read as the other.

- **Why.** On the public subjects with a reference pose, the centerline distance score was poor at the reference pose itself. The extracted 2D lines were mostly correct but covered a median 20% of the projected 3D points, and the cost let the unmatched points decide the pose. The diagnostics are in [docs/research](research/ljubljana-reference-diagnostics-results.md).
- **2D side.** `vesselEvidence2d.ts` runs the ridge filter on a copy of the frame no longer than 768 pixels per side and keeps the response with no threshold. It is compressed between the frame's own 75th and 99.5th percentile, so a faint small vessel counts for a useful share of what a large one counts for, and blurred to five widths. There is no sensitivity setting and no extracted line set. It is a matching target, not a vessel segmentation, and it is high on any line-like structure: a catheter, a tube or a bone edge included.
- **Score.** For each plane, the mean evidence under the projected 3D points, from 0 to 1. A point outside the frame counts as zero. A 3D point with no vessel under it costs the same wherever it lands. A bounded term adds the share of strong evidence with no projected point near it.
- **Search.** A scan over shifts, then a compass search through the five blur widths from widest to narrowest, 60 mm along and 15 degrees about each camera axis of the first plane, within 120,000 evaluations for the whole proposal. One implementation serves one plane and two. With one plane, depth and out-of-plane turns keep a weak pull toward the starting pose, as in the centerline distance method.
- **Field size.** A requested fit of the field size is searched beside the entered size and kept only when it lowers the cost by at least 0.02. The record states what became of it: `not_requested`, `kept` or `dropped`. `kept` means the fitted search's result was kept. It does not by itself say that the size moved; each plane's detector scale says that. The studio's words for a saved record name each field a kept fit moved, or say that none did. A dropped fit leaves every plane at its entered size.

**What the numbers mean.** The studio reports, per plane, the mean vessel evidence under the projected points at the result and at the starting pose, the share of points inside the frame, and the share of strong line-like structure with no projected point near it. None of these is a registration accuracy, and the studio says so beside them. A wrong pose can score as well as a right one.

**What was measured.** On the synthetic phantoms the methods meet the gates of the centerline distance methods and a gate with part of the 3D tree absent from the frames. On the ten public subjects with a reference pose, under a protocol committed before the run, the two-plane method ended under 1 mm from the reference in 18 of 25 runs on the five subjects held back from development and in 25 of 25 on the five used for development, against 5 and 7 of 25 for the centerline distance method. One held-back subject failed in every arm, including when started on the reference pose. With a wrong entered field size and the fit on, 10 of 25 held-back runs ended under 1 mm. That is a completed run of a small, fixed protocol on data that is not unseen, and not a validation study. The protocol and aggregates are in [docs/research](research/ljubljana-evidence-results.md).

On five public clinical cases with selective injections, read once by eye, the vessel evidence proposals did not visibly lie on the filled arteries in any case. The centerline distance proposals of the same frames had not either. In two of the five the vessel evidence proposal read as the worse fit of the two, and in one of those part of the projected tree settled on a tube that is not a vessel. In the other three there was no clear difference. The record is in [docs/verification](verification/step-c4-vessel-evidence.md). The method has no way to know which 3D vessels an injection filled. A vessel evidence proposal is a starting point for an operator to correct, and its score is not a sign that it is right.

## The studio

**Angiogram overlay** appears for a case with a verified millimeter source.

1. Enter the frame bundle identifier and open it. Each frame is fetched, checked against its manifest SHA-256 in the browser, and only then drawn.
2. Use the admitted DICOM geometry, or enter angles, distances and field width. Entered values are labelled assumed.
3. Choose the isocenter: the centroid of the vessel mask, or the viewer crosshair.
4. Choose the method. **Centerline distance** is the default. Set vessel polarity, and for centerline distance the sensitivity, and select **Propose overlay**. The projected mask is drawn in cyan. For centerline distance the extracted 2D lines are drawn in amber; **Vessel evidence** extracts none and has no sensitivity. **Larger view** enlarges the figure, and the projected vessels can be hidden to see the frame beneath.
5. Tick the review box and select **Save confirmed proposal**, or discard.

For a bundle with two planes:

1. Choose each plane in turn and set its frame, geometry, polarity and sensitivity. Each plane keeps its own values. Plane B starts at a primary angle of 90 degrees.
2. Tick **Fit one pose to both planes**. The studio names the frame chosen on each plane and the angle between the central rays.
3. Select **Propose two-plane overlay**. Both frames are drawn side by side with the one pose projected over each.
4. Tick the review box and the box stating that both frames show the patient in the same position, then save. Both ticks belong to the proposal on screen and do not carry over to another.

### Best of several starts

With the view network installed, a proposal by vessel evidence is the best of several searches. **Propose overlay** runs the search from the volume's own position and from each view the network proposes for the frame, up to five, and keeps the result with the most vessel evidence under the projected points. With two planes the views proposed for both frames are searched, up to ten, and one turn of the model serves both planes, so the entered angle between them is kept. There is nothing to pick: one press gives one proposal.

The network reads the frame's vessel evidence and proposes views of the head: a primary angle, a secondary angle and an in-plane turn. Each view becomes a start by turning the 3D model, about the centre of its vessel points, until the plane at its entered geometry sees the model as the view says. The entered geometry is not changed. Every start is refined by the same search, and a later start replaces the volume's own position only when its result has more vessel evidence.

The proposal is described against the volume's own position: the distance moved and the angle turned are measured from there, whichever start was kept. The starting scores are those at the volume's own position; where fewer than half the vessel points fall inside a frame there, they are those at the kept start. It is reviewed and saved like any other, under the methods `vessel_evidence_best_start_v1` and `vessel_evidence_best_start_biplane_v1` and record versions 5 and 6, whose fields are those of versions 3 and 4.

The weights are fetched once per page from `GET /api/view-network`, starting when the vessel evidence method is chosen, and checked against a size and SHA-256 fixed in the code before they are used ([their record](research/view-network-v1.md)). The fetch belongs to the page and has its own 30-second deadline; one that fails is tried again at the next proposal. A proposal waits up to 10 seconds for the weights while it reads the mask. Without them, on a server that has no file or on a slow link, the search runs from the volume's own position, under the single-start methods.

On ten public clinical subjects with a reference pose, the two-plane proposal was within 1 mm of the reference in 8 of 10 from the best of several starts and in 7 of 10 from the single start (4 of 5 from both on the five subjects held back), and no two-plane run ended farther from the reference. For a lateral frame whose view was not known, the median error fell from 45.6 mm to 28.5 mm ([results](research/ljubljana-best-start-results.md)).

The search takes longer with more starts, since each start is a full search. **Cancel overlay computation** works throughout.

A proposal belongs to the exact frame or pair of frames, mask, geometry, isocenter, method and filter settings it was computed from. Changing any of them drops it, and restoring them does not bring it back. An unsaved proposal or running computation locks the other studios the same way their own unsaved edits do. During computation its input controls are locked; Cancel remains available. The studio's requests for frames, masks and saved proposals have a 30-second deadline and are aborted when their source scope is discarded. A bundle's manifest request is released before the first-frame fetch starts, giving the frame its own full deadline. A timeout releases the request lock and exposes Reload saved proposal. A timed-out save may already have been stored, so overlay actions remain locked until that explicit read reconciles the saved revision.

## The saved record

One record per case is current, single-plane or two-plane. A single-plane record (`step-c1-projection-registration-v1`) binds the matrix to the case revision, the source revision, the accepted vessel mask (candidate ID and SHA-256) and the frame (bundle ID, manifest revision, plane, index and SHA-256). It stores `validated: false`, the status `operator_confirmed_proposal`, the geometry source (`frame_manifest` or `operator_entered`), and the browser-reported scores labelled `browser_reported_not_recomputed`. The server derives the rotation and the isocenter shift from the matrix itself.

A two-plane record (`step-c2-biplane-registration-v2`) binds one matrix and one isocenter to plane A's frame and plane B's frame of one bundle, in that order. Each plane carries its own view, geometry source, detector scale, filter settings and browser-reported scores. The record stores `same_position_attested: true`, and the server's summary reads `same_position: operator_attested_not_checked` and gives the angle between the central rays, which it derives from the two views. A record's version must be the one its method belongs to. Single-plane records written before Step C2 read unchanged.

A record made by vessel evidence has its own version: `step-c4-evidence-registration-v3` for one plane and `step-c4-evidence-biplane-registration-v4` for two. It carries no sensitivity. Its scores are the mean vessel evidence, the share of points inside the frame and the share of strong evidence left uncovered, and the server's summary names them `mean_vessel_evidence_under_projected_points`. It stores `detector_fit`, and the server and the browser both refuse a record whose fit outcome contradicts what was requested or whose dropped fit changed a size. A two-plane record needs the same attestation. Records of versions 1 and 2 validate, summarize and read back as before. When a saved record is shown, the studio sets the method choice to the record's method and redraws the stored pose with nothing searched or rescored.

Records are append-only. A later case revision makes the record stale, and a stale record is not shown or reused. On every read the server checks that every frame the record names and the mask are still installed with the recorded hashes and reports `verified` or `unavailable`. The studio redraws a saved overlay only after repeating those checks itself.

## Vessel-presence report

Beside a current saved proposal, the studio offers **Vessel presence report**. Computation requires verified evidence and the accepted mask named by that proposal. The report says, for each segment of the accepted vessel mask and each plane of the saved proposal, whether the frame shows a vessel where the segment projects.

It asserts no cause. A segment without 2D support may be occluded, unfilled, outside the injected territory or absent, or the saved proposal may be wrong. The report is only as good as that proposal, which is an operator-confirmed proposal and not a validated registration. On five public clinical cases the proposals did not visibly lie on the filled arteries and the reports there described the misfit, not the anatomy (see the [verification note](verification/step-c3-vessel-presence.md)).

### Segments

The mask is cut into geometric segments (`mask_band_sweep_v1`). Each connected piece of the mask is swept from one end in bands of path distance 2 mm deep (two voxel diagonals on a coarser grid). The runs between branchings and ends are cut into equal pieces of at most 15 mm. An end run shorter than 4 mm is taken into the branching it hangs from. A connected piece of the mask shorter than 6 mm is left out and counted in the share of the mask's volume that is in no segment.

A segment has an index, a length, a mean radius and the number of the unbranched run it was cut from. The mean radius is that of a cylinder of the segment's length holding the mask volume that lies along it. Segments are not named and no artery is identified.

### Classes

Samples every 1 mm along each segment are projected into each plane with the saved pose. A sample is:

- **in the field** when it projects inside the frame;
- **clear** when no sample of another run, and no sample of its own run 6 mm or more away in the volume, projects within 2 mm of it;
- **supported** when it is clear and an extracted 2D centerline lies within 2 mm of it, measured at the isocenter plane.

| Class             | Rule, applied in this order                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| Outside the field | Fewer than half of the segment's samples are in the field                       |
| Indeterminate     | Fewer than three samples are clear, or fewer than 3 in 10 of those in the field |
| 2D support        | At least 7 in 10 of the clear samples are supported                             |
| No 2D support     | At most 3 in 10 of the clear samples are supported                              |
| Indeterminate     | Anything between                                                                |

Pieces of 2D centerline at least 5 mm long with no projected sample within 2 mm are listed separately, longest first. They can be vessels the mask does not hold, and they can equally be catheters, wires or bone edges.

The method is `segment_centerline_support_v1`. The limits are fixed in the code and held identically by the browser and the server; changing one is a new method.

### In the studio

1. Save a proposal by centerline distance, single-plane or two-plane. A report reads the 2D line set that proposal was matched to, at the sensitivity its record states. A proposal by vessel evidence has neither, so the server refuses a report bound to one and the studio says why in place of the action.
2. Select **Compute vessel presence**. Each plane's own saved frame, view, polarity and sensitivity are used. The frame is drawn with the segment axes colored by class: green for 2D support, red for none, yellow for indeterminate, and magenta for the unmatched 2D pieces. A table gives counts and lengths by class per plane, and another lists every segment.
3. Tick the review box and select **Save confirmed report**.

A report belongs to one saved proposal. A new proposal makes the old report stale, and a stale report is not shown.

### The saved report

The record (`step-c3-vessel-presence-v1`) is append-only and names the proposal it was computed with: its identifier, revision and input digest, and each plane's frame hash. It stores `validated: false`, the status `operator_confirmed_report`, `cause: not_asserted` and `counts_source: browser_reported_not_recomputed`.

The report server does not process the frame pixels or mask voxels and cannot recompute the counts. It checks that the counts are possible, that every class follows from its counts under the rule above, that the report names the latest proposal inside the write transaction, and that the proposal's frames and mask are on hand. It refuses anything else. These are consistency checks, not a cryptographic signature: someone with database-write access can rewrite the inputs, digest and summary together. Browser recomputation remains necessary.

When a saved report is read back, the browser recomputes it from the frames, the mask and the saved proposal. It is shown as saved only when every count agrees. Pending or failed recomputation, unavailable evidence, or a different accepted mask withholds the stored counts. A mismatch says the report was not reproduced; any locally computed replacement is marked unsaved. The 30 s deadline bounds the aggregate network-fetch operation, not local mask decoding or computation. A failed automatic check can be retried explicitly.

### In the brief

The local brief gains the section **Angiogram registration and vessel presence**: the proposal's status, revision, method, number of planes and the angle between them, each plane's geometry source, and for a current report the counts and lengths by class per plane. It carries no image, no pose, no coordinates and no fit scores, and it states that the proposal is not a validated registration and that its accuracy is not measured.

## Limits

- Rigid, and one frame per plane. No vessel deformation, cardiac or respiratory motion, or table movement.
- A two-plane proposal assumes both frames show one patient position. That is attested by the operator and not checked.
- On public clinical frames with a reference pose, most two-plane proposals were more than 1 mm from the reference, some were tens of millimeters away, and the score did not tell them apart.
- With one plane, depth along the beam is not determined, and a turn about an in-plane axis only weakly. On the synthetic phantoms the total rotation error reached 7.7 degrees while the in-plane error stayed under 1 degree.
- The search is local. A start more than about 15 degrees from the true view, or a mirrored image, is outside its range.
- A whole-head vessel mask against a single-vessel injection leaves most of each line set without a partner. The capped score tolerates that but does not resolve it. The vessel-presence report lists the segments without a partner, but it cannot say whether they are unfilled or misregistered.
- TAIR-style screen captures have no DICOM geometry. Their angles come from burned-in text and their pixel aspect is not declared.
- The vessel-presence report reads a wrong proposal as missing vessels and unmatched 2D lines. On the five public clinical cases reviewed, that is what it showed. It is not evidence of occlusion, stenosis or absence.
- A vessel seen end-on, or lying over another vessel in the frame, is left indeterminate whatever the frame shows.
- The vessel evidence methods score line-like structure, not vessels. On five public clinical cases with selective injections their proposals did not visibly lie on the filled arteries. Their scores there, 0.11 to 0.25, lie on both sides of the median score of the two-plane runs on the held-back public subjects with a reference pose, 0.19, most of which ended within 1 mm. The score does not tell a right pose from a wrong one.
- The fit of the field size is not solved by either pair of methods. With vessel evidence it was dropped in all five clinical cases reviewed, and on the held-back public subjects with a reference pose 10 of 25 two-plane runs ended under 1 mm when the entered size was wrong.
- A proposal by vessel evidence carries no vessel-presence report.
- Not for live guidance, diagnosis or treatment decisions.
