# Angiogram overlay and 2D-to-3D registration proposal (fusion Step C1)

Step C1 lays the accepted 3D vessel mask of a case over one acquired angiographic frame. It adds four things:

1. Admission of a few angiographic pixel frames as their own bounded, hash-bound store.
2. A browser engine that proposes a rigid pose for the volume under the Step A camera.
3. An overlay studio where an operator reviews the proposal and confirms it or discards it.
4. An immutable record of each confirmed proposal.

Everything here is retrospective. No live video is read. A proposal is not a validated registration and no accuracy is claimed for it. The angle convention is the one Step A declares (`dicom_xa_patient_longitude_latitude_ras_v1`), which has not been verified against a vendor system, a detector rotation or an image flip.

Step C2 will add the vessel-presence report, joint refinement across two planes, a brief section and an evaluation against data with a known pose. None of that is in C1.

## Frame admission

Step A's projection manifest keeps acquisition geometry and no pixels. That is unchanged. Pixel frames are a second, separate source kind with their own store under `.runtime/installed-frames/<source-id>/`.

Bounds:

| Quantity | Bound |
|---|---|
| Planes per bundle | 1 or 2 (`single`, or `a` and `b`) |
| Frames per plane | 1 to 8 |
| Stored frame side | 64 to 1024 pixels |
| Source frame side | at most 4096 pixels |
| Redaction rectangles per plane | at most 16 |
| Frame index | 0 to 1,000,000 |
| Manifest | at most 64 KiB |

A stored frame is raw row-major 8-bit grayscale, where a larger byte is a brighter display pixel. The manifest (`frames.json`) records, per frame, its index in the source, the SHA-256 of the stored bytes and the SHA-256 of the file it came from. No name, date, device or other source metadata is retained. The manifest revision is the SHA-256 of its exact bytes.

### Deidentification

The rule from Step A carries over and becomes a gate, because pixels are now kept:

- A DICOM XA object whose Burned In Annotation (0028,0301) is `NO` is admitted on that declaration.
- Any other input needs `identifiers_removed: true` in the request. That is the operator's attestation that the recorded crop and redaction rectangles removed every identifier. PNG frames carry no tag, so they always need it.

Redaction rectangles are blanked first, in source pixel coordinates, and the crop is applied after. Both are recorded in the manifest. The command cannot see whether text remains. The attestation is the operator's, and the studio shows which basis a plane was admitted on.

### Geometry

A DICOM plane keeps its acquisition geometry only when Step A's converter calls it calibrated and no crop was applied, because a crop moves the image center off the central ray. Every other plane has no geometry, and the operator enters it in the studio, where it is labelled assumed.

Two planes in one bundle are linked by operator declaration only. C1 registers one plane at a time.

### Commands

Frames of a video are extracted outside the app. The app has no video decoder.

```sh
python3 scripts/extract_angio_frames.py RUN.mp4 OUT_DIR --frames 120 133
```

This calls ffmpeg once per frame and writes 8-bit grayscale PNGs with container metadata stripped, a `request.template.json`, and an `extraction.json` with the video and frame hashes. If ffmpeg is not on `PATH`, the helper downloads the static build packaged in the `imageio-ffmpeg` 0.8.1 wheel for the current platform from PyPI, checks it against a SHA-256 pinned in the script, confirms it runs, and installs it under `.runtime/tools/`. `--no-download` refuses the download. An ffmpeg already on `PATH` is used as it is; the pin covers only the build the helper downloads. Pinned builds exist for macOS (arm64, x86_64), Linux (x86_64, aarch64) and Windows (AMD64).

Extraction deliberately decodes from the start to each requested frame index, at most eight times, with a 600-second timeout per call. This preserves exact frame-number selection without assuming constant frame rate or a seek-to-frame mapping. Repeated decoding can be slower on long clips; a single-pass optimization is deferred. On the already used 4,650-frame TAIR clip, extraction of eight spread-out frames took 1.18 seconds locally.

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

| Route | Purpose |
|---|---|
| `GET /api/projection-frames/{source_id}` | The validated manifest and its revision |
| `GET /api/projection-frames/{source_id}/planes/{plane}/frames/{index}` | One frame's bytes, with `X-Frame-Manifest-Revision` |
| `GET /api/cases/{case_id}/projection-registration` | The saved proposal for the case, if any |
| `PUT /api/cases/{case_id}/projection-registration` | Save an operator-confirmed proposal |

The frame routes are read-only and re-verify every frame against its manifest digest before serving it. Nothing accepts pixels: the `PUT` body holds identifiers, hashes, six view numbers, a 4 by 4 matrix and scalar scores.

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

## The studio

**Angiogram overlay** appears for a case with a verified millimeter source.

1. Enter the frame bundle identifier and open it. Each frame is fetched, checked against its manifest SHA-256 in the browser, and only then drawn.
2. Use the admitted DICOM geometry, or enter angles, distances and field width. Entered values are labelled assumed.
3. Choose the isocenter: the centroid of the vessel mask, or the viewer crosshair.
4. Set vessel polarity and sensitivity, and select **Propose overlay**. The projected mask is drawn in cyan and the extracted 2D lines in amber. **Larger view** enlarges the figure, and the projected vessels can be hidden to see the frame beneath.
5. Tick the review box and select **Save confirmed proposal**, or discard.

A proposal belongs to the exact frame, mask, geometry, isocenter and filter settings it was computed from. Changing any of them drops it, and restoring them does not bring it back. An unsaved proposal or running computation locks the other studios the same way their own unsaved edits do. During computation its input controls are locked; Cancel remains available. Network operations have a 30-second deadline and are aborted when their source scope is discarded. A timeout releases the request lock and exposes Reload saved proposal. A timed-out save may already have been stored, so overlay actions remain locked until that explicit read reconciles the saved revision.

## The saved record

One record per case is current. It binds the matrix to the case revision, the source revision, the accepted vessel mask (candidate ID and SHA-256) and the frame (bundle ID, manifest revision, plane, index and SHA-256). It stores `validated: false`, the status `operator_confirmed_proposal`, the geometry source (`frame_manifest` or `operator_entered`), and the browser-reported scores labelled `browser_reported_not_recomputed`. The server derives the rotation and the isocenter shift from the matrix itself.

Records are append-only. A later case revision makes the record stale, and a stale record is not shown or reused. On every read the server checks that the frame and the mask are still installed with the recorded hashes and reports `verified` or `unavailable`. The studio redraws a saved overlay only after repeating those checks itself.

## Limits

- Rigid, single plane, single frame. No vessel deformation, cardiac or respiratory motion, or table movement.
- Depth along the beam is not determined, and a turn about an in-plane axis only weakly. On the synthetic phantoms the total rotation error reached 7.7 degrees while the in-plane error stayed under 1 degree.
- The search is local. A start more than about 15 degrees from the true view, or a mirrored image, is outside its range.
- A whole-head vessel mask against a single-vessel injection leaves most of each line set without a partner. The capped score tolerates that but does not resolve it. C2's vessel-presence report addresses it.
- TAIR-style screen captures have no DICOM geometry. Their angles come from burned-in text and their pixel aspect is not declared.
- Not for live guidance, diagnosis or treatment decisions.
