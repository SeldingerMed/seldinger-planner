"""Actual API→fixed numerical worker→confirmation→geometry, synthetic source only."""

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_MODEL_TESTS") != "1":
    pytest.skip("Requires optional imaging and API runtimes", allow_module_level=True)

from test_anatomy_worker import _install_fixtures

ROOT = Path(__file__).resolve().parents[2]

API_TRACER = r"""
import json, sys
from pathlib import Path
from fastapi.testclient import TestClient
from planner.server import build_app
from planner.segmentation_state import SegmentationLedger
source, fixture, db, result_root = map(Path, sys.argv[1:])
data = json.loads(fixture.read_text())
client = TestClient(build_app(db, inference_results_dir=result_root))
case = client.post('/api/cases', json={'title':'Synthetic default anatomy tracer',
    'image_sha256':data['image_sha256'],'dimensions':data['shape'],
    'spacing_mm':[1,1,1],'spatial_units':'mm'}).json()
ledger = SegmentationLedger(db)
for role, producer in [('vessel','rsna_vessel_model'),('aneurysm','aneurysm_model')]:
    entry = ledger.preview(case['case_id'], case['artifact_version'],
        reference_revision=data['reference_revision'], producer=producer, role=role,
        mask_sha256=data['masks'][role]['mask_sha256'], provenance={'synthetic_fixture':True})
    ledger.decide(case['case_id'],entry['candidate_id'],case['artifact_version'],'accept')
    case = client.get('/api/cases/'+case['case_id']).json()
base = '/api/cases/'+case['case_id']
body = {'artifact_version':case['artifact_version'],'reference_revision':data['reference_revision']}
proposal_response = client.post(base+'/anatomy-proposal',json=body)
assert proposal_response.status_code == 200, proposal_response.text
proposal = proposal_response.json()
assert client.get(base+'/morphometry').json()['operator_inputs'] is None
assert client.get(base).json()['artifact_version'] == case['artifact_version']
saved = client.put(base+'/morphometry-inputs', json={**body, 'inputs':proposal['proposal']['inputs']})
assert saved.status_code == 200, saved.text
body['artifact_version'] = saved.json()['artifact_version']
computed = client.post(base+'/morphometry',json=body)
assert computed.status_code == 200, computed.text
geometry = computed.json()
assert geometry['current']['status'] == 'current'
assert geometry['current']['result']['sac']['volume'] > 0
assert geometry['current']['result']['neck']['area'] > 0
print(json.dumps({'proposal':proposal,'confirmed_geometry':geometry}))
"""


def test_default_runtime_proposal_confirm_compute_roundtrip(tmp_path):
    import hashlib

    source_path, blobs, image, masks = _install_fixtures(tmp_path)
    installed_root = ROOT / ".runtime/installed-sources"
    installed_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Exact created directory, never a cleanup glob over a shared source root.
    owned = Path(tempfile.mkdtemp(prefix="phase5-synthetic-", dir=installed_root))
    try:
        shutil.copyfile(source_path, owned / "context-cta.nii.gz")
        manifest = {
            "clinical_validation": False,
            "image": {
                **image,
                "filename": "context-cta.nii.gz",
                "spatial_units": "mm",
                "bytes": source_path.stat().st_size,
            },
            "source_provenance": {"data_scope": "synthetic", "permitted_use": "local tests"},
        }
        raw = json.dumps(manifest, sort_keys=True).encode()
        (owned / "manifest.json").write_bytes(raw)
        fixture = tmp_path / "fixture.json"
        fixture.write_text(
            json.dumps(
                {
                    "image_sha256": image["sha256"],
                    "shape": image["shape_xyz"],
                    "reference_revision": hashlib.sha256(raw).hexdigest(),
                    "masks": masks,
                }
            )
        )
        env = {
            key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR") if key in os.environ
        }
        env["PYTHONPATH"] = str(ROOT)
        result = subprocess.run(
            [
                str(ROOT / ".venv/bin/python"),
                "-c",
                API_TRACER,
                str(owned),
                str(fixture),
                str(tmp_path / "workspace.sqlite3"),
                str(blobs.parent),
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        receipt = json.loads(result.stdout)
        assert isinstance(receipt["proposal"]["proposal"]["dependencies"], dict)
        assert receipt["proposal"]["proposal"]["diagnostics"]["grid_shape"] == image["shape_xyz"]
        assert receipt["confirmed_geometry"]["current"]["result"]["spatial_units"] == "mm"
        (tmp_path / "default-path-receipt.json").write_text(json.dumps(receipt, indent=2))
    finally:
        assert {path.name for path in owned.iterdir()} <= {"manifest.json", "context-cta.nii.gz"}
        shutil.rmtree(owned)
    assert not owned.exists()
