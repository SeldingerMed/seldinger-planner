"""Base server must retain import-only prompt validation without ML dependencies."""

import subprocess
import sys


def test_prompt_module_import_does_not_load_heavy_libraries():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys,planner.sam_refinement; "
                "assert not {'numpy','torch','sam2'}.intersection(sys.modules)"
            ),
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
