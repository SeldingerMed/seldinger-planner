"""Physical sorting must be independent of collected-file order, on every OS."""

from __future__ import annotations

import importlib.util
import io
import os
from pathlib import Path

import pytest

if os.environ.get("SELDINGER_RUN_INGEST_TESTS") != "1":
    pytest.skip("Requires isolated ingest runtime", allow_module_level=True)


def test_arbitrary_collection_order_preserves_exact_affine_and_voxels(tmp_path, monkeypatch):
    import nibabel as nib
    import numpy as np
    import pydicom

    import planner.dicom_ingest as di
    from planner.image_source import InstalledNiftiSourceStore

    spec = importlib.util.spec_from_file_location(
        "ordering_declared_fixture", Path(__file__).with_name("test_dicom_ingest.py")
    )
    assert spec is not None and spec.loader is not None
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    order = [5, 4, 0, 1, 3, 2]
    assert sorted(order) == list(range(fixture.SLICES))
    assert order[0] != 0 and order != list(reversed(range(fixture.SLICES)))
    source = tmp_path / "series"
    source.mkdir()
    for k in reversed(order):
        pydicom.dcmwrite(
            source / f"frame-{k}.dcm", fixture._make_slice(k), enforce_file_format=True
        )

    collect = di._collect_input_files
    observed = []

    def index(blob):
        dataset = pydicom.dcmread(io.BytesIO(blob), stop_before_pixels=True)
        return int(str(dataset.SOPInstanceUID).rsplit(".", 1)[1])

    def forced(input_dir):
        # Preserve real file admission, but do not assume any OS enumeration order.
        by_index = {index(blob): blob for blob in collect(input_dir)}
        ordered = [by_index[k] for k in order]
        observed.append([index(blob) for blob in ordered])
        return ordered

    monkeypatch.setattr(di, "_collect_input_files", forced)
    bundle = di.convert_series(source, tmp_path / "out", "ordering-probe", scope="synthetic")
    assert observed == [order]
    manifest, _, paths = InstalledNiftiSourceStore(bundle, source_id="ordering-probe").load()
    image = nib.load(paths["image"])
    flip = np.diag([-1.0, -1.0, 1.0])
    expected = np.eye(4)
    expected[:3, :3] = flip @ np.column_stack(
        [
            fixture.ROW_DIR * fixture.PS_COL,
            fixture.COL_DIR * fixture.PS_ROW,
            fixture.NORMAL * fixture.GAP,
        ]
    )
    expected[:3, 3] = flip @ fixture.IPP0
    stored_expected = expected.astype("float32").astype("float64")
    assert np.array_equal(image.affine, stored_expected)
    assert manifest["image"]["affine_ras"] == stored_expected.tolist()
    wrong_origin = flip @ (fixture.IPP0 + order[0] * fixture.GAP * fixture.NORMAL)
    assert not np.allclose(image.affine[:3, 3], wrong_origin)
    values = np.asanyarray(image.dataobj)
    assert values.shape == (fixture.COLS, fixture.ROWS, fixture.SLICES)
    for k in range(fixture.SLICES):
        for j in range(fixture.ROWS):
            for i in range(fixture.COLS):
                assert values[i, j, k] == fixture._expected_value(j, i, k)
                world = image.affine @ np.array([i, j, k, 1.0])
                assert np.allclose(world[:3], flip @ fixture._lps_of_voxel(j, i, k), atol=1e-5)
