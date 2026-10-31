# Aneurysm preprocessing review reconciliation

Internal engineering review of fresh orientation/normalization/restoration helpers, not clinical clearance. Independent review `deleg_eed33138` inspected `planner/aneurysm_inference.py`, its analytic tests and the pinned-source adapter contract before the later first-head graph extraction. It reported no blocking bug in that scope and ran 16 analytic tests, deselecting the original-weight forward test. Graph extraction has a separate review; do not extend this verdict to it.

## Closed test gap

The review correctly noted that native restoration tests used logits already matching the native oriented shape, leaving actual downsampling untested. Parent added `test_restore_resizes_224_logits_before_native_orientation`:

- Starts with a coordinate-coded asymmetric native `(3,4,5)` volume under a known axis permutation and flip.
- Uses a real `(1,15,224,224,224)` synthetic logit tensor and independently computes align-corners sampling centers for a known landmark.
- Asserts the complete restored `uint8` array, including the single expected native voxel and zero elsewhere.
- Passes on the actual helper.
- A separate in-memory mutation changing only restoration `align_corners=True` to `False` fails at exactly the expected native landmark. The on-disk implementation was never changed by the mutation trial.

The complete dedicated runtime suite subsequently passed **20 tests** in 4.25 seconds, including separate CPU/MPS graph-equivalence tests and actual original-weight smoke. Ruff and diff checks passed. Those extra tests are parent evidence, not work claimed by the preprocessing reviewer.

## Retained limits and rationale

- Logit interpolation followed by argmax is the chosen fresh adapter contract. It is not generally equivalent to interpolating softmax probabilities and is not evidence that the author's classification-only deployment validates this segmentation return path. The helper docstring now states that distinction.
- A singleton-axis ROI is intentionally refused in the initial 3D adapter instead of silently padded or treated as a complete 3D context. Actual stage-1 handoff semantics and broader ROI support remain separate work.
- The existing asymmetric forward and inverse fixtures plus the new 224-grid sampling test strengthen coordinate evidence; they do not validate patient anatomy, sac/neck measurements or clinical boundary agreement.
- Hand-constructed malformed `AneurysmGrid` objects are not accepted by any product request. Broader internal-constructor validation and multi-blob fixtures remain useful hardening, not prerequisites silently claimed complete here.
- Public inference still uses a reference-selected context crop and preserves unknown source spatial units. Full-head localization, independent performance evaluation and application integration remain open.
