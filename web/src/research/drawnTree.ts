/** The stand-in for the operator's drawn tree on a real cine, as fixed in
 * the Step E tracking evaluation: on the frame with the strongest dark
 * lines, the strongest line points at least 8 pixels apart, chained into
 * branches. Not tuned. */
import type { CineFrame, TreeBranch } from "../coronaryMotion";

/** Dark-line strength at every pixel: a ring's mean less the pixel's own
 * small neighbourhood, on a frame reduced to at most 512 pixels a side. */
export function lineMap(frame: CineFrame, ring = 5): Float32Array {
  const { width: w, height: h, pixels } = frame,
    out = new Float32Array(w * h);
  const offsets: [number, number][] = [];
  for (let j = -ring; j <= ring; j++)
    for (let i = -ring; i <= ring; i++) {
      const d = Math.hypot(i, j);
      if (d >= ring - 1 && d <= ring) offsets.push([i, j]);
    }
  for (let y = ring; y < h - ring; y++)
    for (let x = ring; x < w - ring; x++) {
      let s = 0;
      for (const [i, j] of offsets) s += pixels[(y + j) * w + x + i];
      const own =
        (pixels[y * w + x] * 4 +
          pixels[y * w + x - 1] +
          pixels[y * w + x + 1] +
          pixels[(y - 1) * w + x] +
          pixels[(y + 1) * w + x]) /
        8;
      out[y * w + x] = s / offsets.length - own;
    }
  return out;
}

export function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/** The stand-in for the operator's drawing. */
export function drawTree(frame: CineFrame): TreeBranch[] {
  const map = lineMap(frame),
    { width: w, height: h } = frame,
    border = 24,
    bar = 0.5 * percentile(map, 0.995);
  const order = Array.from(map.keys())
    .filter((i) => {
      const x = i % w,
        y = Math.floor(i / w);
      return (
        x >= border &&
        y >= border &&
        x < w - border &&
        y < h - border &&
        map[i] > bar
      );
    })
    .sort((a, b) => map[b] - map[a]);
  const chosen: number[][] = [];
  for (const i of order) {
    const p = [i % w, Math.floor(i / w)];
    if (chosen.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) >= 8))
      chosen.push(p);
    if (chosen.length >= 160) break;
  }
  // Chain: points within 14 pixels join; each group is walked from its
  // point furthest from its centre, nearest point next.
  const group = chosen.map((_, i) => i);
  const root = (i: number): number =>
    group[i] === i ? i : (group[i] = root(group[i]));
  for (let i = 0; i < chosen.length; i++)
    for (let j = i + 1; j < chosen.length; j++)
      if (
        Math.hypot(chosen[i][0] - chosen[j][0], chosen[i][1] - chosen[j][1]) <=
        14
      )
        group[root(i)] = root(j);
  const groups = new Map<number, number[][]>();
  chosen.forEach((p, i) => {
    const r = root(i);
    groups.set(r, [...(groups.get(r) ?? []), p]);
  });
  const branches: TreeBranch[] = [];
  for (const members of groups.values()) {
    if (members.length < 4) continue;
    const c = [0, 1].map(
      (j) => members.reduce((s, p) => s + p[j], 0) / members.length,
    );
    let at = members.reduce((best, p) =>
      Math.hypot(p[0] - c[0], p[1] - c[1]) >
      Math.hypot(best[0] - c[0], best[1] - c[1])
        ? p
        : best,
    );
    const left = members.filter((p) => p !== at),
      path = [at];
    while (left.length) {
      let k = 0;
      left.forEach((p, i) => {
        if (
          Math.hypot(p[0] - at[0], p[1] - at[1]) <
          Math.hypot(left[k][0] - at[0], left[k][1] - at[1])
        )
          k = i;
      });
      at = left.splice(k, 1)[0];
      path.push(at);
    }
    branches.push({ id: `b${branches.length}`, points: path });
  }
  return branches;
}

