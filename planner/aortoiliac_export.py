"""Write the raw CTA's source-bound model proposal to stdout as JSON.

Run in the segmentation runtime, with its weight and temporary directories
already configured. Only geometry leaves the worker; the scan and the label
volume are not part of the interchange format.

``--weights DIR`` runs the installed TotalSegmentator ``total`` 3 mm weights
in DIR in memory (``planner.aortoiliac_nnunet``), checked against their pinned
digests, in place of the TotalSegmentator wrapper. The backend and digests
are named on stderr.
"""

import argparse
import contextlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from planner.aortoiliac_inference import propose_aortoiliac_model_from_cta
from planner.aortoiliac_nnunet import installed_weights_runner


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cta", type=Path)
    parser.add_argument("--sha256", required=True, help="expected SHA-256 of the source CTA")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--weights", type=Path, help="installed total 3 mm weight folder")
    parser.add_argument("--threads", type=int, help="CPU threads, with --weights")
    args = parser.parse_args(argv)
    if args.threads is not None and args.weights is None:
        parser.error("--threads applies only with --weights")
    if args.threads is not None and args.threads < 1:
        parser.error("--threads must be at least 1")
    runner = None
    # Upstream libraries may print progress even when called with quiet=True.
    with contextlib.redirect_stdout(sys.stderr):
        if args.weights is not None:
            runner = installed_weights_runner(
                args.weights,
                device=args.device,
                threads=4 if args.threads is None else args.threads,
            )
            print(json.dumps({"backend": runner.backend}), file=sys.stderr)
        result = propose_aortoiliac_model_from_cta(
            args.cta, expected_sha256=args.sha256, device=args.device, runner=runner
        )
    envelope = {
        key: result[key]
        for key in (
            "source_sha256",
            "method",
            "spatial_units",
            "operator_confirmation_required",
            "proposal",
        )
    }
    print(json.dumps(envelope, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
