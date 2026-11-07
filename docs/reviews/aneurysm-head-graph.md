# Aneurysm first-head graph review reconciliation

Internal engineering evidence, not whole-model or clinical clearance. Independent read-only review `deleg_8811ab80` inspected `aneurysm_head1_graph` and the pinned original author's forward. It reported no blocking issue for selecting the original merged aneurysm/vessel head. The reviewer did not run weights, images or model tests; actual equivalence and public-case execution are parent evidence.

## Findings accepted

- Original forward has independent decoder branches after shared features. The first returned tensor is the 15-channel merged vessel/aneurysm head; merged aneurysm is channel 14.
- Selecting that output removes the second segmentation branch and unused classification/modality outputs, not missing weights or a substituted architecture.
- The original whole state is strictly loaded before extraction. The extracted graph retains original module/parameter objects, not a frozen deep copy. The helper docstring now explicitly requires immutable evaluation use.
- Owning GraphModule is constructed before dead-code elimination. Unused submodules are removed and the graph is recompiled.
- Parent's seeded 64-cubed CPU and MPS comparisons passed with zero relative and absolute tolerance. The subsequent actual 224-cubed public-ROI inference passed native saved-mask readback under retained resource caps. These are separate tests, not a direct full-resolution comparison against the original memory-exceeding full forward.

## Corrections to the returned reasoning

1. `concrete_args={"only_forward_cls": False}` chooses the full-forward branch, but does not itself make classification computation dead. In the original source, classification is computed before that conditional. It becomes unused after selecting only `r_1` and is removed by dead-code elimination.
2. `call_module` nodes are not categorically effectful or immune from removal. Parent checked actual installed PyTorch 2.12 `torch/fx/node.py::Node.is_impure`: it returns the module's `_is_impure` flag, default false. Safety here depends on this specific original eval graph and its dataflow, not that incorrect general claim. Discarded heads do not mutate shared encoder features; decoder `torch.cat` constructs new tensors before in-place activations act on branch-local intermediates. Numerical comparisons independently support the inspected case.
3. Class-name leaf matching is acceptable only within the installer-selected original network. A future generic graph-extraction API would require exact class identity and stronger impurity/alias checks. No such generic product API is exposed.

## Follow-on integration boundary

Parent added a fixed `predict_aneurysm(image_xyz, affine, *, checkpoint_path)` wrapper and observed missing-function RED then real original-weight MPS synthetic GREEN. It preserves the same memory cap, performs fresh preprocessing and native restoration, and returns explicit unaccepted/nonclinical/selected-context provenance with no fabricated classification probability. The dedicated suite passed 21 tests at that point.

Product worker, ledger/API and UI extension are defined in `../plans/aneurysm-case-integration.md` with isolated writer scopes. Their tests and actual end-to-end browser path remain separate gates. The original public source's unknown units still block millimeter measurement/sizing. No merge, deployment, clinical validation or independent full-head localization claim follows from this review.
