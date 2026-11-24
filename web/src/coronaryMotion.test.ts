import { describe, expect, it } from "vitest";
import { CINE, DRAWN, renderCine } from "./__fixtures__/coronaryCine";
import {
  CORONARY_MOTION_METHOD,
  createCoronaryMotionJob,
  periodFromTrees,
  proposeCoronaryMotion,
  vesselEvidence,
  type TreeBranch,
} from "./coronaryMotion";

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

describe("coronary tree over a cine", () => {
  const washout = [42, 43, 44, 45, 46, 47];
  const { frames, truth } = renderCine({ washout });
  const found = proposeCoronaryMotion({
    frames,
    reference: 0,
    branches: DRAWN,
  });

  it("follows the tree where a still tree is off, keeping each point's branch", () => {
    expect(found.method).toBe(CORONARY_MOTION_METHOD);
    let still = 0,
      moving = 0,
      count = 0,
      worst = 0;
    found.frames.forEach((frame, k) => {
      if (frame.status !== "tracked") return;
      expect(frame.branches.map((b) => b.id)).toEqual([
        "lad",
        "lcx",
        "diagonal",
      ]);
      frame.branches.forEach((b, j) =>
        expect(b.points).toHaveLength(DRAWN[j].points.length),
      );
      const off = meanOff(frame.branches, truth[k]);
      still += meanOff(DRAWN, truth[k]);
      moving += off;
      worst = Math.max(worst, off);
      count++;
    });
    expect(count).toBeGreaterThan(35);
    expect(still / count).toBeGreaterThan(4);
    expect(moving / count).toBeLessThan(1);
    expect(worst).toBeLessThan(2);
  });

  it("refuses the frames the contrast has left, and only those", () => {
    const refused = found.frames
      .map((f, k) => (f.status === "refused" ? k : -1))
      .filter((k) => k >= 0);
    expect(refused).toEqual(washout);
  });

  it("reads the heart's period from the frames' times and names the frames at the reference's phase", () => {
    expect(found.period_ms).not.toBeNull();
    expect(Math.abs((found.period_ms as number) - CINE.period_ms)).toBeLessThan(
      0.05 * CINE.period_ms,
    );
    // One frame a beat, within a frame of the beat: at 15 frames a second
    // a frame is 67 ms, and near the reference's phase the tree's shape
    // changes by less than the tracking's own error.
    const matched = [...found.phase_matched].sort((a, b) => a - b);
    expect(matched).toHaveLength(3);
    matched.forEach((k, n) =>
      expect(Math.abs(k - 12 * (n + 1))).toBeLessThanOrEqual(1),
    );
  });

  it("refuses a frame from another recording in the middle", () => {
    const other = renderCine().frames[6].pixels.slice().reverse();
    const swapped = frames.map((f, k) =>
      k === 20 ? { ...f, pixels: other } : f,
    );
    const again = proposeCoronaryMotion({
      frames: swapped,
      reference: 0,
      branches: DRAWN,
    });
    expect(again.frames[20].status).toBe("refused");
    // The frames after it are still found, from the last frame kept.
    for (const k of [21, 22, 23]) {
      const f = again.frames[k];
      expect(f.status).toBe("tracked");
      if (f.status === "tracked")
        expect(meanOff(f.branches, truth[k])).toBeLessThan(1.5);
    }
  });

  it("shows more vessel under the moving tree than under the still one", () => {
    let still = 0,
      moving = 0;
    for (const k of [3, 6, 9, 15, 18]) {
      const f = found.frames[k];
      if (f.status !== "tracked") throw new Error("expected tracked");
      still += vesselEvidence(
        frames[k],
        DRAWN.flatMap((b) => b.points),
      );
      moving += vesselEvidence(
        frames[k],
        f.branches.flatMap((b) => b.points),
      );
    }
    expect(moving).toBeGreaterThan(2 * still);
  });

  it("runs in slices and checks its input", () => {
    const job = createCoronaryMotionJob({
      frames,
      reference: 0,
      branches: DRAWN,
    });
    let calls = 0;
    while (!job.advance(() => ++calls % 4 === 0));
    expect(job.result().frames).toHaveLength(frames.length);
    expect(() =>
      createCoronaryMotionJob({
        frames: frames.map((f, k) => ({
          ...f,
          time_ms: k === 3 ? 0 : f.time_ms,
        })),
        reference: 0,
        branches: DRAWN,
      }),
    ).toThrow("Cine frame times must rise");
    expect(() =>
      createCoronaryMotionJob({
        frames,
        reference: 0,
        branches: [{ id: "x", points: [[-1, 4]] }],
      }),
    ).toThrow("Tree point outside the frame");
  });

  it("finds no period in a tree that does not come back", () => {
    const times = Array.from({ length: 30 }, (_, k) => k * 66.7);
    // A tree that keeps stretching.
    const stretch = times.map((t) => [
      [0, 0],
      [10 + t / 20, 5],
      [20, 10 + t / 30],
    ]);
    expect(periodFromTrees(times, stretch)).toBeNull();
    expect(periodFromTrees(times.slice(0, 4), stretch.slice(0, 4))).toBeNull();
  });
});
