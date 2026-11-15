/** Unnamed geometric segments of a binary vessel mask.
 *
 * Each connected piece of the mask is swept from one of its ends in bands
 * of path distance through the mask. The connected groups of voxels in a
 * band are the nodes of a coarse graph, and their centers lie on the vessel
 * axis. Runs of that graph between branchings and ends are cut into pieces
 * of bounded length.
 *
 * A segment is a stretch of vessel with a length and a mean radius. It has
 * an index and no name: nothing here identifies an artery, and the cuts
 * along an unbranched run are arbitrary. The medial points of `maskPoints`
 * are not used, because they leave gaps along thin oblique vessels and a
 * gap would end a segment where the vessel does not end. */
import { MASK_POINT_LIMITS, spacingOf } from "./maskPoints";

export const VESSEL_SEGMENT_LIMITS = {
  /** Width of one band of path distance. Raised to two voxel diagonals on a
   * coarser grid. A step through the mask is at most one diagonal, so no
   * step skips a band; the second diagonal is margin against a band too
   * thin to be one group across a vessel. */
  band_mm: 2,
  /** A connected piece of the mask shorter than this is left out. */
  min_piece_mm: 6,
  /** An end run shorter than this is taken into the branching it hangs
   * from. A local widening of a vessel shows up as such a stub, and so does
   * the place where a sweep starts in the middle of a loop. */
  min_end_run_mm: 4,
  /** Longer unbranched runs are cut into equal pieces at most this long. */
  max_segment_mm: 15,
  /** Spacing of the axis samples along each segment. */
  sample_mm: 1,
  max_segments: 2000,
} as const;

export type VesselSegment = {
  index: number;
  /** Along the centers of the segment's bands, in millimeters. Next to a
   * branching it can read long by up to a band, because the band at a
   * branching is centered between the vessels that meet there. */
  length_mm: number;
  /** Radius of the cylinder of this length that holds the segment's
   * volume. Thickened on a pooled grid, like the radii of `maskPoints`. */
  mean_radius_mm: number;
  /** Axis samples of this segment in `points`. */
  sample_count: number;
  /** The unbranched run the segment was cut from. Segments of one run
   * follow one another along a vessel with no branching between them. */
  run: number;
};
export type VesselSegments = {
  segments: VesselSegment[];
  /** Axis samples, x, y, z triples in the RAS millimeters of the grid. */
  points: Float32Array;
  /** The segment index of each axis sample. */
  labels: Int32Array;
  /** Share of the mask's volume that is in no segment. */
  unassigned_fraction: number;
  /** Grid voxels per measured cell along each axis. */
  pooling: number;
};

/** Smallest-first queue of (key, value) pairs. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, value: number) {
    const { keys, values } = this;
    let at = keys.length;
    keys.push(key);
    values.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[at] = keys[parent];
      values[at] = values[parent];
      at = parent;
    }
    keys[at] = key;
    values[at] = value;
  }
  pop(): [number, number] {
    const { keys, values } = this,
      top: [number, number] = [keys[0], values[0]],
      key = keys.pop()!,
      value = values.pop()!,
      count = keys.length;
    if (count > 0) {
      let at = 0;
      for (;;) {
        let child = 2 * at + 1;
        if (child >= count) break;
        if (child + 1 < count && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= key) break;
        keys[at] = keys[child];
        values[at] = values[child];
        at = child;
      }
      keys[at] = key;
      values[at] = value;
    }
    return top;
  }
}

/** Resumable segmentation. `mask` is nonzero inside the vessel, x fastest. */
export function* vesselSegmentSteps(
  mask: ArrayLike<number>,
  shape: readonly [number, number, number],
  affine: number[][],
): Generator<void, VesselSegments> {
  const L = VESSEL_SEGMENT_LIMITS,
    G = MASK_POINT_LIMITS,
    [nx, ny, nz] = shape;
  if (
    shape.length !== 3 ||
    shape.some((n) => !Number.isInteger(n) || n < 1 || n > 2048) ||
    nx * ny * nz > G.max_grid_voxels ||
    mask.length !== nx * ny * nz
  )
    throw new Error("Vessel mask grid is outside the supported range");
  const spacing = spacingOf(affine);
  const low = [nx, ny, nz],
    high = [-1, -1, -1];
  let foreground = 0;
  for (let z = 0, at = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, at++) {
        const value = mask[at];
        if (!Number.isFinite(value)) throw new Error("Nonfinite vessel mask");
        if (value === 0) continue;
        foreground++;
        if (x < low[0]) low[0] = x;
        if (y < low[1]) low[1] = y;
        if (z < low[2]) low[2] = z;
        if (x > high[0]) high[0] = x;
        if (y > high[1]) high[1] = y;
        if (z > high[2]) high[2] = z;
      }
    if ((z & 15) === 15) yield;
  }
  if (foreground < G.min_points)
    throw new Error("Vessel mask is empty or too small");
  // The vessels' bounding box, pooled as `maskPoints` pools it.
  let pooling = 1,
    box = [0, 0, 0];
  for (; ; pooling++) {
    if (pooling > G.max_pooling)
      throw new Error("Vessel mask extent exceeds the supported size");
    box = [0, 1, 2].map((i) => Math.floor((high[i] - low[i]) / pooling) + 1);
    if (box[0] * box[1] * box[2] <= G.max_box_voxels) break;
  }
  const [bx, by, bz] = box,
    cell = spacing.map((value) => value * pooling),
    cellVolume = cell[0] * cell[1] * cell[2];
  // Compact numbering of the vessel cells.
  const numberOf = new Int32Array(bx * by * bz).fill(-1);
  let cells = 0;
  for (let z = low[2]; z <= high[2]; z++) {
    const cz = Math.floor((z - low[2]) / pooling);
    for (let y = low[1]; y <= high[1]; y++) {
      const row = bx * (Math.floor((y - low[1]) / pooling) + by * cz);
      for (let x = low[0]; x <= high[0]; x++)
        if (mask[x + nx * (y + ny * z)] !== 0) {
          const at = Math.floor((x - low[0]) / pooling) + row;
          if (numberOf[at] === -1) numberOf[at] = cells++;
        }
    }
    if ((z & 15) === 15) yield;
  }
  const where = new Int32Array(cells);
  for (let at = 0; at < numberOf.length; at++)
    if (numberOf[at] !== -1) where[numberOf[at]] = at;
  // The 26 neighbors of a cell, with the length of the step to each.
  const steps: { dx: number; dy: number; dz: number; mm: number }[] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (dx || dy || dz)
          steps.push({
            dx,
            dy,
            dz,
            mm: Math.hypot(dx * cell[0], dy * cell[1], dz * cell[2]),
          });
  const reachable = new Int32Array(26),
    stepMm = new Float64Array(26);
  /** Fills `reachable` with the vessel cells next to cell `i`. */
  function neighbors(i: number): number {
    const at = where[i],
      x = at % bx,
      y = Math.floor(at / bx) % by,
      z = Math.floor(at / (bx * by));
    let found = 0;
    for (const { dx, dy, dz, mm } of steps) {
      const X = x + dx,
        Y = y + dy,
        Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= bx || Y >= by || Z >= bz) continue;
      const j = numberOf[X + bx * (Y + by * Z)];
      if (j === -1) continue;
      reachable[found] = j;
      stepMm[found++] = mm;
    }
    return found;
  }
  /** Center of cell `i` in RAS millimeters, added into `sum`. */
  function addCenter(i: number, sum: number[]) {
    const at = where[i],
      middle = (pooling - 1) / 2,
      x = (at % bx) * pooling + low[0] + middle,
      y = (Math.floor(at / bx) % by) * pooling + low[1] + middle,
      z = Math.floor(at / (bx * by)) * pooling + low[2] + middle;
    for (let a = 0; a < 3; a++)
      sum[a] +=
        affine[a][0] * x + affine[a][1] * y + affine[a][2] * z + affine[a][3];
  }
  /** Path distance from cell `from` to every cell connected with it. */
  function* sweep(from: number, distance: Float64Array, reached: number[]) {
    const queue = new Heap();
    distance[from] = 0;
    queue.push(0, from);
    for (let turn = 1; queue.size; turn++) {
      const [d, i] = queue.pop();
      if (d > distance[i]) continue;
      reached.push(i);
      const found = neighbors(i);
      for (let k = 0; k < found; k++) {
        const j = reachable[k],
          next = d + stepMm[k];
        if (next < distance[j]) {
          distance[j] = next;
          queue.push(next, j);
        }
      }
      if ((turn & 8191) === 0) yield;
    }
  }

  const width = Math.max(L.band_mm, 2 * Math.hypot(cell[0], cell[1], cell[2])),
    seen = new Uint8Array(cells),
    scratch = new Float64Array(cells).fill(Infinity),
    distance = new Float64Array(cells).fill(Infinity),
    nodeOf = new Int32Array(cells).fill(-1),
    segments: VesselSegment[] = [],
    samples: number[] = [],
    labels: number[] = [];
  let unassigned = 0,
    cut = 0;

  for (let seed = 0; seed < cells; seed++) {
    if (seen[seed]) continue;
    // One connected piece. Sweep from its seed to find an end, then from
    // that end: the bands of the second sweep lie across the vessels.
    const first: number[] = [];
    yield* sweep(seed, scratch, first);
    let end = seed;
    for (const i of first) {
      seen[i] = 1;
      if (scratch[i] > scratch[end]) end = i;
    }
    const piece: number[] = [];
    yield* sweep(end, distance, piece);
    if (distance[piece[piece.length - 1]] < L.min_piece_mm) {
      unassigned += piece.length;
      continue;
    }

    // Nodes: connected groups of cells within one band.
    const band = (i: number) => Math.floor(distance[i] / width),
      size: number[] = [],
      center: number[][] = [],
      joined: Set<number>[] = [];
    for (const start of piece) {
      if (nodeOf[start] !== -1) continue;
      const node = size.length,
        group = [start],
        sum = [0, 0, 0],
        links = new Set<number>();
      nodeOf[start] = node;
      for (let at = 0; at < group.length; at++) {
        addCenter(group[at], sum);
        const found = neighbors(group[at]);
        for (let k = 0; k < found; k++) {
          const j = reachable[k];
          if (nodeOf[j] === -1 && band(j) === band(start)) {
            nodeOf[j] = node;
            group.push(j);
          } else if (nodeOf[j] !== -1 && nodeOf[j] !== node)
            links.add(nodeOf[j]);
        }
      }
      size.push(group.length);
      center.push(sum.map((value) => value / group.length));
      joined.push(links);
      // Cells are visited in order of distance, so every neighbor in a
      // nearer band already has its node.
      for (const other of links) joined[other].add(node);
      if ((node & 255) === 255) yield;
    }
    const nodes = size.length,
      between = (a: number, b: number) =>
        Math.hypot(
          center[a][0] - center[b][0],
          center[a][1] - center[b][1],
          center[a][2] - center[b][2],
        );

    // End runs too short to be vessels leave the graph, and their volume
    // goes to the branching they hang from.
    const alive = new Uint8Array(nodes).fill(1);
    for (let changed = true; changed;) {
      changed = false;
      for (let tip = 0; tip < nodes; tip++) {
        if (!alive[tip] || joined[tip].size !== 1) continue;
        const run = [tip];
        let length = 0,
          at = tip,
          next = [...joined[tip]][0];
        while (joined[next].size === 2) {
          length += between(at, next);
          run.push(next);
          const [a, b] = [...joined[next]];
          [at, next] = [next, a === at ? b : a];
        }
        length += between(at, next);
        // `next` is a branching, or the far end of an unbranched piece.
        if (joined[next].size < 3 || length >= L.min_end_run_mm) continue;
        for (const node of run) {
          alive[node] = 0;
          size[next] += size[node];
          for (const other of joined[node]) joined[other].delete(node);
          joined[node].clear();
        }
        changed = true;
      }
    }

    // Runs between branchings and ends.
    type Run = { nodes: number[]; length: number };
    const runs: Run[] = [],
      used = new Set<number>(),
      edge = (a: number, b: number) => (a < b ? a * nodes + b : b * nodes + a);
    const follow = (from: number, toward: number) => {
      const run: Run = { nodes: [from], length: 0 };
      let at = from,
        next = toward;
      for (;;) {
        used.add(edge(at, next));
        run.length += between(at, next);
        run.nodes.push(next);
        if (joined[next].size !== 2 || next === from) break;
        const [a, b] = [...joined[next]];
        [at, next] = [next, a === at ? b : a];
      }
      runs.push(run);
    };
    for (let node = 0; node < nodes; node++)
      if (alive[node] && joined[node].size !== 2)
        for (const toward of [...joined[node]].sort((a, b) => a - b))
          if (!used.has(edge(node, toward))) follow(node, toward);
    // What is left unvisited is a closed loop with no branching.
    for (let node = 0; node < nodes; node++)
      if (alive[node] && joined[node].size === 2) {
        const toward = Math.min(...joined[node]);
        if (!used.has(edge(node, toward))) follow(node, toward);
      }

    // Cut each run into pieces of equal length. A node shared by several
    // runs, a branching, gives its volume to the first piece that reaches
    // it.
    const taken = new Uint8Array(nodes);
    for (const run of runs) {
      if (run.length === 0) continue;
      const pieces = Math.ceil(run.length / L.max_segment_mm),
        each = run.length / pieces,
        base = segments.length,
        volume = new Float64Array(pieces),
        pieceAt = (along: number) =>
          Math.min(pieces - 1, Math.floor(along / each));
      if (base + pieces > L.max_segments)
        throw new Error("Vessel mask has too many segments");
      let along = 0;
      for (let k = 0; k < run.nodes.length; k++) {
        const node = run.nodes[k];
        if (k > 0) {
          // Axis samples from the previous node's center to this one's.
          const a = center[run.nodes[k - 1]],
            b = center[node],
            span = between(run.nodes[k - 1], node);
          for (
            let s = Math.ceil(along / L.sample_mm) * L.sample_mm;
            s < along + span ||
            (k === run.nodes.length - 1 && s <= along + span);
            s += L.sample_mm
          ) {
            const t = span === 0 ? 0 : (s - along) / span;
            samples.push(
              a[0] + t * (b[0] - a[0]),
              a[1] + t * (b[1] - a[1]),
              a[2] + t * (b[2] - a[2]),
            );
            labels.push(base + pieceAt(s));
          }
          along += span;
        }
        if (!taken[node]) {
          taken[node] = 1;
          volume[pieceAt(along)] += size[node] * cellVolume;
        }
      }
      for (let k = 0; k < pieces; k++)
        segments.push({
          index: base + k,
          length_mm: each,
          mean_radius_mm: Math.sqrt(volume[k] / (Math.PI * each)),
          sample_count: 0,
          run: cut,
        });
      cut++;
    }
    for (let node = 0; node < nodes; node++)
      if (alive[node] && !taken[node]) unassigned += size[node];
    yield;
  }
  for (const label of labels) segments[label].sample_count++;
  return {
    segments,
    points: Float32Array.from(samples),
    labels: Int32Array.from(labels),
    unassigned_fraction: unassigned / cells,
    pooling,
  };
}

/** One-shot segmentation. Interactive callers step `vesselSegmentSteps`. */
export function vesselSegments(
  mask: ArrayLike<number>,
  shape: readonly [number, number, number],
  affine: number[][],
): VesselSegments {
  const steps = vesselSegmentSteps(mask, shape, affine);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
