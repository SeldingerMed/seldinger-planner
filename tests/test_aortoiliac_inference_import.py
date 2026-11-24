"""Base runtime must import the aortoiliac inference adapter without heavy libraries."""

import subprocess
import sys


def test_aortoiliac_inference_import_does_not_load_heavy_libraries():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys, planner.aortoiliac_inference; "
                "heavy = {'numpy', 'scipy', 'nibabel', 'skimage', 'torch', 'totalsegmentator'}; "
                "loaded = heavy.intersection(sys.modules); "
                "assert not loaded, loaded"
            ),
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
