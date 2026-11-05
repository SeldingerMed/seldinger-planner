"""Base API can import the offline preparer without optional imaging libraries."""

import subprocess
import sys


def test_calibrated_context_import_is_lazy_in_base_environment():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys\n"
                "class BlockImaging:\n"
                "    def find_spec(self, fullname, path=None, target=None):\n"
                "        if fullname.split('.')[0] in {'numpy','nibabel','torch'}:\n"
                "            raise ImportError('Optional imaging import blocked')\n"
                "sys.meta_path.insert(0, BlockImaging())\n"
                "import planner.calibrated_context\n"
                "assert not {'numpy','nibabel','torch'}.intersection(sys.modules)\n"
            ),
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode()
