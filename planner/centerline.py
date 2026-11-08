"""Deterministic centerline-path proposals from the accepted vessel mask.

Bounded skeleton-graph proposal support for operator input. The returned
path is a proposal only: it is used after explicit operator confirmation
and is never a validated clinical centerline. Runtime imaging imports stay
lazy so lightweight consumers can import this module without NumPy.
"""

from itertools import pairwise
from typing import Any, cast

MAX_GRID_VOXELS = 8_000_000  # bounded source-grid proposal support
MAX_SKELETON_NODES = 250_000  # bounded skeleton graph size (nodes)
MIN_POINTS = 4
DEFAULT_MAX_POINTS = 32
MAX_POINTS_LIMIT = 32

_METHOD = "accepted_vessel_mask_skeleton_centerline_proposal"


def propose_centerline(
    vessel_mask,
    affine_ras,
    start_ras,
    end_ras,
    *,
    spatial_units="mm",
    max_points=DEFAULT_MAX_POINTS,
):
    """Propose a centerline path between operator anchors on the vessel mask.

    Deterministic Dijkstra over the Lee skeleton with physical (RAS-mm) edge
    weights. Returns keys: path_ras, proximal_index, distal_index, method,
    operator_confirmation_required=True, clinical_validation=False,
    spatial_units='mm', length_mm, point_count plus small diagnostics.
    """
    import numpy as np
    from scipy import ndimage

    if spatial_units != "mm":
        raise ValueError("spatial_units must be explicitly 'mm' for RAS proposals")
    aff = np.asarray(affine_ras, dtype=float)
    if (
        aff.shape != (4, 4)
        or not np.isfinite(aff).all()
        or not np.array_equal(aff[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous RAS affine")
    determinant = float(np.linalg.det(aff))
    if not np.isfinite(determinant) or abs(determinant) < 1e-12:
        raise ValueError("Invalid singular or non-finite RAS affine")
    inverse = np.linalg.inv(aff)

    mask = np.asarray(vessel_mask)
    if mask.ndim != 3:
        raise ValueError("Vessel mask must be a three-dimensional grid")
    if mask.size > MAX_GRID_VOXELS:
        raise ValueError("Vessel mask exceeds the grid size bound")
    if mask.dtype.kind not in "biuf" or not np.all((mask == 0) | (mask == 1)):
        raise ValueError("Vessel mask must be binary with values 0 or 1")
    foreground = mask == 1

    def anchor_index(point, label):
        p = np.asarray(point, dtype=float)
        if p.shape != (3,) or not np.isfinite(p).all():
            raise ValueError(f"Operator {label} anchor must have three finite coordinates")
        native = (inverse @ np.r_[p, 1.0])[:3]
        if any(v < 0 or v > n - 1 for v, n in zip(native, mask.shape, strict=True)):
            raise ValueError(f"Operator {label} anchor is outside the installed image")
        idx = tuple(round(float(v)) for v in native)  # ties to even (nearest-index policy)
        if not foreground[idx]:
            raise ValueError(f"Operator {label} anchor must round to vessel foreground")
        return idx

    if type(max_points) is not int or max_points < MIN_POINTS or max_points > MAX_POINTS_LIMIT:
        raise ValueError("max_points must be between four and thirty-two")
    start_idx = anchor_index(start_ras, "start")
    end_idx = anchor_index(end_ras, "end")
    if start_idx == end_idx:
        raise ValueError("Operator start and end anchors must be distinct")

    labels, _ = cast(
        "tuple[Any, Any]",
        ndimage.label(foreground, structure=ndimage.generate_binary_structure(3, 1)),
    )
    component = labels[start_idx]
    if component != labels[end_idx]:
        raise ValueError("No connected centerline path between the operator anchors")
    foreground = labels == component
    skeleton = _skeletonize(foreground)
    if np.count_nonzero(skeleton) > MAX_SKELETON_NODES:
        raise ValueError("Skeleton graph exceeds the computation budget")
    node_index = _node_lookup(skeleton)
    start_connector = _connect_to_skeleton(start_idx, skeleton, foreground, aff)
    end_connector = _connect_to_skeleton(end_idx, skeleton, foreground, aff)
    skeleton_start, skeleton_end = start_connector[-1], end_connector[-1]

    coords: list[tuple[int, ...] | None] = [None] * len(node_index)
    for ijk, node in node_index.items():
        coords[node] = ijk
    ordered = _shortest_path(coords, node_index, skeleton_start, skeleton_end, aff)
    if ordered is None:
        raise ValueError("No connected centerline path between the operator anchors")

    ordered = start_connector[:-1] + ordered + list(reversed(end_connector))[1:]
    if len(set(ordered)) != len(ordered):
        raise ValueError("Operator anchors do not define a simple skeleton path")
    stations = _select_stations(ordered, aff, max_points)
    if stations is None or len(stations) < MIN_POINTS:
        raise ValueError("Vessel skeleton is too short to propose a four-point minimum path")

    station_ras = [(aff @ np.r_[np.asarray(ijk, dtype=float), 1.0])[:3] for ijk in stations]
    arclength = [0.0]
    for a, b in pairwise(station_ras):
        arclength.append(arclength[-1] + float(np.linalg.norm(b - a)))
    proximal, distal = _station_indices(arclength)

    return {
        "path_ras": [r.tolist() for r in station_ras],
        "proximal_index": proximal,
        "distal_index": distal,
        "method": _METHOD,
        "operator_confirmation_required": True,
        "clinical_validation": False,
        "spatial_units": "mm",
        "length_mm": arclength[-1],
        "point_count": len(stations),
        "native_point_policy": "nearest_native_index_python_ties_to_even",
        "skeleton_voxel_count": len(node_index),
        "grid_shape": [int(v) for v in mask.shape],
    }


def _skeletonize(foreground):
    try:
        from skimage.morphology import skeletonize
    except ImportError as exc:
        raise ImportError(
            "Centerline proposals require the scikit-image dependency "
            f"(skimage.morphology.skeletonize): {exc}"
        ) from exc
    return skeletonize(foreground, method="lee") == 1


def _node_lookup(skeleton):
    import numpy as np

    coords = [tuple(int(v) for v in ijk) for ijk in zip(*np.nonzero(skeleton), strict=True)]
    return {ijk: i for i, ijk in enumerate(coords)}


_NEIGHBOURS_26 = [
    (di, dj, dk)
    for di in (-1, 0, 1)
    for dj in (-1, 0, 1)
    for dk in (-1, 0, 1)
    if (di, dj, dk) != (0, 0, 0)
]


def _connect_to_skeleton(anchor, skeleton, foreground, aff):
    """Bounded foreground connector from an operator anchor to the skeleton.

    All connector nodes are actual foreground voxels in the selected face-
    connected component. No Euclidean snap or straight-line shortcut is used.
    """
    import heapq

    import numpy as np

    heap = [(0.0, anchor)]
    distances, previous = {anchor: 0.0}, {}
    weights = [
        (delta, float(np.linalg.norm(aff[:3, :3] @ np.asarray(delta)))) for delta in _NEIGHBOURS_26
    ]
    if any(not np.isfinite(weight) or weight <= 0 for _, weight in weights):
        raise ValueError("Unsupported physical skeleton edge metric")
    while heap:
        distance, node = heapq.heappop(heap)
        if distance != distances.get(node):
            continue
        if skeleton[node]:
            path = [node]
            while path[-1] != anchor:
                path.append(previous[path[-1]])
            return list(reversed(path))
        for delta, weight in weights:
            neighbour = tuple(node[i] + delta[i] for i in range(3))
            if (
                any(v < 0 or v >= foreground.shape[i] for i, v in enumerate(neighbour))
                or not foreground[neighbour]
            ):
                continue
            candidate = distance + weight
            if candidate < distances.get(neighbour, float("inf")):
                distances[neighbour], previous[neighbour] = candidate, node
                if len(distances) > MAX_SKELETON_NODES:
                    raise ValueError("Anchor connector exceeds the computation budget")
                heapq.heappush(heap, (candidate, neighbour))
    raise ValueError("No connected skeleton path from the operator anchor")


def _shortest_path(coords, node_index, start_idx, end_idx, aff):
    """Deterministic Dijkstra; returns voxel indices start->end or None."""
    import heapq

    import numpy as np

    target = node_index[end_idx]
    matrix = aff[:3, :3]
    dist = {node_index[start_idx]: 0.0}
    previous = {}
    heap = [(0.0, node_index[start_idx])]
    while heap:
        d, node = heapq.heappop(heap)
        if d > dist.get(node, float("inf")):
            continue
        if node == target:
            break
        ijk = coords[node]
        for di, dj, dk in _NEIGHBOURS_26:
            neighbour_ijk = (ijk[0] + di, ijk[1] + dj, ijk[2] + dk)
            neighbour = node_index.get(neighbour_ijk)
            if neighbour is None:
                continue
            step = float(np.linalg.norm(matrix @ np.array([di, dj, dk], dtype=float)))
            candidate = d + step
            if candidate < dist.get(neighbour, float("inf")):
                dist[neighbour] = candidate
                previous[neighbour] = node
                heapq.heappush(heap, (candidate, neighbour))
    if target not in dist:
        return None
    path = []
    node = target
    while node is not None:
        path.append(coords[node])
        node = previous.get(node)
    path.reverse()
    return path


def _select_stations(ordered, aff, max_points):
    """Evenly spaced arclength stations snapped to actual skeleton voxels."""
    import numpy as np

    matrix = aff[:3, :3]
    ras = [(matrix @ np.asarray(ijk, dtype=float)).tolist() for ijk in ordered]
    cumulative = [0.0]
    for a, b in pairwise(ras):
        cumulative.append(cumulative[-1] + float(np.linalg.norm(np.asarray(b) - np.asarray(a))))
    total = cumulative[-1]
    if total <= 0.0:
        return None
    if len(ordered) <= max_points:
        return list(ordered)

    def snap(fraction):
        target = fraction * total
        best = min(range(len(ordered)), key=lambda i: (abs(cumulative[i] - target), i))
        return best

    for count in range(max_points, MIN_POINTS - 1, -1):
        fractions = [i / (count - 1) for i in range(count)]
        picks = sorted({snap(f) for f in fractions})
        if len(picks) == count:
            return [ordered[i] for i in picks]
    return None


def _station_indices(arclength):
    """Distinct interior stations nearest one-third and two-thirds arclength."""
    n = len(arclength)
    total = arclength[-1]

    def pick(fraction):
        target = fraction * total
        best: tuple[float, int] | None = None
        for i in range(1, n - 1):
            score = abs(arclength[i] - target)
            if best is None or score < best[0]:
                best = (score, i)
        return cast("tuple[float, int]", best)[1]

    proximal = pick(1.0 / 3.0)
    distal = pick(2.0 / 3.0)
    if proximal == distal:
        if proximal - 1 >= 1:
            proximal -= 1
        else:
            distal += 1
    return proximal, distal
