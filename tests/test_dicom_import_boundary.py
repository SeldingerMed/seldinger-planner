"""The optional converter must not import imaging dependencies into the API."""

import os
import subprocess
import sys
from pathlib import Path


def test_dicom_cli_module_import_remains_lightweight():
    root = Path(__file__).resolve().parents[1]
    code = (
        "import sys;sys.path.insert(0,"
        + repr(str(root))
        + ");import planner.dicom_ingest;assert not {'numpy','pydicom','nibabel'}&set(sys.modules)"
    )
    env = {k: v for k, v in os.environ.items() if k not in {"PYTHONPATH", "PYTHONHOME"}}
    result = subprocess.run(
        [sys.executable, "-I", "-c", code],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr
