"""The offline source-context module stays importable in the API runtime."""

import os
import subprocess
import sys
from pathlib import Path


def test_source_context_import_does_not_load_optional_imaging():
    root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.pop("PYTHONHOME", None)
    env["PYTHONPATH"] = str(root)
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import builtins
import sys
original = builtins.__import__
def without_imaging(name, *args, **kwargs):
    if name.split('.')[0] in {'numpy', 'nibabel', 'scipy', 'torch', 'SimpleITK'}:
        raise ImportError('optional imaging deliberately unavailable')
    return original(name, *args, **kwargs)
builtins.__import__ = without_imaging
from planner.source_context import prepare_source_context
assert callable(prepare_source_context)
assert not {'numpy', 'nibabel', 'scipy', 'torch', 'SimpleITK'}.intersection(sys.modules)
print('source_context imports without optional imaging')
""",
        ],
        check=False,
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "source_context imports without optional imaging"
