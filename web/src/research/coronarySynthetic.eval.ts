// @vitest-environment node
/** The coronary tree over the synthetic cine with a known answer
 * (../__fixtures__/coronaryCine.ts: 48 frames at 15 a second, a beat of
 * 800 ms that squeezes and turns the tree, slow breathing drift, contrast
 * leaving in the last six frames). Prints the figures the unit tests only
 * bound. Not part of the test suite:
 *   npx vitest run --config vitest.research.config.ts \
 *     src/research/coronarySynthetic.eval.ts */
import { it } from "vitest";
import { CINE, DRAWN, renderCine } from "../__fixtures__/coronaryCine";
import {
  proposeCoronaryMotion,
  vesselEvidence,
  type TreeBranch,
} from "../coronaryMotion";

const meanOff = (a: TreeBranch[], b: TreeBranch[]) => {
  let total = 0,
    n = 0;
  a.forEach((branch, k) =>
    branch.points.forEach((p, i) => {
      total += Math.hypot(p[0] - b[k].points[i][0], p[1] - b[k].points[i][1]);
      n++;
    }),
  );
  return total / n;
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

it("measures the synthetic cine", () => {
  const washout = [42, 43, 44, 45, 46, 47];
  const { frames, truth } = renderCine({ washout });
  const began = performance.now();
  const found = proposeCoronaryMotion({
    frames,
    reference: 0,
    branches: DRAWN,
  });
  const ms = performance.now() - began;
  const still: number[] = [],
    moving: number[] = [],
    evidenceStill: number[] = [],
    evidenceMoving: number[] = [];
  found.frames.forEach((frame, k) => {
    if (frame.status !== "tracked" || k === 0) return;
    still.push(meanOff(DRAWN, truth[k]));
    moving.push(meanOff(frame.branches, truth[k]));
    evidenceStill.push(
      vesselEvidence(
        frames[k],
        DRAWN.flatMap((b) => b.points),
      ),
    );
    evidenceMoving.push(
      vesselEvidence(
        frames[k],
        frame.branches.flatMap((b) => b.points),
      ),
    );
  });
  const refused = found.frames
    .map((f, k) => (f.status === "refused" ? k : -1))
    .filter((k) => k >= 0);
  // Another recording's frame in the middle.
  const other = renderCine().frames[6].pixels.slice().reverse();
  const again = proposeCoronaryMotion({
    frames: frames.map((f, k) => (k === 20 ? { ...f, pixels: other } : f)),
    reference: 0,
    branches: DRAWN,
  });
  const summary = {
    frames: frames.length,
    tracked_after_reference: moving.length,
    refused,
    washout_frames: washout,
    still_tree_mean_px: +(
      still.reduce((a, b) => a + b, 0) / still.length
    ).toFixed(2),
    still_tree_max_px: +Math.max(...still).toFixed(2),
    moving_tree_mean_px: +(
      moving.reduce((a, b) => a + b, 0) / moving.length
    ).toFixed(2),
    moving_tree_max_px: +Math.max(...moving).toFixed(2),
    evidence_still_median: +median(evidenceStill).toFixed(3),
    evidence_moving_median: +median(evidenceMoving).toFixed(3),
    period_true_ms: CINE.period_ms,
    period_read_ms:
      found.period_ms === null ? null : +found.period_ms.toFixed(1),
    phase_matched: [...found.phase_matched].sort((a, b) => a - b),
    phase_true: [12, 24, 36],
    foreign_frame_refused: again.frames[20].status === "refused",
    ms: Math.round(ms),
  };
  console.log("SUMMARY " + JSON.stringify(summary));
});
