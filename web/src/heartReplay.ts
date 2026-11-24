/** The replay's heart motion: the parts of following the saved proposal's
 * vessel axis over a coronary cine that do not touch the page. The cine is
 * the stretch of the recording around the saved frame where the C-arm
 * stands as it did there; the tree is the axis as it falls on the saved
 * frame. The tracking itself is ./coronaryMotion.ts. */
import {
  CORONARY_MOTION,
  type CoronaryMotionProposal,
  type TreeBranch,
} from "./coronaryMotion";
import type { RecordingSidecar } from "./recordingSidecar";

export const HEART_REPLAY = {
  /** Least distance between kept tree points, frame pixels. */
  spacing_px: 6,
  /** A gap this long between axis points in order starts a new branch. */
  break_px: 24,
  /** Least points a branch keeps; shorter runs are left out. */
  min_branch: 3,
  /** Frames are averaged down to at most this many pixels a side before
   * the tree is followed, as in the cine evaluation: the tracker's patch
   * and search are set at this scale, and it bounds what the read holds
   * (at most max_frames such frames). */
  max_side_px: 512,
} as const;

/** Whole-pixel factor the frames are averaged down by. */
export function reductionOf(width: number, height: number): number {
  return Math.max(
    1,
    Math.ceil(Math.max(width, height) / HEART_REPLAY.max_side_px),
  );
}

/** Gray levels averaged over `by` by `by` blocks; a part block at the right
 * or bottom edge is left out. */
export function reduceGray(
  gray: Uint8Array,
  width: number,
  height: number,
  by: number,
): { pixels: Uint8Array; width: number; height: number } {
  if (by === 1) return { pixels: gray, width, height };
  const w = Math.floor(width / by),
    h = Math.floor(height / by),
    out = new Uint8Array(w * h),
    area = by * by;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < by; dy++)
        for (let dx = 0; dx < by; dx++)
          sum += gray[(y * by + dy) * width + x * by + dx];
      out[y * w + x] = Math.round(sum / area);
    }
  return { pixels: out, width: w, height: h };
}

/** A point of the full frame on the reduced frame, and back: a reduced
 * pixel's centre is its block's centre. */
export const toReduced = (v: number, by: number) => (v - (by - 1) / 2) / by,
  fromReduced = (v: number, by: number) => v * by + (by - 1) / 2;

/** The tree in reduced-frame pixels. */
export function reduceTree(tree: TreeBranch[], by: number): TreeBranch[] {
  if (by === 1) return tree;
  return tree.map((b) => ({
    ...b,
    points: b.points.map(([x, y]) => [toReduced(x, by), toReduced(y, by)]),
  }));
}

/** The proposal's followed trees back in full-frame pixels. */
export function enlargeProposal(
  proposal: CoronaryMotionProposal,
  by: number,
): CoronaryMotionProposal {
  if (by === 1) return proposal;
  return {
    ...proposal,
    frames: proposal.frames.map((f) =>
      f.status === "refused"
        ? f
        : {
            ...f,
            moved_px: f.moved_px * by,
            branches: f.branches.map((b) => ({
              ...b,
              points: b.points.map(([x, y]) => [
                fromReduced(x, by),
                fromReduced(y, by),
              ]),
            })),
          },
    ),
  };
}

/** The stretch of frames around the saved one where the table gives the
 * same angles and the same kind of frame, at most the tracker's limit:
 * frames lo to hi, both included. */
export function sameViewRun(
  sidecar: RecordingSidecar,
  saved: number,
  limit: number = CORONARY_MOTION.max_frames,
): { lo: number; hi: number } {
  const same = (k: number) =>
    sidecar.kind[k] === sidecar.kind[saved] &&
    Object.is(sidecar.primary_deg[k], sidecar.primary_deg[saved]) &&
    Object.is(sidecar.secondary_deg[k], sidecar.secondary_deg[saved]);
  let lo = saved,
    hi = saved;
  while (hi - lo + 1 < limit) {
    const down = lo > 0 && same(lo - 1),
      up = hi + 1 < sidecar.frames && same(hi + 1);
    if (!down && !up) break;
    // Alternately each way, so the saved frame stays near the middle.
    if (up && (!down || hi - saved <= saved - lo)) hi++;
    else lo--;
  }
  return { lo, hi };
}

/** The axis as it falls on the frame, as branches of points at least
 * `spacing_px` apart; points off the frame or not projected are left out
 * and break the branch. */
export function treeFromPixels(
  pixels: Float32Array,
  size: { width: number; height: number },
  limit: number = CORONARY_MOTION.max_points,
): TreeBranch[] {
  const runs: number[][][] = [];
  let run: number[][] = [];
  const end = () => {
    if (run.length >= HEART_REPLAY.min_branch) runs.push(run);
    run = [];
  };
  for (let i = 0; i + 1 < pixels.length; i += 2) {
    const x = pixels[i],
      y = pixels[i + 1];
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > size.width - 1 ||
      y > size.height - 1
    ) {
      end();
      continue;
    }
    const last = run[run.length - 1];
    if (last) {
      const d = Math.hypot(x - last[0], y - last[1]);
      if (d > HEART_REPLAY.break_px) end();
      else if (d < HEART_REPLAY.spacing_px) continue;
    }
    run.push([x, y]);
  }
  end();
  // Over the limit, every second point of every branch, until within it.
  let total = runs.reduce((s, r) => s + r.length, 0);
  let kept = runs;
  while (total > limit) {
    kept = kept
      .map((r) => r.filter((_, k) => k % 2 === 0 || k === r.length - 1))
      .filter((r) => r.length >= HEART_REPLAY.min_branch);
    total = kept.reduce((s, r) => s + r.length, 0);
  }
  return kept.map((points, k) => ({ id: `axis-${k}`, points }));
}

/** Gray levels of an RGBA picture. */
export function grayOf(data: Uint8ClampedArray, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++)
    out[i] = Math.round(
      0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2],
    );
  return out;
}
