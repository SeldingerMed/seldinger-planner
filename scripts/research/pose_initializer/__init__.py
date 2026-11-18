"""Research code for the learned view initializer (Step C4 part 4).

Nothing here is imported by the planner. Training reads public vessel masks
from external storage and writes every output back to external storage; see
``storage.py``. The plan and its acceptance criteria are in
docs/plans/fusion-step-c4.md.

Run a module from the repository root with ``scripts/research`` on the path:
  PYTHONPATH=scripts/research <python> -m pose_initializer.<module> ...
"""
