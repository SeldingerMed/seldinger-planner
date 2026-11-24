# Step E part 2: the CT coronary tree matched to the same patient's cine, results, 2026-11-24

Branch `feat/fusion-e-cta-correspondence`. Plan and ledger: `docs/plans/fusion-step-e-correspondence.md`. Method `ct_tree_cine_correspondence_v1` (`web/src/coronaryCorrespondence.ts`), heart period `cine_heart_period_v2` (`web/src/cardiacPeriod.ts`).

**No measurement of CT-to-angiogram correspondence on the same patient exists yet.** No openly licensed set holding a patient's coronary CT and the same patient's invasive cine was found (section 6). Every correspondence figure below is on cines with known truth: the synthetic tracer, and cines rendered from real CT coronary anatomy. These check the engine and the product path. They are not registration accuracy on patients. The heart-period figures are on real angiograms without ECG, so they have no truth either. Tracking and correspondence figures are reported apart.

## 1. The operator path in the studio (synthetic tracer, known truth)

The unchanged app was served from a RAM disk (`127.0.0.1:5173`, every store on the RAM disk) with a production build of this branch, and driven in Chrome through the operator's own controls: open the case's CT, see the admitted CT tree (5 branches, curated annotation, CT phase 75 percent, bound to the scan by digest), load a cine bundle made by `planner.cine_bundle` from a JPEG Lossless DICOM cine of the tracer, state the pair, propose, replay, confirm, reload.

- Proposal: heart period 846 ms (true 860 ms), CT phase matched on frame 48, fit 0.95 against 0.14 before the search. All five CT branches named and matched under their CT names.
- Replay against truth, every frame (5 branches by 64 frames): mean distance from the true course, median 0.47 px, 95th percentile 1.12 px, maximum 1.66 px (0.8 mm per pixel). The same branches held still at the phase frame: median 5.12 px, 95th percentile 15.23 px. All five branches drawn on 64 of 64 frames.
- Confirmed and saved (record revision 2 on this run), and shown again from the server after a reload of the case.
- Refusals seen in the same studio session, each with its own message: a tree from another scan (not admitted), a file that is not a bundle, a cine with only a display rate, a cine taken while the C-arm moved, and a pair stated for another cine.

The same path runs in `web/src/CoronaryCorrespondencePanel.test.tsx` on every commit.

## 2. Cines from real CT coronary anatomy: own tree and other patients' trees

`web/src/research/coronaryCorrespondence.eval.ts`. Left coronary centerlines of ImageCAS-X version 2 (Zenodo 10.5281/zenodo.23562647, CC BY 4.0), read from the release zip in memory by `scripts/research/imagecasx_tree.py`. Each case's tree is moved by the tracer's beat and breathing and projected through its C-arm. Each cine is then offered its own tree and three trees of other patients (the next case's, the tracer's, and a synthetic second patient's).

**The fault this found.** On the five design cines, before the change below, the engine proposed the tracer tree on all five. Those proposals were 12.8 to 46.7 px off the truth (median per case). The fit (mean vessel evidence along the lined-up tree) was 0.53 to 0.72, above the 0.5 floor: a dense real tree gives a foreign tree enough vessel to lie along.

**The change.** The tree must fit the frame at least `min_mirror_margin` 0.25 better than the best of its own two mirror images (reflected across the detector axes through its centre, each searched over the same poses). A mirror image keeps the tree's lengths and bends but not its shape, so a frame that holds it about as well does not pin the tree. Otherwise the refusal is `tree_not_distinct`. The margin was set on the design cases only (own trees led their mirror images by 0.41 to 0.56; foreign trees that passed the fit floor led theirs by at most 0.13).

| Split (cases) | Own tree proposed | Own branches matched | Followed error, median / p95 px | Held still, median / p95 px | Foreign trees refused |
| --- | ---: | ---: | ---: | ---: | ---: |
| Design (190, 878, 844, 80, 686) | 5 of 5 | 26 of 27 (1 not found) | 0.40 / 1.65 (n 1664) | 5.07 / 16.94 | 15 of 15 |
| Held out, one run (10 cases) | 10 of 10 | 55 of 56 (1 not found) | 0.33 / 3.41 (n 3520) | 5.27 / 16.81 | 29 of 30 |

Held-out run under `docs/research/step-e-correspondence-heldout-protocol.md`, committed (`0183081`) before any held-out case was read. Cases: ImageCAS-X `filelist/test.txt` lines 5 to 14 (87, 789, 448, 625, 954, 580, 85, 368, 806, 88).

- Foreign refusals: 16 `tree_not_distinct`, 13 `tree_not_found`. **One failure:** case 87's tree was proposed on case 88's cine (fit 0.707, mirror image 0.418, margin 0.289 over the 0.25 gate). The image check alone does not exclude every other patient's tree. The operator's stated pair, bound on the server to the tree's digest and the cine's SHA-256, remains the identity check; the fit gates are a second line.
- Own-tree margins over the mirror images on the held-out cases: 0.39 to 0.60. The two branches not found (878's LM, 368's D1) are reported as not found, not forced.
- Per-case followed error, 95th percentile, ranged 0.74 to 6.81 px; the highest were 806 (6.81), 580 (4.68) and 87 (4.01).

## 3. The heart period on real angiograms (no ECG, no truth)

CardioSYNTAX (Hugging Face `MesserMMP/coronary-angiography-syntax`, CC BY 4.0), held-out studies 16 onward of `philips_97` and `siemens_20`, under `docs/research/step-e-period-heldout-protocol.md` (committed `6d69b86` before the run). Frozen code `d9ea216`.

| Measure | Result |
| --- | --- |
| Cines decoded | 87 of 87 studies (82 explicit little endian, 4 implicit little endian, 1 JPEG Lossless; all decoded) |
| Period read, `cine_heart_period_v2` | 74 of 87 (13 refused: no rhythm) |
| Period read, PR #27 tracker on the same frames | 15 of 87 |
| Both read, within 10 percent of each other | 10 of 15 |
| Both halves of the cine read, agreeing within 10 percent | 7 of 23 |
| Whole-cine period within 10 percent of both halves | 2 of 23 |
| A still tree scores higher on frames of the same phase | 33 of 74, median ratio 1.00 |
| Periods read | median 857 ms, range 545 to 1405 ms |

By maker: Philips 70 of 82 read (tracker 15), Siemens 4 of 5 (tracker 0). Philips cines are a median 3.0 s long, Siemens 5.3 s.

Coverage rose from 15 to 74 of 87 without forcing a period: 13 cines are refused. Whether the periods are right is not established: the halves seldom agree, and the still-overlay phase check is at chance. Most of these cines last 2 to 4 seconds, and none holds an ECG. On the design studies (1 to 15) the same method read 21 of 30, against the tracker's 4.

**Protocol note.** The held-out command was invoked three times at the frozen commit: the first discarded its output unread, the second printed the figures above, the third was stopped before any summary printed. No code or constant changed between them, and the method is deterministic.

## 4. Real cines with a CT tree of another patient

Four CardioSYNTAX design cines (studies 1 and 2 of each holdout), converted to bundles by the product converter. There is no CT of these patients. The tracer tree and ImageCAS-X case 190's tree were offered on each with the pair forced, as a foreign-pair check:

- No proposal on any of 8: 6 `tree_not_found` (fit 0.28 to 0.39), 2 `period_not_read` (one cine, 31 frames).
- The same four cines through the studio panel with the tracer tree: 3 `tree_not_found`, 1 `period_not_read`. This run was on the build before the mirror gate, which can only add refusals.

This is a check that a foreign tree is refused on a real angiogram. It says nothing about accuracy on a true pair.

## 5. Native formats

The product converter decodes JPEG Lossless (process 14) cines through GDCM 3.2.6: the 7 design cines PR #27 could not read, and the one in the held-out set. The decode is exact against the reference decode on the tracer's JPEG Lossless cine.

## 6. Paired CT and cine of the same patient: none open

| Source | What it holds | Same-patient CT and invasive cine | Access |
| --- | --- | --- | --- |
| ICADD (medRxiv 10.1101/2023.05.13.23289934) | 70 patients: CCTA, ICA, invasive FFR | Yes | From the corresponding author on request; "may require a sub-contract for data access or service fee" |
| Tongji paired coronary CTA and XRA (arXiv 2505.24351) | Paired CTA and XRA | Yes | No data availability statement |
| 2D-3DCoronary (GitHub xxsxxsxxs666) | Code; clinical and simulated data | Not released | Academic use only, property of United Imaging Intelligence |
| AutoCAR (Zenodo 10.5281/zenodo.15004537) | 21 real cases of two-view angiography video with camera poses; ImageCAS surfaces | No CT for the real cases | CC BY-NC-ND 4.0 |
| CardioSYNTAX | Invasive cine DICOM | No CT | CC BY 4.0 |
| ImageCAS, ImageCAS-X, ASOCA | CT only | No cine | Open |
| MultiD4CAD | CT and clinical variables | No cine | Restricted |

The first artifact that would turn the figures above into a same-patient measurement is ICADD's paired CCTA and ICA DICOM, which needs a data request to its authors and possibly an agreement or fee.

## Reproduce

From `web/`, each printing to standard output only:

```
ICX_ZIP=<ImageCAS-X_dataset_v2.zip> CINE_PYTHON=$PWD/../.runtime/ingest-runtime/bin/python ICX_SPLIT=design \
  npx vitest run --config vitest.research.config.ts src/research/coronaryCorrespondence.eval.ts
CINE_SET=<CardioSYNTAX directory> CINE_PYTHON=$PWD/../.runtime/ingest-runtime/bin/python CINE_SPLIT=design \
  npx vitest run --config vitest.research.config.ts src/research/cardiacPeriod.eval.ts
```

The held-out splits are spent and are not to be run again.

After the held-out runs, review changed the engine without changing a result: a cine whose frames at the CT's phase hold no vessels is refused (`no_vessels_at_phase`) where it used to end in an error, and the heart period read runs in slices. The design replays of both evaluations gave the same output after the change as before it, every field but run time.

Known limitation of `ct_tree_cine_correspondence_v1`, left as frozen: when two branches contest one vessel, the distance that decides between them pairs the branch's points by order after dropping points that fall off the detector, under two different poses. On a tree that straddles the detector edge the pairing can shift by a point. Every tree in the gated tests and both evaluations lies wholly in frame, so no figure above is affected. A later version should pair by CT point index.
