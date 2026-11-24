/** The replay's heart motion: the parts of following the saved proposal's
 * vessel axis over a coronary cine that do not touch the page. The cine is
 * the stretch of the recording around the saved frame where the C-arm
 * stands as it did there; the tree is the axis as it falls on the saved
 * frame. The tracking itself is ./coronaryMotion.ts. */
import { CORONARY_MOTION, type TreeBranch } from "./coronaryMotion";
import type { RecordingSidecar } from "./recordingSidecar";

export const HEART_REPLAY = {
  /** Least distance between kept tree points, frame pixels. */
  spacing_px: 6,
  /** A gap this long between axis points in order starts a new branch. */
  break_px: 24,
  /** Least points a branch keeps; shorter runs are left out. */
  min_branch: 3,
} as const;

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
