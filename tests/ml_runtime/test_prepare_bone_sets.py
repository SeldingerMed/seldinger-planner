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
