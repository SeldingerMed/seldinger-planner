# View network v1: what the file is and how it was made

The record that goes with the one weights file the planner serves at `GET /api/view-network` (fusion Step C4 part 4, acceptance criterion 8). The file is not in this repository.

## Use

Internal research only. The network was trained on synthetic projections of artery masks that their owners release for academic research use only, under restricted access. The weights are not cleared for commercial use, are not distributed, and are no part of a product. Its proposed views are for an operator to pick from or to ignore, and are not for clinical use.

## The file

|               |                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name          | `view-network.bin`                                                                                                                                         |
| Format        | `seldinger-view-network-v1` (magic `SLDVIEW1`), batch normalization folded in                                                                              |
| Size          | 7,097,120 bytes                                                                                                                                            |
| SHA-256       | `1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56`                                                                                         |
| Fixed in code | `planner/model_assets.py` (`VIEW_NETWORK`) and `web/src/viewNetworkFile.ts` (`VIEW_NETWORK_FILE`); `tests/test_view_network_server.py` holds the two equal |
| Read from     | `.runtime/models/view-network-v1/view-network.bin`                                                                                                         |

The server verifies the size and hash on every read and serves nothing else. The browser checks them again before it parses the bytes. A request names no file and no hash. Bytes of another size or hash are refused on both sides, and a server with no file answers that the network is not installed.

`.runtime/` is not tracked. On the development machine `.runtime/models/view-network-v1` is a link to the training run's folder on the external volume, so no copy of the weights is written to the internal disk. The file itself must be a regular file: a link in its place is refused.

## How it was made

|                   |                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code              | commit `c9e01d286c63f7121c2a2994b027dfab37a0be62`, no uncommitted changes (`scripts/research/pose_initializer/`)                                                  |
| Training run      | one run on 2026-11-18: 30 epochs, batch 256, learning rate 0.002, weight decay 0.01, seed 1, PyTorch 2.15.0 on Apple MPS                                          |
| Checkpoint        | epoch 12, chosen on the validation frames only                                                                                                                    |
| Training frames   | 101,200 synthetic frames from 253 vessel models, 400 per model, generation seed 1                                                                                 |
| Validation frames | 3,400 synthetic frames from 34 other vessel models                                                                                                                |
| Input             | vessel evidence of one frame on a 128 by 128 grid at blur levels 8 px and 2 px                                                                                    |
| Frame settings    | primary within 125 degrees, secondary within 55 degrees, in-plane turn within 25 degrees; frame sides 320 to 640 px; injection modes all 0.2, cell 0.5, spill 0.3 |

At the chosen epoch, on the validation frames: the first proposal within 15 degrees of the true view in 59.7%, one of the five in 88.2%.

## Training volumes and licences

|                                    |                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Source                             | COSTA TOF-MRA vessel masks, Zenodo record 11025761                                                                                     |
| Licence as recorded for every case | academic research use only, restricted access (checked against the Zenodo record on 2026-11-20)                                        |
| Cases read                         | 355                                                                                                                                    |
| Vessel models kept                 | 344: 253 for training, 34 for validation, 57 held out for the gate                                                                     |
| Left out                           | 11, whose orientation the two indicators did not settle                                                                                |
| Prepared by                        | commit `323b055b8524fd166b5cb856a2698d702d84fe77`; manifest SHA-256 `5bb42cb390faa00fccb835f57f3950635e080fb4bb7210792cf143b2faf54cd3` |

The manifest lists every case with the SHA-256 of its source mask and of its vessel model, and stays on the external volume with the models, the frames and the training log. No Ljubljana and no TAIR frame or volume was used for training or for choosing the checkpoint.

## What is known about it

- Synthetic gate, on 2,280 frames from the 57 held-out vessel models: one of the five proposals within 15 degrees in 88.4%, the first in 63.1%.
- Ljubljana, ten held-back frames, one protocol run: the first proposal within 15 degrees in 4, one of the five in 7. See [the results page](ljubljana-view-initializer-results.md).
- TAIR, five fixed cases, one reading: see `docs/verification/step-c4-view-proposals.md`.

On real frames the first proposal is often not the nearest of the five. The studio says so beside the control.
