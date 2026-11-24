# Aorta and iliac centerlines from an existing vessel outline: held-back results

Protocol: `docs/research/aortoiliac-mask-held-back-protocol.md`, frozen at `0461773dd9ea460c90902ec8cc9f6f70a1ce6cab`. Each cohort had one run, with no retries, on 2026-11-24. The figures below are copied from that run's records on board task `t_1f39cc7d`, as reported there. Nothing here was rescored.

## Run

- The run used one supercomputer.sh A10G session (`s-c86a3e3d`, process `proc-24-3-dn3h2xt9ro53`). It exited 0 after 574 s and cost $0.15.
- All four inputs matched their protocol SHA-256 and byte counts in the provider's store and again on the worker.
- Rows: TotalSegmentator held-back 146, AVT held-back 28, AVT design 28. Subject order equals the manifest groups, every subject is unique, and the design and held-back groups do not overlap.
- Every row's code digest equals the frozen commit's files. TotalSegmentator: `0af4cc41…f0f9`. AVT: `3415021c…f9b3`.
- Results archive: `eee11264b94851b81cd0a7bd9f6ec2c23e9b5cfe3ba0392628f2f0a9d8aa619e`, 203,232 bytes. It is kept in the closed session's cloud store and was not written to the research drive, which was under its 40 GiB free-space floor.

## TotalSegmentator held-back: left and right iliac names are real labels

| Measure                                                            | Result                                      |
| ------------------------------------------------------------------ | ------------------------------------------- |
| Eligible cases (both iliac labels meet the aorta)                  | 58                                          |
| Named and sided correctly, over every eligible case                | 49 of 58                                    |
| Split within 10 mm of the labelled split, over every eligible case | 48 of 58                                    |
| Distance to the labelled split, among returned splits              | median 3.87 mm, worst 10.3 mm (49 returned) |
| Scans with no iliac label, aorta returned alone                    | 49 of 49                                    |
| Partial / no aorta label / unreadable / refusals                   | 21 / 18 / 0 / 0                             |

## AVT: whole-tree consistency only

AVT does not label the iliac arteries by name, so these figures are a consistency check. They do not show that the anatomical bifurcation was found.

| Measure                                              | Held-back (even subjects)        | Design (odd subjects), corrected scorer |
| ---------------------------------------------------- | -------------------------------- | --------------------------------------- |
| Cases                                                | 28                               | 28                                      |
| Splits proposed / aorta alone / refused              | 21 / 7 / 0                       | 23 / 5 / 0                              |
| Mask separation found                                | 20 of 21                         | 23 of 23                                |
| Split within 10 mm vertically of the mask separation | 20 of 21 splits (20 of 28 cases) | 22 of 23                                |
| Median / greatest absolute difference                | 1.56 / 4.03 mm                   | 1.41 / 52.14 mm                         |
| Endpoint ordering                                    | 21 of 21                         |                                         |

Development comparison from the protocol: on the TotalSegmentator design run, 366 of 398 cases were named correctly and 362 of 398 were within 10 mm.

These are descriptive figures from a frozen held-back measurement. They are not a clinical validation.
