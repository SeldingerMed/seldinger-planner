"""Vessel models for synthetic frames: points, territories and filling order.

A binary artery mask becomes a cloud of voxel centres in patient millimeters.
Each large connected piece of the mask is entered where it is lowest: the
voxels of its bottom slab are its inlets, and inlets that lie close together
count as one. Every voxel then belongs to the inlet it is nearest to along
the vessels, and carries its distance along the vessels from each inlet. A
selective injection is drawn from these: the voxels of one inlet, filled out
to some distance.

This is a stand-in for how contrast spreads, not a model of flow. Distance
along the mask knows nothing of flow direction, and an inlet is whatever
crosses the bottom of the imaged slab.
"""

from __future__ import annotations

import numpy as np
from scipy import sparse
from scipy.sparse import csgraph

SLAB_MM = 5.0
# Wide enough to join a pair of vertebral arteries near where they meet, and
# too narrow to join a carotid to the basilar: at 18 mm a third of the masks
# were left with a single inlet.
MERGE_MM = 10.0
MIN_PIECE_SHARE = 0.03
MIN_INLET_SHARE = 0.08
MIN_VOXELS = 2000
MAX_VOXELS = 1_500_000
_HALF_NEIGHBORS = [
    (i, j, k) for i in (-1, 0, 1) for j in (-1, 0, 1) for k in (-1, 0, 1) if (i, j, k) > (0, 0, 0)
]


class VesselError(Exception):
    pass


def _graph(mask: np.ndarray, affine: np.ndarray) -> tuple[np.ndarray, sparse.csr_matrix]:
    index = np.argwhere(mask)
    count = len(index)
    node = np.full(mask.shape, -1, dtype=np.int32)
    node[tuple(index.T)] = np.arange(count, dtype=np.int32)
    shape = np.array(mask.shape)
    rows, cols, lengths = [], [], []
    for offset in _HALF_NEIGHBORS:
        moved = index + offset
        inside = ((moved >= 0) & (moved < shape)).all(axis=1)
        other = np.full(count, -1, dtype=np.int32)
        other[inside] = node[tuple(moved[inside].T)]
        joined = other >= 0
        rows.append(np.nonzero(joined)[0])
        cols.append(other[joined])
        length = float(np.linalg.norm(affine[:3, :3] @ np.array(offset, dtype=np.float64)))
        lengths.append(np.full(int(joined.sum()), length))
    rows, cols, lengths = np.concatenate(rows), np.concatenate(cols), np.concatenate(lengths)
    graph = sparse.coo_matrix((lengths, (rows, cols)), shape=(count, count)).tocsr()
    return index, graph + graph.T


def checked(mask: np.ndarray, affine: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """The mask as booleans and its affine, or a refusal of what is not supported."""
    mask = np.asarray(mask) > 0
    affine = np.asarray(affine, dtype=np.float64)
    if mask.ndim != 3 or affine.shape != (4, 4) or not np.isfinite(affine).all():
        raise VesselError("Invalid mask or affine")
    volume = abs(float(np.linalg.det(affine[:3, :3])))
    if not 1e-3 <= volume <= 8:
        raise VesselError("Voxel size is outside the supported range")
    total = int(mask.sum())
    if not MIN_VOXELS <= total <= MAX_VOXELS:
        raise VesselError(f"Mask holds {total} voxels, outside the supported range")
    return mask, affine


def vessel_model(mask: np.ndarray, affine: np.ndarray) -> dict:
    """Points, inlet cells and distances along the vessels for one mask.

    Returns ``points`` (N, 3) in millimeters, ``cell`` (N,) with the inlet
    each voxel belongs to or -1, ``inlets`` (G,) cell ids that hold at least
    ``MIN_INLET_SHARE`` of the voxels, ``along`` (G, N) distance along the
    vessels from each of those inlets (infinite where not connected),
    ``edges`` (3, 3) the voxel edge vectors as rows and ``voxel_mm3``.
    """
    mask, affine = checked(mask, affine)
    volume = abs(float(np.linalg.det(affine[:3, :3])))
    total = int(mask.sum())
    index, graph = _graph(mask, affine)
    points = index @ affine[:3, :3].T + affine[:3, 3]
    pieces, piece = csgraph.connected_components(graph, directed=False)
    sizes = np.bincount(piece, minlength=pieces)
    # Inlets: the bottom slab of every large piece, joined where they touch.
    seed = np.zeros(total, dtype=bool)
    for large in np.nonzero(sizes >= MIN_PIECE_SHARE * total)[0]:
        inside = piece == large
        seed |= inside & (points[:, 2] <= points[inside, 2].min() + SLAB_MM)
    seeds = np.nonzero(seed)[0]
    if len(seeds) == 0:
        raise VesselError("No piece of the mask is large enough to have an inlet")
    groups, group = csgraph.connected_components(graph[seeds][:, seeds], directed=False)
    centers = np.stack([points[seeds[group == g], :2].mean(axis=0) for g in range(groups)])
    # Inlets that lie close together in the axial plane count as one.
    near = np.linalg.norm(centers[:, None] - centers[None], axis=-1) <= MERGE_MM
    _, merged = csgraph.connected_components(sparse.csr_matrix(near), directed=False)
    inlet_of_seed = merged[group]
    distance, _, source = csgraph.dijkstra(
        graph, directed=False, indices=seeds, min_only=True, return_predecessors=True
    )
    cell = np.full(total, -1, dtype=np.int16)
    reached = np.isfinite(distance)
    lookup = np.full(total, -1, dtype=np.int64)
    lookup[seeds] = inlet_of_seed
    cell[reached] = lookup[source[reached]]
    share = np.bincount(cell[cell >= 0], minlength=int(merged.max()) + 1) / total
    inlets = np.nonzero(share >= MIN_INLET_SHARE)[0]
    if len(inlets) == 0:
        raise VesselError("No inlet holds enough of the mask")
    along = np.stack(
        [
            csgraph.dijkstra(
                graph, directed=False, indices=seeds[inlet_of_seed == inlet], min_only=True
            )
            for inlet in inlets
        ]
    )
    return {
        "points": points.astype(np.float32),
        "cell": cell,
        "inlets": inlets.astype(np.int16),
        "along": along.astype(np.float32),
        "edges": affine[:3, :3].T.astype(np.float32),
        "voxel_mm3": np.float32(volume),
    }
