"""Aorta and iliac model proposal from one binary vessel mask.

The mask holds the aorta and the iliac arteries, with or without side
branches. The proposal names three centerlines with their radii: the aorta
down to its bifurcation, and the right and left iliac arteries below it. A
mask that ends above the pelvis gives the aorta alone.

How it works: the mask is read on a 1.5 mm grid and its largest piece is
kept. Every point of it carries the radius of the largest sphere that fits
in the lumen there. Lines are traced from the far ends of the piece along
the middle of the lumen until they meet, which gives a tree whether an
artery ends in a taper or is cut flat by the edge of the scan. The
bifurcation is the fork whose two lower arms are both long, both run toward
the feet and are of comparable width, under the widest upper arm of any
such fork. Each centerline then follows the widest way on at every fork.

The result is a proposal the operator confirms. Runtime imaging imports
stay lazy so the API process can import this module without NumPy.
"""

from itertools import pairwise
from typing import Any, cast

METHOD = "aortoiliac_widest_path_model_v1"

AORTOILIAC = {
    # Blocks of the source grid are merged until a block is about this size.
    "working_mm": 1.5,
    "max_working_voxels": 8_000_000,
    "max_lumen_voxels": 1_500_000,
    "max_lines": 400,
    # A traced line clears the lumen within this many radii, plus this many
    # millimetres, of itself; what is left holds the next line's far end.
    "clear_radii": 1.5,
    "clear_mm": 3.0,
    # A line is kept when it runs this far past the lumen it joins.
    "line_min_mm": 7.5,
    # A line's free end is drawn back to where the lumen around it is this
    # share of the lumen a little farther in: the far end of a tube cut flat
    # is a corner of the cut.
    "end_share": 0.7,
    "end_look_mm": 12.0,
    "min_voxels": 200,
    # A way on from a fork counts when it runs this far past the lumen the
    # fork sits in. Shorter ones are the skeleton's own spurs.
    "arm_min_mm": 15.0,
    # The width of an arm is read over this length, starting where the arm
    # has left the lumen the fork sits in.
    "onset_mm": 20.0,
    # The two iliac arms: the narrower at least this share of the wider,
    # each at least this long, each ending at least this far toward the feet.
    "limb_ratio": 0.4,
    "limb_min_mm": 40.0,
    "limb_drop_mm": 30.0,
    # The aorta above the fork is at least this much wider than either arm.
    "trunk_over_limb": 1.1,
    "station_mm": 2.0,
    "smooth_mm": 6.0,
    "max_fork_candidates": 200,
}

_NEIGHBOURS_26 = [
    (di, dj, dk)
    for di in (-1, 0, 1)
    for dj in (-1, 0, 1)
    for dk in (-1, 0, 1)
    if (di, dj, dk) != (0, 0, 0)
]


def propose_aortoiliac_model(vessel_mask, affine_ras, *, spatial_units="mm"):
    """Named aorta and iliac centerlines, with radii, from a binary mask.

    Returns `branches` (each with `name`, `path_ras`, `radius_mm` and
    `length_mm`; the aorta runs down to the point the three lines meet at and
    each iliac artery away from it), `bifurcation_ras` (where the lumen
    divides; None when the mask holds no iliac arteries),
    `bifurcation_below_meeting_mm` (how far along the iliac lines that is
    from the meeting point, which lies above it in the middle of the aorta),
    and the working grid the model was read on.
    """
    import numpy as np
    from scipy import ndimage

    limits = AORTOILIAC
    if spatial_units != "mm":
        raise ValueError("spatial units must be explicitly 'mm'")
    affine = np.asarray(affine_ras, dtype=float)
    if (
        affine.shape != (4, 4)
        or not np.isfinite(affine).all()
        or not np.array_equal(affine[3], [0, 0, 0, 1])
    ):
        raise ValueError("Invalid homogeneous RAS affine")
    spacing = np.linalg.norm(affine[:3, :3], axis=0)
    if not (spacing > 1e-3).all():
        raise ValueError("Invalid singular RAS affine")
    unit = affine[:3, :3] / spacing
    if np.abs(unit.T @ unit - np.eye(3)).max() > 1e-3:
        raise ValueError("The RAS affine must have index axes at right angles")
    mask = np.asarray(vessel_mask)
    if mask.ndim != 3:
        raise ValueError("Vessel mask must be a three-dimensional grid")
    if mask.dtype.kind not in "biuf":
        raise ValueError("Vessel mask must be binary with values 0 or 1")
    if mask.dtype.kind != "b" and (mask.min() < 0 or mask.max() > 1):
        raise ValueError("Vessel mask must be binary with values 0 or 1")
    spans = []
    for axis in range(3):
        along = np.flatnonzero(mask.any(axis=tuple(i for i in range(3) if i != axis)))
        if along.size == 0:
            raise ValueError("Vessel mask is empty")
        spans.append((int(along[0]), int(along[-1]) + 1))
    held = mask[tuple(slice(a, b) for a, b in spans)]
    if held.dtype.kind == "f" and not np.all((held == 0) | (held == 1)):
        raise ValueError("Vessel mask must be binary with values 0 or 1")

    # The box that holds the vessel is read on a grid of the working size
    # along the scan's own axes: fine axes are first merged in whole blocks,
    # then every axis is brought to the working size between neighbours.
    low = np.array([a for a, _ in spans])
    factor = np.maximum(1, np.floor(limits["working_mm"] / spacing + 1e-6)).astype(int)
    blocks_shape = np.ceil((np.array([b for _, b in spans]) - low) / factor).astype(int)
    box = np.zeros(tuple(blocks_shape * factor), dtype=bool)
    box[tuple(slice(0, n) for n in held.shape)] = held != 0
    occupancy = box.reshape(
        blocks_shape[0], factor[0], blocks_shape[1], factor[1], blocks_shape[2], factor[2]
    ).mean(axis=(1, 3, 5), dtype=np.float32)
    block_mm = spacing * factor
    scale = limits["working_mm"] / block_mm  # blocks per working step
    working_shape = np.ceil(blocks_shape / scale).astype(int) + 4
    if int(np.prod(working_shape)) > limits["max_working_voxels"]:
        raise ValueError("Vessel mask exceeds the grid size bound")
    # Working index w sits at block index scale * w + shift, the two grids
    # sharing their middle.
    shift = (blocks_shape - 1) / 2 - scale * (working_shape - 1) / 2
    working = (
        ndimage.affine_transform(
            occupancy,
            scale,
            offset=shift,
            output_shape=tuple(int(v) for v in working_shape),
            order=1,
            mode="constant",
            cval=0.0,
        )
        >= 0.5
    )
    # Block index to source index: the middle of the block.
    to_ras = np.eye(4)
    to_ras[:3, :3] = affine[:3, :3] * (factor * scale)
    to_ras[:3, 3] = affine[:3, :3] @ (low + factor * shift + (factor - 1) / 2) + affine[:3, 3]
    working_spacing = np.full(3, float(limits["working_mm"]))

    del box, occupancy
    labels, count = cast(
        "tuple[Any, int]",
        ndimage.label(working, structure=ndimage.generate_binary_structure(3, 3)),
    )
    if count == 0:
        raise ValueError("Vessel mask is too small to model")
    sizes = np.bincount(labels[working], minlength=count + 1)[1:]
    largest = int(np.argmax(sizes)) + 1
    apart = int(sizes.sum() - sizes[largest - 1])
    working = labels == largest
    if int(sizes[largest - 1]) < limits["min_voxels"]:
        raise ValueError("Vessel mask is too small to model")
    if int(sizes[largest - 1]) > limits["max_lumen_voxels"]:
        raise ValueError("Vessel mask exceeds the computation budget")
    # From here the lumen is a list of its grid points, not a grid: an
    # artery is a few thousandths of the box that holds it.
    flat = np.flatnonzero(working)
    ijk = np.stack(np.unravel_index(flat, working.shape), axis=1).astype(np.int32)
    shape = working.shape
    del working, labels
    wide = _inscribed(ijk, flat, shape, limits["working_mm"])
    nodes, joined = _centre_tree(ijk, flat, shape, wide, limits)
    if len(nodes) < 4:
        raise ValueError("Vessel mask is too small to model")
    lookup = {int(node): at for at, node in enumerate(nodes)}
    # A traced point sits on a grid point. The lumen's middle is read
    # between grid points, from where the inscribed radius is greatest around
    # it, and the radius there is the grid point's own plus its distance
    # from that middle.
    index = ijk[nodes].astype(float)
    reach = np.asarray([*_NEIGHBOURS_26, (0, 0, 0)])
    around = np.zeros((len(nodes), len(reach)))
    for column, delta in enumerate(reach):
        found, at = _held(flat, flat[nodes] + _step(delta, shape))
        around[found, column] = wide[at[found]]
    weight = np.clip(around - (around[:, -1:] - limits["working_mm"]), 0, None)
    shift_to_middle = (weight[:, :, None] * reach[None]).sum(axis=1) / weight.sum(axis=1)[:, None]
    middle = index + shift_to_middle
    radius = [
        float(v)
        for v in around[:, -1] + np.linalg.norm(shift_to_middle, axis=1) * limits["working_mm"]
    ]
    ras = list(middle @ to_ras[:3, :3].T + to_ras[:3, 3])
    neighbours: list[list[tuple[int, float]]] = [[] for _ in nodes]
    for one, other in joined:
        a, b = lookup[one], lookup[other]
        length = float(np.linalg.norm(ras[a] - ras[b]))
        neighbours[a].append((b, length))
        neighbours[b].append((a, length))
    graph = _Graph(neighbours, radius, [float(p[2]) for p in ras], limits)

    seed = max(range(len(nodes)), key=lambda node: (radius[node], -node))
    first = graph.tree(seed)
    forks = [node for node in first.order if len(first.arms(node)) + (node != seed) >= 3]
    forks.sort(key=lambda node: (-radius[node], node))
    best = None
    for fork in forks[: limits["max_fork_candidates"]]:
        found = _bifurcation(graph.tree(fork), radius, limits)
        if found is not None and (best is None or found[0] > best[0]):
            best = found

    branches = []
    if best is None:
        # No iliac arteries in the mask: the aorta alone, head to foot.
        ways = sorted(first.arms(seed), key=lambda arm: -first.onset(arm))[:2]
        path = [seed]
        for k, arm in enumerate(ways):
            way = first.follow(arm)
            path = list(reversed(way)) + path if k == 0 else path + way
        if ras[path[0]][2] < ras[path[-1]][2]:
            path.reverse()
        branches.append(_branch("aorta", path, ras, radius, limits, free=(True, True)))
        bifurcation = below = None
    else:
        _, tree, fork, trunk, limbs = best
        aorta = [*reversed(tree.follow(trunk)), fork]
        sides = sorted(
            ([fork, *tree.follow(arm)] for arm in limbs), key=lambda way: -ras[way[-1]][0]
        )
        branches.append(_branch("aorta", aorta, ras, radius, limits, free=(True, False)))
        # RAS: the artery that ends farther along +x is the patient's right.
        branches.append(_branch("right_iliac", sides[0], ras, radius, limits, free=(False, True)))
        branches.append(_branch("left_iliac", sides[1], ras, radius, limits, free=(False, True)))
        # The three lines meet at one point, in the middle of the aorta.
        meet = [float(v) for v in ras[fork]]
        for line in branches:
            end = -1 if line["name"] == "aorta" else 0
            line["path_ras"][end] = list(meet)
            line["length_mm"] = _length(line["path_ras"])
        bifurcation, below = _divides(branches[1], branches[2])

    return {
        "method": METHOD,
        "branches": branches,
        "bifurcation_ras": bifurcation,
        "bifurcation_below_meeting_mm": below,
        "operator_confirmation_required": True,
        "clinical_validation": False,
        "spatial_units": "mm",
        "working_spacing_mm": [float(v) for v in working_spacing],
        "working_grid_shape": [int(v) for v in shape],
        "skeleton_voxel_count": len(nodes),
        "volume_apart_from_the_model_mm3": float(apart * limits["working_mm"] ** 3),
    }


class _Graph:
    def __init__(self, neighbours, radius, height, limits):
        self.neighbours, self.radius, self.height, self.limits = neighbours, radius, height, limits

    def tree(self, root):
        return _Tree(self, root)


class _Tree:
    """The skeleton as a tree from one root: every point reached by the way
    that stays in the widest lumen (step length over radius squared)."""

    def __init__(self, graph, root):
        import heapq

        self.graph, self.root = graph, root
        cost = {root: 0.0}
        self.parent = {root: None}
        self.along = {root: 0.0}
        self.order = []
        heap = [(0.0, root)]
        done = set()
        while heap:
            reached, node = heapq.heappop(heap)
            if node in done:
                continue
            done.add(node)
            self.order.append(node)
            for other, length in graph.neighbours[node]:
                if other in done:
                    continue
                wide = max(0.5, min(graph.radius[node], graph.radius[other]))
                candidate = reached + length / (wide * wide)
                if candidate < cost.get(other, float("inf")):
                    cost[other] = candidate
                    self.parent[other] = node
                    self.along[other] = self.along[node] + length
                    heapq.heappush(heap, (candidate, other))
        self.children: dict[int, list[int]] = {node: [] for node in self.order}
        for node in self.order[1:]:
            self.children[self.parent[node]].append(node)
        # How far the tree runs on below each point, and by which child.
        self.reach = dict.fromkeys(self.order, 0.0)
        self.longest: dict[int, int | None] = dict.fromkeys(self.order)
        for node in reversed(self.order[1:]):
            above = self.parent[node]
            run = self.reach[node] + self.along[node] - self.along[above]
            if run > self.reach[above] or (
                run == self.reach[above] and node < cast("int", self.longest[above])
            ):
                self.reach[above], self.longest[above] = run, node
        self._arms: dict[int, list[int]] = {}
        self._onset: dict[int, float] = {}

    def arms(self, node):
        """The ways on from a point that run past the lumen the point sits in."""
        if node not in self._arms:
            least = self.graph.radius[node] + self.graph.limits["arm_min_mm"]
            self._arms[node] = [
                child
                for child in self.children[node]
                if self.reach[child] + self.along[child] - self.along[node] >= least
            ]
        return self._arms[node]

    def onset(self, arm):
        """The width of an arm: its median radius over the first stretch
        after it has left the lumen its fork sits in."""
        if arm not in self._onset:
            fork = cast("int", self.parent[arm])
            start = self.along[fork] + self.graph.radius[fork]
            end = start + self.graph.limits["onset_mm"]
            seen, node = [], arm
            while node is not None and self.along[node] <= end:
                if self.along[node] >= start:
                    seen.append(self.graph.radius[node])
                node = self.longest[node]
            if not seen:
                seen = [self.graph.radius[self._tip(arm)]]
            seen.sort()
            self._onset[arm] = seen[len(seen) // 2]
        return self._onset[arm]

    def _tip(self, node):
        while self.longest[node] is not None:
            node = self.longest[node]
        return node

    def follow(self, arm):
        """An arm out to its end, taking the widest way on at every fork."""
        path = [arm]
        while True:
            ways = self.arms(path[-1])
            if ways:
                path.append(max(ways, key=lambda way: (self.onset(way), -way)))
            elif self.longest[path[-1]] is not None:
                path.append(cast("int", self.longest[path[-1]]))
            else:
                return path


def _bifurcation(tree, radius, limits):
    """The fork at a tree's root read as an aortic bifurcation, or None."""
    fork = tree.root
    arms = sorted(tree.arms(fork), key=lambda arm: (-tree.onset(arm), arm))
    if len(arms) < 3:
        return None
    trunk, limbs = arms[0], arms[1:3]
    wide, narrow = tree.onset(limbs[0]), tree.onset(limbs[1])
    if narrow < limits["limb_ratio"] * wide or tree.onset(trunk) < limits["trunk_over_limb"] * wide:
        return None
    height = tree.graph.height
    # The aorta ends above its bifurcation. At a fork in the chest, where a
    # channel leaves the arch downward, every arm runs toward the feet.
    if height[tree.follow(trunk)[-1]] <= height[fork]:
        return None
    for limb in limbs:
        end = tree.follow(limb)[-1]
        if tree.along[end] < limits["limb_min_mm"]:
            return None
        if height[fork] - height[end] < limits["limb_drop_mm"]:
            return None
    return tree.onset(trunk), tree, fork, trunk, limbs


def _branch(name, nodes, ras, radius, limits, *, free):
    """A traced line as a smoothed line with its radii, in even steps. A free
    end (`free` names the first and the last) is drawn back out of the corner
    it was traced from."""
    import numpy as np

    points = np.asarray([ras[node] for node in nodes], dtype=float)
    wide = np.asarray([radius[node] for node in nodes], dtype=float)
    for end, is_free in enumerate(free):
        if is_free:
            if end:
                points, wide = points[::-1], wide[::-1]
            along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
            first = 0
            while first < len(points) - 4 and wide[first] < limits["end_share"] * np.max(
                wide[(along >= along[first]) & (along <= along[first] + limits["end_look_mm"])]
            ):
                first += 1
            points, wide = points[first:], wide[first:]
            if end:
                points, wide = points[::-1], wide[::-1]
    along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
    half = limits["smooth_mm"] / 2
    smooth, radii = [], []
    for at in along:
        # The mean over a window that shrinks toward each end, so the ends
        # stay where the skeleton ends.
        reach = max(min(half, at, along[-1] - at), 1e-6)
        near = (along >= at - reach) & (along <= at + reach)
        smooth.append(points[near].mean(axis=0))
        radii.append(float(np.median(wide[near])))
    smooth = np.asarray(smooth)
    run = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(smooth, axis=0), axis=1))]
    stations = np.linspace(0.0, run[-1], max(4, round(float(run[-1]) / limits["station_mm"]) + 1))
    path_ras = [[float(np.interp(at, run, smooth[:, i])) for i in range(3)] for at in stations]
    return {
        "name": name,
        "path_ras": path_ras,
        "radius_mm": [float(np.interp(at, run, radii)) for at in stations],
        "length_mm": _length(path_ras),
    }


def _divides(one, other):
    """Where the lumen divides below the point the iliac lines meet at.

    The two lines leave that point together, inside the aorta. Followed
    for the same distance, the spheres inscribed about them overlap for as
    long as they share a lumen. The bifurcation is midway between the lines
    where the spheres first stand apart; the distance followed is returned
    with it. Lines that never part give the meeting point itself.
    """
    import numpy as np

    lines = []
    for line in (one, other):
        path = np.asarray(line["path_ras"], dtype=float)
        along = np.r_[0.0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
        lines.append((along, path, np.asarray(line["radius_mm"], dtype=float)))
    for at in np.arange(0.0, min(lines[0][0][-1], lines[1][0][-1]), 0.5):
        points = [np.array([np.interp(at, a, p[:, i]) for i in range(3)]) for a, p, _ in lines]
        if np.linalg.norm(points[0] - points[1]) >= sum(np.interp(at, a, r) for a, _, r in lines):
            return [float(v) for v in (points[0] + points[1]) / 2], float(at)
    return [float(v) for v in lines[0][1][0]], 0.0


def _length(path_ras):
    import numpy as np

    return float(np.linalg.norm(np.diff(np.asarray(path_ras, dtype=float), axis=0), axis=1).sum())


def _step(delta, shape):
    """The change in a grid point's flat index for a step of `delta`."""
    return (int(delta[0]) * shape[1] + int(delta[1])) * shape[2] + int(delta[2])


def _held(flat, wanted):
    """Which flat indices are lumen points, and their places in the list.
    The grid has an empty margin, so a step from a lumen point never wraps
    round an edge onto another lumen point."""
    import numpy as np

    at = np.minimum(np.searchsorted(flat, wanted), flat.size - 1)
    return flat[at] == wanted, at


def _inscribed(ijk, flat, shape, size):
    """For each lumen point the radius of the largest sphere about it that
    stays in the lumen: its distance to the nearest grid point outside. That
    point always touches the lumen face to face, so only those are searched."""
    import numpy as np
    from scipy.spatial import cKDTree

    outside = []
    for axis in range(3):
        for way in (-1, 1):
            delta = [0, 0, 0]
            delta[axis] = way
            found, _ = _held(flat, flat + _step(delta, shape))
            outside.append(ijk[~found] + np.asarray(delta, dtype=np.int32))
    outside = np.unique(np.concatenate(outside), axis=0)
    return cKDTree(outside * size).query(ijk * size)[0]


def _centre_tree(ijk, flat, shape, wide, limits):
    """Lines along the middle of the lumen, traced from its far ends.

    Returns the lumen points on the lines and the pairs of them that are
    joined. The lines start from the point of the widest lumen. Each line
    begins at the point farthest from there, through the lumen, that no line
    has yet cleared, and runs back until it meets a line already traced.
    Every line follows the way that stays in the widest lumen (step length
    over inscribed radius squared), so two arteries that leave the same
    trunk meet in its middle whichever is traced first.
    """
    import numpy as np
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra
    from scipy.spatial import cKDTree

    size = limits["working_mm"]
    count = flat.size
    # The lumen as a graph, each point joined to its neighbours among the
    # 26 around it. Each pair is listed once, under the point that comes
    # first, and the rows are filled in place: the list of steps is the
    # largest thing this module holds.
    half = _NEIGHBOURS_26[13:]
    onward = np.full((len(half), count), -1, dtype=np.int32)
    for kind, delta in enumerate(half):
        found, at = _held(flat, flat + _step(delta, shape))
        onward[kind, found] = at[found]
    indptr = np.zeros(count + 1, dtype=np.int32)
    np.cumsum((onward >= 0).sum(axis=0), out=indptr[1:])
    indices = np.empty(int(indptr[-1]), dtype=np.int32)
    data = np.empty(int(indptr[-1]), dtype=float)
    cursor = indptr[:-1].copy()
    for kind, delta in enumerate(half):
        here = np.flatnonzero(onward[kind] >= 0)
        indices[cursor[here]] = onward[kind, here]
        data[cursor[here]] = size * float(np.linalg.norm(delta))
        cursor[here] += 1
    del onward, cursor
    graph = csr_matrix((data, indices, indptr), shape=(count, count))
    start = int(np.argmax(wide))
    far = dijkstra(graph, directed=False, indices=start)
    # The same steps, now costed by how narrow the lumen is across each.
    rows = np.repeat(np.arange(count, dtype=np.int32), np.diff(indptr))
    for first in range(0, len(data), 1 << 17):
        part = slice(first, first + (1 << 17))
        narrow = np.maximum(np.minimum(wide[rows[part]], wide[indices[part]]), size / 2)
        data[part] /= narrow * narrow
    del rows
    _, before = dijkstra(graph, directed=False, indices=start, return_predecessors=True)
    del graph, data, indices, indptr
    place = ijk * size
    on_line = np.zeros(count, dtype=bool)
    cleared = np.zeros(count, dtype=bool)
    on_line[start] = True
    joined = []
    for _ in range(limits["max_lines"]):
        left = np.where(cleared, -1.0, far)
        end = int(np.argmax(left))
        if left[end] < 0:
            break
        line = [end]
        while not on_line[line[-1]]:
            line.append(int(before[line[-1]]))
        if len(line) == 1:
            cleared[end] = True
            continue
        run = float(np.linalg.norm(np.diff(place[line], axis=0), axis=1).sum())
        if not joined or run >= wide[line[-1]] + limits["line_min_mm"]:
            on_line[line[:-1]] = True
            joined.extend(pairwise(line))
            near = np.asarray(line)
        else:
            near = np.asarray(line[:-1])
        # A lumen point is cleared when it lies within reach of the line
        # point nearest to it.
        reach = limits["clear_radii"] * wide[near] + limits["clear_mm"]
        still = np.flatnonzero(~cleared)
        away, nearest = cKDTree(place[near]).query(place[still], distance_upper_bound=reach.max())
        within = np.isfinite(away)
        within[within] = away[within] <= reach[nearest[within]]
        cleared[still[within]] = True
        cleared[end] = True
    return np.flatnonzero(on_line), joined
