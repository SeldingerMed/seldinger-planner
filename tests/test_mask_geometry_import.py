"""Base runtime must import the mask geometry module without heavy libraries."""

import subprocess
import sys


def test_mask_geometry_import_does_not_load_heavy_libraries():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys,planner.mask_geometry; "
                "heavy={'numpy','scipy','skimage','torch'}; "
                "loaded=heavy.intersection(sys.modules); "
                "assert not loaded, loaded"
            ),
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
