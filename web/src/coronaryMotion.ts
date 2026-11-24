/** A coronary tree that moves with the heart over a cine, as one proposal
 * for the operator to confirm.
 *
 * The operator's tree is drawn on one frame of the cine, the reference: the
 * frame a 2D-to-3D proposal was confirmed on, or a frame the operator chose.
 * The CT behind it is one cardiac phase and the cine spans the cycle, so a
 * tree that stays where it was drawn is right at that phase only.
 *
 * Here each point of the tree keeps its identity (its branch and its place
 * along it, the branch correspondence) and is followed over the cine:
 * - each point's picture around it in the reference frame is looked for in
 *   every other frame, near where it lay in the frame before;
 * - the found shifts are smoothed over neighbouring points of the tree, so
 *   the tree bends and stretches but does not tear (non-rigid);
 * - a frame where the tree is not found well (contrast gone, a wrong frame,
 *   a jump) is refused and shows no tree, rather than a wrong one;
 * - the frames' times give the heart's period, read from when the tree
 *   comes back to where it was, and the frames at the reference's phase are
 *   named, each the frame near its beat where the tree lies nearest its
 *   drawn place: there the drawn tree and the CT hold. */

export const CORONARY_MOTION_METHOD = "coronary_tree_tracking_v1";
export const CORONARY_MOTION = {
  /** Half side of the square picture kept around each point, pixels. */
  patch: 7,
  /** Furthest a point is looked for from where it lay in the frame before. */
  search: 12,
  /** Points of a branch within this distance share their bending. */
  neighbour_px: 24,
  /** A point found this far across its vessel from its branch is set aside. */
  outlier_px: 4,
  /** Least median match of the tree's points for a frame to be kept. */
  min_match: 0.6,
  /** Most share of points set aside for a frame to be kept. */
  max_outliers: 0.4,
  /** Heart periods looked for, milliseconds (40 to 180 beats a minute). */
  period_ms: [333, 1500],
  max_points: 400,
  max_frames: 600,
} as const;

export type CineFrame = {
  /** 8-bit brightness, rows from the top, contrast dark. */
  pixels: Uint8Array;
  width: number;
  height: number;
  /** From the start of the cine. */
  time_ms: number;
};
export type TreeBranch = { id: string; points: number[][] };
export type TrackedFrame =
  | {
      status: "reference" | "tracked";
      match: number;
      outliers: number;
      /** Mean distance of the tree from its drawn place, pixels. */
      moved_px: number;
      branches: TreeBranch[];
    }
  | {
      status: "refused";
      reason: "low_match" | "torn";
      match: number;
      outliers: number;
    };
export type CoronaryMotionProposal = {
  method: typeof CORONARY_MOTION_METHOD;
  reference: number;
  frames: TrackedFrame[];
  /** Null where the cine does not hold two beats the tree was found in. */
  period_ms: number | null;
  /** Frames at the reference's phase, by the period, nearest first. */
  phase_matched: number[];
};
export type CoronaryMotionJob = {
  advance(expired: () => boolean): boolean;
  result(): CoronaryMotionProposal;
};

type Point = { branch: number; at: number; x: number; y: number };

function patchAt(
  frame: CineFrame,
  x: number,
  y: number,
  r: number,
): Float64Array | null {
  const cx = Math.round(x),
    cy = Math.round(y);
  if (
    cx - r < 0 ||
    cy - r < 0 ||
    cx + r >= frame.width ||
    cy + r >= frame.height
  )
    return null;
  const side = 2 * r + 1,
    out = new Float64Array(side * side);
  let k = 0,
    mean = 0;
  for (let j = -r; j <= r; j++)
    for (let i = -r; i <= r; i++) {
      const v = frame.pixels[(cy + j) * frame.width + cx + i];
      out[k++] = v;
      mean += v;
    }
  mean /= out.length;
  let norm = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    norm += out[i] * out[i];
  }
  if (!(norm > 1e-6)) return null;
  norm = Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Best normalized correlation of `template` in `frame` within `search` of
 * (x, y), refined to a part pixel. */
function find(
  frame: CineFrame,
  template: Float64Array,
  x: number,
  y: number,
  r: number,
  search: number,
): { x: number; y: number; match: number } {
  const side = 2 * r + 1,
    n = side * side,
    w = frame.width,
    cx = Math.round(x),
    cy = Math.round(y),
    span = 2 * search + 1,
    scores = new Float64Array(span * span).fill(-2);
  let best = -2,
    bx = 0,
    by = 0;
  for (let dy = -search; dy <= search; dy++)
    for (let dx = -search; dx <= search; dx++) {
      const px = cx + dx,
        py = cy + dy;
      if (px - r < 0 || py - r < 0 || px + r >= w || py + r >= frame.height)
        continue;
      let sum = 0,
        sum2 = 0,
        dot = 0,
        k = 0;
      for (let j = -r; j <= r; j++) {
        const row = (py + j) * w + px;
        for (let i = -r; i <= r; i++) {
          const v = frame.pixels[row + i];
          sum += v;
          sum2 += v * v;
          dot += v * template[k++];
        }
      }
      const variance = sum2 - (sum * sum) / n;
      if (!(variance > 1e-6)) continue;
      // The template sums to zero, so the patch's mean drops out of `dot`.
      const score = dot / Math.sqrt(variance);
      scores[(dy + search) * span + dx + search] = score;
      if (score > best) {
        best = score;
        bx = dx;
        by = dy;
      }
    }
  // A parabola through the best score and its neighbours along each axis.
  const at = (dx: number, dy: number) =>
    Math.abs(dx) > search || Math.abs(dy) > search
      ? -2
      : scores[(dy + search) * span + dx + search];
  const part = (a: number, b: number, c: number) => {
    const d = a - 2 * b + c;
    return a > -2 && c > -2 && d < 0
      ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)))
      : 0;
  };
  return {
    x: cx + bx + part(at(bx - 1, by), best, at(bx + 1, by)),
    y: cy + by + part(at(bx, by - 1), best, at(bx, by + 1)),
    match: best,
  };
}

function validate(input: {
  frames: readonly CineFrame[];
  reference: number;
  branches: readonly TreeBranch[];
}): Point[] {
  const { frames, reference, branches } = input,
    L = CORONARY_MOTION;
  if (
    !Array.isArray(frames) ||
    frames.length < 2 ||
    frames.length > L.max_frames
  )
    throw new Error("A cine of 2 to 600 frames is required");
  const { width, height } = frames[0];
  let last = -Infinity;
  for (const frame of frames) {
    if (
      frame.width !== width ||
      frame.height !== height ||
      !(frame.pixels instanceof Uint8Array) ||
      frame.pixels.length !== width * height
    )
      throw new Error("Cine frames differ in size");
    if (!(Number.isFinite(frame.time_ms) && frame.time_ms > last))
      throw new Error("Cine frame times must rise");
    last = frame.time_ms;
  }
  if (
    !Number.isInteger(reference) ||
    reference < 0 ||
    reference >= frames.length
  )
    throw new Error("Invalid reference frame");
  const points: Point[] = [];
  branches.forEach((branch, b) =>
    branch.points.forEach((p, at) => {
      if (
        p.length !== 2 ||
        !p.every(Number.isFinite) ||
        p[0] < 0 ||
        p[1] < 0 ||
        p[0] > width - 1 ||
        p[1] > height - 1
      )
        throw new Error("Tree point outside the frame");
      points.push({ branch: b, at, x: p[0], y: p[1] });
    }),
  );
  if (points.length < 3 || points.length > L.max_points)
    throw new Error("A tree of 3 to 400 points is required");
  return points;
}

/** Solves a small linear system by elimination; null when singular. */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length,
    M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (!(Math.abs(M[pivot][c]) > 1e-9)) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const k = M[r][c] / M[c][c];
        for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
      }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Least-squares affine map from points to their found places,
 * x' = a x + b y + c, y' = d x + e y + f, counting each find across its
 * vessel fully and along it by `ALONG` only, since along a vessel a find
 * can slide. Null when the points do not fix the map. */
const ALONG = 0.05;
function fitAffine(
  from: number[][],
  to: number[][],
  weights: number[],
  normals: number[][],
): number[] | null {
  const A = Array.from({ length: 6 }, () => new Array(6).fill(0)),
    b = new Array(6).fill(0);
  for (let i = 0; i < from.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    const [x, y] = from[i],
      [nx, ny] = normals[i];
    for (const [ux, uy, k] of [
      [nx, ny, 1],
      [ny, -nx, ALONG],
    ]) {
      const row = [ux * x, ux * y, ux, uy * x, uy * y, uy],
        target = ux * to[i][0] + uy * to[i][1];
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 6; c++) A[r][c] += w * k * row[r] * row[c];
        b[r] += w * k * row[r] * target;
      }
    }
  }
  return solveLinear(A, b);
}

/** Movement of the tree in one frame.
 *
 * A point found on a vessel can slide along it without its picture
 * changing, so a point's own find is trusted only across its vessel. The
 * whole tree's movement is an affine map fitted to every point's find:
 * branches run in different directions, so together they fix it. Each
 * point then keeps its own movement across its vessel, smoothed with its
 * neighbours along the branch: that is the bending the map does not carry.
 * A point whose find lies far across its vessel from that is set aside. */
function trackFrame(
  frame: CineFrame,
  templates: (Float64Array | null)[],
  points: Point[],
  normals: number[][],
  along: number[][],
  from: number[][],
): { at: number[][]; match: number; outliers: number } {
  const L = CORONARY_MOTION;
  const raw = points.map((_, i) => {
    const t = templates[i];
    return t ? find(frame, t, from[i][0], from[i][1], L.patch, L.search) : null;
  });
  const matches = raw
    .filter((r) => r !== null)
    .map((r) => r!.match)
    .sort((a, b) => a - b);
  const match = matches.length ? matches[matches.length >> 1] : -1;
  const drawn = points.map((p) => [p.x, p.y]);
  const found = raw.map((r, i) => (r ? [r.x, r.y] : from[i]));
  let weights = raw.map((r) => (r && r.match > 0 ? r.match ** 2 : 0));
  const mapped = (m: number[], p: number[]) => [
    m[0] * p[0] + m[1] * p[1] + m[2],
    m[3] * p[0] + m[4] * p[1] + m[5],
  ];
  const across = (m: number[]) =>
    points.map((_, i) => {
      const q = mapped(m, drawn[i]);
      return (
        (found[i][0] - q[0]) * normals[i][0] +
        (found[i][1] - q[1]) * normals[i][1]
      );
    });
  let map = fitAffine(drawn, found, weights, normals);
  if (!map) return { at: from, match: -1, outliers: 1 };
  // Set aside what lies far across its vessel from the map, and fit again.
  let off = across(map);
  const keep = weights.map(
    (w, i) => w > 0 && Math.abs(off[i]) <= L.outlier_px * 2,
  );
  weights = weights.map((w, i) => (keep[i] ? w : 0));
  map = fitAffine(drawn, found, weights, normals) ?? map;
  off = across(map);
  // Across-vessel bending, smoothed along the branch.
  const bend = points.map((_, i) => {
    let s = 0,
      sw = 0;
    for (const j of along[i])
      if (weights[j] > 0 && Math.abs(off[j]) <= L.outlier_px) {
        s += weights[j] * off[j];
        sw += weights[j];
      }
    return sw > 0 ? s / sw : 0;
  });
  const outliers =
    points.filter(
      (_, i) => !(weights[i] > 0) || Math.abs(off[i] - bend[i]) > L.outlier_px,
    ).length / points.length;
  const at = points.map((_, i) => {
    const q = mapped(map, drawn[i]);
    return [q[0] + bend[i] * normals[i][0], q[1] + bend[i] * normals[i][1]];
  });
  return { at, match, outliers };
}

/** The heart's period from the tree's places over time: the time lag,
 * within the heart's range, after which the tree's shape comes back nearest
 * to what it was. The places are taken at even times by straight lines between the
 * frames it was found in. Null where the tree does not come back: the
 * nearest return must be under half the furthest the tree went before it. */
export function periodFromTrees(
  times_ms: readonly number[],
  trees: readonly (number[][] | null)[],
): number | null {
  const L = CORONARY_MOTION;
  const known = trees
    .map((tree, i) => (tree ? { t: times_ms[i], tree } : null))
    .filter((k): k is { t: number; tree: number[][] } => k !== null);
  if (known.length < 6) return null;
  const gaps = known
    .slice(1)
    .map((k, i) => k.t - known[i].t)
    .sort((a, b) => a - b);
  const step = gaps[gaps.length >> 1],
    first = known[0].t,
    last = known[known.length - 1].t;
  if (!(step > 0) || last - first < 1.5 * L.period_ms[0]) return null;
  const even: number[][][] = [];
  for (let t = first, k = 0; t <= last + 1e-9; t += step) {
    while (k < known.length - 2 && known[k + 1].t < t) k++;
    const a = known[k],
      b = known[k + 1],
      s = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
    const tree = a.tree.map((p, i) =>
      [0, 1].map((j) => p[j] + s * (b.tree[i][j] - p[j])),
    );
    // The tree's shape, its centre taken off: breathing and table moves
    // shift the whole tree, the beat changes its shape.
    const centre = [0, 1].map(
      (j) => tree.reduce((sum, p) => sum + p[j], 0) / tree.length,
    );
    even.push(tree.map((p) => [p[0] - centre[0], p[1] - centre[1]]));
  }
  const apart = (lag: number) => {
    let total = 0,
      n = 0;
    for (let i = 0; i + lag < even.length; i++) {
      const a = even[i],
        b = even[i + lag];
      let d = 0;
      for (let k = 0; k < a.length; k++)
        d += Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]);
      total += d / a.length;
      n++;
    }
    return n ? total / n : Infinity;
  };
  const top = Math.min(Math.floor(L.period_ms[1] / step), even.length - 3);
  const D = [0];
  for (let lag = 1; lag <= top + 1; lag++) D.push(apart(lag));
  let furthest = 0;
  for (let lag = 1; lag <= top; lag++) {
    furthest = Math.max(furthest, D[lag - 1]);
    if (lag * step < L.period_ms[0]) continue;
    if (
      D[lag] <= D[lag - 1] &&
      D[lag] <= D[lag + 1] &&
      D[lag] < 0.5 * furthest
    ) {
      const a = D[lag - 1],
        b = D[lag],
        c = D[lag + 1],
        d = a - 2 * b + c;
      const part =
        Number.isFinite(c) && d > 0
          ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d)))
          : 0;
      return (lag + part) * step;
    }
  }
  return null;
}

/** Mean distance between two trees' points with each tree's centre taken
 * off. */
function shapeApart(a: number[][], b: number[][]): number {
  const centre = (t: number[][]) =>
    [0, 1].map((j) => t.reduce((s, p) => s + p[j], 0) / t.length);
  const ca = centre(a),
    cb = centre(b);
  return (
    a.reduce(
      (s, p, i) =>
        s +
        Math.hypot(
          p[0] - ca[0] - b[i][0] + cb[0],
          p[1] - ca[1] - b[i][1] + cb[1],
        ),
      0,
    ) / a.length
  );
}

export function createCoronaryMotionJob(input: {
  frames: readonly CineFrame[];
  reference: number;
  branches: readonly TreeBranch[];
}): CoronaryMotionJob {
  const points = validate(input),
    { frames, reference, branches } = input,
    L = CORONARY_MOTION;
  const ref = frames[reference];
  const templates = points.map((p) => patchAt(ref, p.x, p.y, L.patch));
  if (templates.filter(Boolean).length < 3)
    throw new Error("The tree is not seen in the reference frame");
  // Across each point's vessel, from its neighbours on its branch.
  const normals = points.map((p, i) => {
    const before = points[i - 1]?.branch === p.branch ? points[i - 1] : p,
      after = points[i + 1]?.branch === p.branch ? points[i + 1] : p,
      tx = after.x - before.x,
      ty = after.y - before.y,
      n = Math.hypot(tx, ty);
    return n > 0 ? [-ty / n, tx / n] : [0, 0];
  });
  const along = points.map((p) =>
    points
      .map((q, j) =>
        q.branch === p.branch &&
        Math.hypot(p.x - q.x, p.y - q.y) <= L.neighbour_px
          ? j
          : -1,
      )
      .filter((j) => j >= 0),
  );
  const drawn = points.map((p) => [p.x, p.y]);
  const out: (TrackedFrame | null)[] = frames.map(() => null);
  out[reference] = {
    status: "reference",
    match: 1,
    outliers: 0,
    moved_px: 0,
    branches: branches.map((b) => ({
      id: b.id,
      points: b.points.map((p) => [...p]),
    })),
  };
  // Outward from the reference, each way, from the last frame kept.
  const order: { index: number; side: 1 | -1 }[] = [];
  for (let k = 1; k < frames.length; k++) {
    if (reference + k < frames.length)
      order.push({ index: reference + k, side: 1 });
    if (reference - k >= 0) order.push({ index: reference - k, side: -1 });
  }
  const lastKept = { 1: drawn, [-1]: drawn } as Record<1 | -1, number[][]>;
  let next = 0,
    done: CoronaryMotionProposal | null = null;

  const toBranches = (at: number[][]): TreeBranch[] =>
    branches.map((b, k) => ({
      id: b.id,
      points: points
        .map((p, i) => (p.branch === k ? at[i] : null))
        .filter((p): p is number[] => p !== null),
    }));

  const finish = (): CoronaryMotionProposal => {
    const frameList = out as TrackedFrame[];
    const times = frames.map((f) => f.time_ms);
    const trees = frameList.map((f) =>
      f.status === "refused" ? null : f.branches.flatMap((b) => b.points),
    );
    const period = periodFromTrees(times, trees);
    const phase_matched: number[] = [];
    if (period !== null) {
      // For each beat, of the frames found near it by the period, the one
      // whose tree's shape is nearest the drawn one.
      const t0 = times[reference],
        reach = 0.15 * period;
      const beats = new Set<number>();
      frameList.forEach((f, i) => {
        if (i !== reference && f.status !== "refused") {
          const n = Math.round((times[i] - t0) / period);
          if (n !== 0 && Math.abs(times[i] - t0 - n * period) <= reach)
            beats.add(n);
        }
      });
      for (const n of beats) {
        let best = -1,
          bestMoved = Infinity;
        frameList.forEach((f, i) => {
          if (f.status === "refused" || i === reference) return;
          if (Math.abs(times[i] - t0 - n * period) > reach) return;
          const apart = shapeApart(
            f.branches.flatMap((b) => b.points),
            drawn,
          );
          if (apart < bestMoved) {
            bestMoved = apart;
            best = i;
          }
        });
        if (best >= 0) phase_matched.push(best);
      }
      phase_matched.sort(
        (a, b) => Math.abs(a - reference) - Math.abs(b - reference),
      );
    }
    return {
      method: CORONARY_MOTION_METHOD,
      reference,
      frames: frameList,
      period_ms: period,
      phase_matched,
    };
  };

  return {
    advance(expired) {
      while (next < order.length) {
        const { index, side } = order[next++];
        const tracked = trackFrame(
          frames[index],
          templates,
          points,
          normals,
          along,
          lastKept[side],
        );
        if (tracked.match < L.min_match)
          out[index] = {
            status: "refused",
            reason: "low_match",
            match: tracked.match,
            outliers: tracked.outliers,
          };
        else if (tracked.outliers > L.max_outliers)
          out[index] = {
            status: "refused",
            reason: "torn",
            match: tracked.match,
            outliers: tracked.outliers,
          };
        else {
          lastKept[side] = tracked.at;
          const moved =
            tracked.at.reduce(
              (s, p, i) =>
                s + Math.hypot(p[0] - drawn[i][0], p[1] - drawn[i][1]),
              0,
            ) / drawn.length;
          out[index] = {
            status: "tracked",
            match: tracked.match,
            outliers: tracked.outliers,
            moved_px: moved,
            branches: toBranches(tracked.at),
          };
        }
        if (next < order.length && expired()) return false;
      }
      if (!done) done = finish();
      return true;
    },
    result() {
      if (!done) throw new Error("Tracking is not complete");
      return done;
    },
  };
}

export function proposeCoronaryMotion(
  input: Parameters<typeof createCoronaryMotionJob>[0],
): CoronaryMotionProposal {
  const job = createCoronaryMotionJob(input);
  job.advance(() => false);
  return job.result();
}

/** How strongly the frame shows a dark vessel at each point: the mean of a
 * ring around the point less the point's own small neighbourhood, in
 * brightness levels. A measure of image evidence for an overlay, not a
 * part of the tracking. */
export function vesselEvidence(
  frame: Pick<CineFrame, "pixels" | "width" | "height">,
  points: readonly number[][],
  inner = 1,
  ring = 6,
): number {
  let total = 0,
    count = 0;
  for (const [x, y] of points) {
    const cx = Math.round(x),
      cy = Math.round(y);
    if (
      cx - ring < 0 ||
      cy - ring < 0 ||
      cx + ring >= frame.width ||
      cy + ring >= frame.height
    )
      continue;
    let a = 0,
      na = 0,
      b = 0,
      nb = 0;
    for (let j = -ring; j <= ring; j++)
      for (let i = -ring; i <= ring; i++) {
        const d = Math.hypot(i, j),
          v = frame.pixels[(cy + j) * frame.width + cx + i];
        if (d <= inner) {
          a += v;
          na++;
        } else if (d >= ring - 1 && d <= ring) {
          b += v;
          nb++;
        }
      }
    total += b / nb - a / na;
    count++;
  }
  return count ? total / count : 0;
}
