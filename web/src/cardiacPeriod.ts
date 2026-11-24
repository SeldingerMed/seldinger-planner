/** The heart's period and each beat's quiet frames, read from the cine's
 * own frames and their recorded times, without a tree and without ECG.
 *
 * Retrospective image-based gating of X-ray sequences takes the cardiac
 * signal from the main modes of the image sequence (principal components)
 * rather than from an ECG. Here:
 * - each frame is block-averaged to a small grid and its slow shading is
 *   taken off, so vessel and heart edges carry the signal and a change of
 *   overall brightness does not;
 * - the frames' main modes over time are found (principal components of
 *   the frame sequence), each mode's slow trend is taken off (contrast
 *   filling, panning), and the mode whose time course repeats best within
 *   the heart's range of periods gives the period: its autocorrelation
 *   must rise again to a clear peak after falling, or no period is read;
 * - a cine that does not hold two whole periods, or whose frame times are
 *   uneven, gets no period;
 * - each beat's quiet frames are where the frames change least from one to
 *   the next, at one phase common to every beat. In a beat at rest that is
 *   diastasis, mid to late diastole, the phase coronary CT is usually
 *   reconstructed at.
 *
 * The period is a reading of the image, not an ECG. Nothing is forced:
 * where the frames do not repeat clearly, the answer is "not read". */
import type { CineFrame } from "./coronaryMotion";

export const CARDIAC_PERIOD_METHOD = "cine_heart_period_v2";
export const CARDIAC_PERIOD = {
  /** Heart periods looked for, milliseconds (40 to 180 beats a minute). */
  period_ms: [333, 1500] as [number, number],
  /** Frames are averaged down to at most this many pixels a side. */
  grid_px: 64,
  /** Half side of the box whose mean is the slow shading taken off. */
  shading_px: 3,
  /** Modes looked at, and the least share of the sequence's variance one
   * must carry. */
  modes: 6,
  min_mode_share: 0.02,
  /** Least autocorrelation at the period, and least rise from the lowest
   * point before it. */
  min_repeat: 0.45,
  min_rise: 0.35,
  /** Most a frame step may differ from the median step, as a share. */
  max_step_spread: 0.25,
  /** The cine must hold this many periods. */
  min_periods: 2.5,
  max_frames: 600,
};

export type CardiacPeriod =
  | {
      method: typeof CARDIAC_PERIOD_METHOD;
      status: "read";
      period_ms: number;
      /** Autocorrelation of the chosen mode at the period, 0 to 1. */
      repeat: number;
      /** One frame per beat, the quietest at the common phase. */
      quiet_frames: number[];
      step_ms: number;
    }
  | {
      method: typeof CARDIAC_PERIOD_METHOD;
      status: "not_read";
      reason: "too_short" | "uneven_times" | "no_rhythm";
      /** Best repeat found, where any mode could be read. */
      repeat: number | null;
    };

function validate(frames: readonly CineFrame[]) {
  if (
    !Array.isArray(frames) ||
    frames.length < 2 ||
    frames.length > CARDIAC_PERIOD.max_frames
  )
    throw new Error("A cine of 2 to 600 frames is required");
  const { width, height } = frames[0];
  let last = -Infinity;
  for (const f of frames) {
    if (
      f.width !== width ||
      f.height !== height ||
      !(f.pixels instanceof Uint8Array) ||
      f.pixels.length !== width * height
    )
      throw new Error("Cine frames differ in size");
    if (!(Number.isFinite(f.time_ms) && f.time_ms > last))
      throw new Error("Cine frame times must rise");
    last = f.time_ms;
  }
}

/** Each frame on the small grid with its slow shading taken off. */
function* edgeFrames(frames: readonly CineFrame[]): Generator<void, Float64Array[]> {
  const L = CARDIAC_PERIOD,
    { width, height } = frames[0],
    by = Math.max(1, Math.ceil(Math.max(width, height) / L.grid_px)),
    w = Math.floor(width / by),
    h = Math.floor(height / by),
    r = L.shading_px;
  const edges: Float64Array[] = [];
  for (const f of frames) {
    const small = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let dy = 0; dy < by; dy++)
          for (let dx = 0; dx < by; dx++)
            s += f.pixels[(y * by + dy) * width + x * by + dx];
        small[y * w + x] = s / (by * by);
      }
    // Box mean by running sums, edges clamped.
    const out = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0,
          n = 0;
        for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++)
          for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) {
            s += small[j * w + i];
            n++;
          }
        out[y * w + x] = small[y * w + x] - s / n;
      }
    edges.push(out);
    yield;
  }
  return edges;
}

/** Leading eigenvectors of a symmetric matrix by power iteration with
 * deflation; each with its eigenvalue. */
function* leading(
  G: Float64Array[],
  count: number,
): Generator<void, { value: number; vector: Float64Array }[]> {
  const n = G.length,
    found: { value: number; vector: Float64Array }[] = [];
  for (let k = 0; k < count; k++) {
    let v = Float64Array.from({ length: n }, (_, i) => 1 + ((i * 7919) % 13) / 13);
    let value = 0;
    for (let it = 0; it < 300; it++) {
      // Take off what earlier vectors explain.
      for (const f of found) {
        let d = 0;
        for (let i = 0; i < n; i++) d += f.vector[i] * v[i];
        for (let i = 0; i < n; i++) v[i] -= d * f.vector[i];
      }
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const row = G[i];
        for (let j = 0; j < n; j++) s += row[j] * v[j];
        next[i] = s;
      }
      for (const f of found) {
        let d = 0;
        for (let i = 0; i < n; i++) d += f.vector[i] * next[i];
        for (let i = 0; i < n; i++) next[i] -= d * f.vector[i];
      }
      let norm = 0;
      for (let i = 0; i < n; i++) norm += next[i] * next[i];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-12)) return found;
      let change = 0;
      for (let i = 0; i < n; i++) {
        const x = next[i] / norm;
        change += Math.abs(x - v[i]);
        next[i] = x;
      }
      v = next;
      value = norm;
      if (change < 1e-10) break;
      yield;
    }
    found.push({ value, vector: v });
  }
  return found;
}

/** The time course less its least-squares quadratic. */
function detrend(c: Float64Array): Float64Array {
  const n = c.length,
    t = (i: number) => (2 * i) / Math.max(1, n - 1) - 1;
  // Normal equations for a + b t + c t^2.
  const S = [0, 0, 0, 0, 0],
    R = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = t(i);
    for (let p = 0; p < 5; p++) S[p] += x ** p;
    for (let p = 0; p < 3; p++) R[p] += c[i] * x ** p;
  }
  const A = [
    [S[0], S[1], S[2]],
    [S[1], S[2], S[3]],
    [S[2], S[3], S[4]],
  ];
  // Cramer's rule on the 3 by 3 system.
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  const coef = [0, 1, 2].map((k) =>
    Math.abs(D) > 1e-12
      ? det(A.map((row, i) => row.map((v, j) => (j === k ? R[i] : v)))) / D
      : 0,
  );
  return Float64Array.from(
    c,
    (v, i) => v - coef[0] - coef[1] * t(i) - coef[2] * t(i) ** 2,
  );
}

/** Step-to-step change of a course. Slow movement (breathing, panning,
 * contrast filling) changes little from one frame to the next, the beat
 * a lot, so the change keeps the beat and drops most of the rest. */
const velocity = (c: Float64Array) =>
  Float64Array.from(c.subarray(1), (v, i) => v - c[i]);

/** Correlation of the course with itself `lag` steps later, over their
 * overlap. */
function repeatAt(c: Float64Array, lag: number): number {
  let ab = 0,
    aa = 0,
    bb = 0,
    ma = 0,
    mb = 0;
  const n = c.length - lag;
  for (let i = 0; i < n; i++) {
    ma += c[i];
    mb += c[i + lag];
  }
  ma /= n;
  mb /= n;
  for (let i = 0; i < n; i++) {
    const a = c[i] - ma,
      b = c[i + lag] - mb;
    ab += a * b;
    aa += a * a;
    bb += b * b;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** The period read in steps: it yields after each frame's edges, each row
 * of the frames' cross products and each power iteration, so a caller can
 * keep a long cine's read in short slices. The arithmetic is the same as
 * `cardiacPeriod`'s, which runs it to the end. */
export function* cardiacPeriodSteps(
  frames: readonly CineFrame[],
): Generator<void, CardiacPeriod> {
  validate(frames);
  const L = CARDIAC_PERIOD,
    n = frames.length;
  const notRead = (
    reason: "too_short" | "uneven_times" | "no_rhythm",
    repeat: number | null = null,
  ): CardiacPeriod => ({
    method: CARDIAC_PERIOD_METHOD,
    status: "not_read",
    reason,
    repeat,
  });
  const steps = frames
    .slice(1)
    .map((f, i) => f.time_ms - frames[i].time_ms)
    .sort((a, b) => a - b);
  const step = steps[steps.length >> 1];
  if (
    steps[0] < (1 - L.max_step_spread) * step ||
    steps[steps.length - 1] > (1 + L.max_step_spread) * step
  )
    return notRead("uneven_times");
  const duration = frames[n - 1].time_ms - frames[0].time_ms;
  if (duration < L.min_periods * L.period_ms[0]) return notRead("too_short");

  const edges = yield* edgeFrames(frames),
    size = edges[0].length;
  const mean = new Float64Array(size);
  for (const e of edges) for (let i = 0; i < size; i++) mean[i] += e[i] / n;
  const centred = edges.map((e) => Float64Array.from(e, (v, i) => v - mean[i]));
  const G: Float64Array[] = [];
  for (const a of centred) {
    G.push(
      Float64Array.from(centred, (b) => {
        let s = 0;
        for (let i = 0; i < size; i++) s += a[i] * b[i];
        return s;
      }),
    );
    yield;
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += G[i][i];
  if (!(total > 1e-9)) return notRead("no_rhythm");
  const modes = yield* leading(G, Math.min(L.modes, n - 1));

  const lo = Math.max(1, Math.ceil(L.period_ms[0] / step)),
    hi = Math.min(
      Math.floor(L.period_ms[1] / step),
      Math.floor((n - 1) / L.min_periods),
    );
  let best: { lag: number; repeat: number } | null = null,
    bestSeen: number | null = null;
  for (const mode of modes) {
    if (mode.value < L.min_mode_share * total) continue;
    const course = velocity(detrend(mode.vector));
    const r = [1];
    for (let lag = 1; lag <= hi + 1 && lag < n - 2; lag++)
      r.push(repeatAt(course, lag));
    let lowest = 1;
    for (let lag = 1; lag <= hi; lag++) {
      lowest = Math.min(lowest, r[lag]);
      if (lag < lo || lag + 1 >= r.length) continue;
      if (!(r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) continue;
      bestSeen = Math.max(bestSeen ?? -1, r[lag]);
      // A repeat must also stand clear of what chance gives over so short
      // an overlap (about two standard errors of a correlation).
      const chance = 2 / Math.sqrt(course.length - lag);
      if (
        r[lag] < Math.max(L.min_repeat, chance) ||
        r[lag] - lowest < L.min_rise
      )
        continue;
      // The first clear peak of this mode.
      const a = r[lag - 1],
        b = r[lag],
        c = r[lag + 1],
        d = a - 2 * b + c;
      const part = d < 0 ? Math.max(-0.5, Math.min(0.5, (a - c) / (2 * d))) : 0;
      if (!best || b > best.repeat) best = { lag: lag + part, repeat: b };
      break;
    }
  }
  if (!best) return notRead("no_rhythm", bestSeen);
  const period_ms = best.lag * step;
  if (duration < L.min_periods * period_ms) return notRead("too_short", best.repeat);

  // How much the frames change around each frame.
  const change = edges.map((_, k) => {
    const a = edges[Math.max(0, k - 1)],
      b = edges[Math.min(n - 1, k + 1)];
    let s = 0;
    for (let i = 0; i < size; i++) s += (a[i] - b[i]) ** 2;
    return Math.sqrt(s) / (Math.min(n - 1, k + 1) - Math.max(0, k - 1));
  });
  const smooth = change.map(
    (v, k) =>
      (change[Math.max(0, k - 1)] + 2 * v + change[Math.min(n - 1, k + 1)]) / 4,
  );
  // The phase, in frames after the first, at which every beat is quietest.
  const beat = best.lag;
  let offset = 0,
    quietest = Infinity;
  for (let o = 0; o < beat; o += 0.25) {
    let s = 0,
      m = 0;
    for (let t = o; t <= n - 1; t += beat) {
      const k = Math.round(t),
        f = t - Math.floor(t);
      s +=
        (1 - f) * smooth[Math.floor(t)] + f * smooth[Math.min(n - 1, Math.ceil(t))];
      m++;
      void k;
    }
    if (m && s / m < quietest) {
      quietest = s / m;
      offset = o;
    }
  }
  const quiet_frames: number[] = [];
  const reach = Math.max(1, Math.round(0.15 * beat));
  for (let t = offset; t <= n - 1 + 1e-9; t += beat) {
    const at = Math.round(t);
    let k = at;
    for (let j = Math.max(0, at - reach); j <= Math.min(n - 1, at + reach); j++)
      if (smooth[j] < smooth[k]) k = j;
    if (!quiet_frames.includes(k)) quiet_frames.push(k);
  }
  return {
    method: CARDIAC_PERIOD_METHOD,
    status: "read",
    period_ms,
    repeat: best.repeat,
    quiet_frames,
    step_ms: step,
  };
}

export function cardiacPeriod(frames: readonly CineFrame[]): CardiacPeriod {
  const steps = cardiacPeriodSteps(frames);
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
}
