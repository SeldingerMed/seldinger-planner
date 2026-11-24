"""Write the raw CTA's source-bound model proposal to stdout as JSON.

Run in the segmentation runtime, with its weight and temporary directories
already configured. Only geometry leaves the worker; the scan and the label
volume are not part of the interchange format.
"""

import argparse
import contextlib
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from planner.aortoiliac_inference import propose_aortoiliac_model_from_cta


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cta", type=Path)
    parser.add_argument("--sha256", required=True, help="expected SHA-256 of the source CTA")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args(argv)
    # Upstream libraries may print progress even when called with quiet=True.
    with contextlib.redirect_stdout(sys.stderr):
        result = propose_aortoiliac_model_from_cta(
            args.cta, expected_sha256=args.sha256, device=args.device
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
