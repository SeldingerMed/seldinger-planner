"""The two reductions the bone line-up format step makes. They need numpy,
which the optional model runtime provides."""

import sys
from pathlib import Path

import pytest

numpy = pytest.importorskip("numpy")
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "research"))
import prepare_bone_sets as bone
from prepare_ljubljana import PrepareError


def test_block_mean_averages_whole_blocks_and_drops_the_remainder():
    frame = numpy.arange(5 * 6, dtype=numpy.uint16).reshape(5, 6)
    small = bone.block_mean(frame, 2)
    assert small.shape == (2, 3)
    assert small[0, 0] == pytest.approx((0 + 1 + 6 + 7) / 4)
    assert small[1, 2] == pytest.approx((16 + 17 + 22 + 23) / 4)
    volume = numpy.ones((4, 4, 5))
    volume[2:, :, :] = 3
    assert bone.block_mean(volume, 2)[:, 0, 0].tolist() == [1, 3]
    with pytest.raises(PrepareError, match="Block does not fit"):
        bone.block_mean(numpy.ones((1, 4)), 2)


def test_block_affine_puts_a_reduced_voxel_at_the_middle_of_its_block():
    affine = numpy.array(
        [[-0.5, 0, 0, 10], [0, -0.5, 0, 20], [0, 0, 0.5, -30], [0, 0, 0, 1]], dtype=float
    )
    reduced = bone.block_affine(affine, 2)
    # Reduced voxel (1, 0, 2) covers source voxels 2..3, 0..1, 4..5.
    middle = affine @ numpy.array([2.5, 0.5, 4.5, 1])
    assert (reduced @ numpy.array([1, 0, 2, 1])).tolist() == pytest.approx(middle.tolist())


def _saved(value) -> bytes:
    import io

    torch = pytest.importorskip("torch")
    buffer = io.BytesIO()
    torch.save(value, buffer)
    return buffer.getvalue()


def test_a_tensor_file_reads_the_same_without_torch():
    torch = pytest.importorskip("torch")
    pose = torch.arange(16, dtype=torch.float32).reshape(4, 4) / 7
    stored = {
        "pose": pose[None],
        "intrinsics": {"sdd": 1020.0, "delx": torch.tensor(0.194), "height": 1436},
        "turned": pose.T,
        "part": torch.arange(12, dtype=torch.float64)[3:9].reshape(2, 3),
    }
    read = bone.read_pt(_saved(stored))
    assert read["pose"].shape == (1, 4, 4)
    assert read["pose"].dtype == numpy.float32
    assert numpy.array_equal(read["pose"], stored["pose"].numpy())
    assert read["intrinsics"]["sdd"] == 1020.0
    assert read["intrinsics"]["height"] == 1436
    assert float(read["intrinsics"]["delx"]) == pytest.approx(0.194)
    # A view keeps its own order and its place in the storage it shares.
    assert numpy.array_equal(read["turned"], pose.T.numpy())
    assert numpy.array_equal(read["part"], stored["part"].numpy())
    points = torch.linspace(-3, 3, 42, dtype=torch.float64).reshape(14, 3)
    assert numpy.array_equal(bone.read_pt(_saved(points)), points.numpy())


def test_a_tensor_file_is_refused_when_it_holds_anything_else(tmp_path):
    import io
    import os
    import pickle
    import zipfile

    class Hostile:
        def __reduce__(self):
            return (os.mkdir, (str(tmp_path / "made"),))

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr("archive/data.pkl", pickle.dumps(Hostile()))
    with pytest.raises(PrepareError, match="Not a tensor file"):
        bone.read_pt(archive.getvalue())
    assert not (tmp_path / "made").exists()
    with pytest.raises(PrepareError, match="Not a tensor file"):
        bone.read_pt(b"not a zip")
    # A tensor that claims more than its storage holds.
    torch = pytest.importorskip("torch")
    saved = _saved(torch.zeros(4))
    with zipfile.ZipFile(io.BytesIO(saved)) as z:
        names = z.namelist()
        cut = io.BytesIO()
        with zipfile.ZipFile(cut, "w") as out:
            for name in names:
                data = z.read(name)
                out.writestr(name, data[:8] if name.endswith("data/0") else data)
    with pytest.raises(PrepareError, match="Not a tensor file"):
        bone.read_pt(cut.getvalue())


def _nifti(array, affine, slope=None, inter=None) -> bytes:
    import gzip

    nibabel = pytest.importorskip("nibabel")
    image = nibabel.Nifti1Image(array, affine)
    if slope is not None:
        image.header.set_slope_inter(slope, inter)
    return gzip.compress(image.to_bytes())


def test_a_scan_is_read_in_slabs_to_the_same_bytes_as_in_one_piece(tmp_path):
    import gzip

    nibabel = pytest.importorskip("nibabel")
    rng = numpy.random.default_rng(3)
    affine = numpy.array([[-1, 0, 0, 12.5], [0, -1, 0, -7], [0, 0, 1, -1041.5], [0, 0, 0, 1.0]])
    for array, slope, inter in (
        ((rng.random((7, 5, 9)) * 3000 - 1000).astype(numpy.float32), None, None),
        (rng.integers(0, 4000, (7, 5, 9)).astype(numpy.int16), 1.0, -1024.0),
        ((rng.random((7, 5, 9)) * 70000 - 35000).astype(numpy.float64), None, None),
    ):
        packed = _nifti(array, affine, slope, inter)
        image = nibabel.Nifti1Image.from_bytes(gzip.decompress(packed))
        whole = bone._i16(numpy.asanyarray(image.dataobj))
        data, shape, read_affine = bone.scan_i16(packed, slab=2)
        assert data == whole
        # From a file, written as it is read: nothing is returned to hold.
        (tmp_path / "volume.nii.gz").write_bytes(packed)
        parts = []
        data, shape, read_affine = bone.scan_i16(
            tmp_path / "volume.nii.gz", slab=2, sink=parts.append
        )
        assert data == b""
        assert b"".join(parts) == whole
        assert len(parts) == 5
        assert shape == [7, 5, 9]
        assert numpy.array_equal(read_affine, image.affine)
    broken = (rng.random((4, 4, 4))).astype(numpy.float32)
    broken[1, 2, 3] = numpy.nan
    with pytest.raises(PrepareError, match="Unexpected volume"):
        bone.scan_i16(_nifti(broken, affine))
    with pytest.raises(PrepareError, match="Unexpected volume"):
        bone.scan_i16(_nifti(numpy.zeros((4, 4), dtype=numpy.float32), affine))
    with pytest.raises(PrepareError, match="Unexpected volume"):
        bone.scan_i16(gzip.compress(b"not a scan"))
    with pytest.raises(PrepareError, match="Unexpected volume"):
        bone.scan_i16(_nifti(numpy.zeros((4, 4, 4), dtype=numpy.float32), affine)[:-40])


def test_bone_labels_are_read_on_the_scan_grid_and_refused_off_it():
    pytest.importorskip("nibabel")
    rng = numpy.random.default_rng(5)
    affine = numpy.array([[-1, 0, 0, 12.5], [0, -1, 0, -7], [0, 0, 1, -1041.5], [0, 0, 0, 1.0]])
    labels = rng.integers(0, 8, (7, 5, 9)).astype(numpy.uint8)
    data, values = bone.labels_u8(_nifti(labels, affine), [7, 5, 9], affine, slab=2)
    assert data == labels.tobytes(order="F")
    parts = []
    data, again = bone.labels_u8(
        _nifti(labels, affine), [7, 5, 9], affine, slab=4, sink=parts.append
    )
    assert (data, again) == (b"", values)
    assert b"".join(parts) == labels.tobytes(order="F")
    assert values == sorted(int(v) for v in numpy.unique(labels))
    with pytest.raises(PrepareError, match="Labels are not on the scan grid"):
        bone.labels_u8(_nifti(labels, affine), [7, 5, 8], affine)
    moved = affine.copy()
    moved[0, 3] += 1
    with pytest.raises(PrepareError, match="Labels are not on the scan grid"):
        bone.labels_u8(_nifti(labels, moved), [7, 5, 9], affine)
    with pytest.raises(PrepareError, match="Unexpected labels"):
        bone.labels_u8(_nifti(labels.astype(numpy.float32) + 0.5, affine), [7, 5, 9], affine)
    with pytest.raises(PrepareError, match="Unexpected labels"):
        bone.labels_u8(_nifti(labels.astype(numpy.int16) + 300, affine), [7, 5, 9], affine)
