import { describe, expect, it } from "vitest";
import type { CoronaryMotionProposal } from "./coronaryMotion";
import {
  enlargeProposal,
  fromReduced,
  HEART_REPLAY,
  reduceGray,
  reduceTree,
  reductionOf,
  sameViewRun,
  toReduced,
} from "./heartReplay";
import type { RecordingSidecar } from "./recordingSidecar";

const table = (primary: number[], secondary: number[]): RecordingSidecar =>
  ({
    frames: primary.length,
    kinds: ["Cine"],
    kind: new Uint8Array(primary.length),
    primary_deg: Float32Array.from(primary),
    secondary_deg: Float32Array.from(secondary),
    field_cm: new Float32Array(primary.length).fill(NaN),
    read: { angles: primary.length, field: 0 },
  }) as RecordingSidecar;

describe("the same-view stretch", () => {
  it("runs while the angles stay as at the saved frame", () => {
    const sidecar = table([10, 30, 30, 30, 30, 50], [0, 20, 20, 20, 20, 0]);
    expect(sameViewRun(sidecar, 2)).toEqual({ lo: 1, hi: 4 });
  });

  it("does not count frames of unread angles as one view", () => {
    const sidecar = table(
      [NaN, NaN, NaN, NaN, 30, 30],
      [NaN, NaN, NaN, NaN, 20, 20],
    );
    expect(sameViewRun(sidecar, 1)).toEqual({ lo: 1, hi: 1 });
    expect(sameViewRun(sidecar, 4)).toEqual({ lo: 4, hi: 5 });
  });
});

describe("frames at the tracker's scale", () => {
  it("averages frames above the side limit by a whole factor", () => {
    expect(HEART_REPLAY.max_side_px).toBe(512);
    expect(reductionOf(256, 256)).toBe(1);
    expect(reductionOf(512, 512)).toBe(1);
    expect(reductionOf(1024, 1024)).toBe(2);
    expect(reductionOf(1024, 600)).toBe(2);
    expect(reductionOf(1536, 1536)).toBe(3);
  });

  it("averages each block, leaving out a part block at the edge", () => {
    // 5 by 4, reduced by 2: 2 by 2 blocks, the fifth column left out.
    const gray = Uint8Array.from([
      0, 2, 10, 10, 99, 4, 6, 10, 10, 99, 1, 1, 50, 52, 99, 1, 1, 54, 56, 99,
    ]);
    const out = reduceGray(gray, 5, 4, 2);
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(Array.from(out.pixels)).toEqual([3, 10, 1, 53]);
    expect(reduceGray(gray, 5, 4, 1).pixels).toBe(gray);
  });

  it("maps a point to the reduced frame and back unchanged", () => {
    for (const by of [1, 2, 3])
      for (const v of [0, 7.25, 511, 1023])
        expect(fromReduced(toReduced(v, by), by)).toBeCloseTo(v, 9);
    // A block's centre is the reduced pixel's centre.
    expect(toReduced(0.5, 2)).toBe(0);
    expect(toReduced(2.5, 2)).toBe(1);
  });

  it("draws the followed tree back in full-frame pixels; a refused frame stays bare", () => {
    const tree = [
      {
        id: "axis-0",
        points: [
          [100.5, 40.5],
          [110.5, 60.5],
        ],
      },
    ];
    const reduced = reduceTree(tree, 2);
    expect(reduced[0].points).toEqual([
      [50, 20],
      [55, 30],
    ]);
    const proposal: CoronaryMotionProposal = {
      method: "coronary_tree_tracking_v1",
      reference: 0,
      frames: [
        {
          status: "reference",
          match: 1,
          outliers: 0,
          moved_px: 0,
          branches: reduced,
        },
        {
          status: "tracked",
          match: 0.9,
          outliers: 0,
          moved_px: 1.5,
          branches: reduced,
        },
        { status: "refused", reason: "low_match", match: 0.1, outliers: 3 },
      ],
      period_ms: 800,
      phase_matched: [1],
    };
    const full = enlargeProposal(proposal, 2);
    expect(full.frames[0]).toMatchObject({ branches: tree });
    expect(full.frames[1]).toMatchObject({ moved_px: 3, branches: tree });
    expect(full.frames[2]).toEqual(proposal.frames[2]);
    expect(full.period_ms).toBe(800);
    expect(enlargeProposal(proposal, 1)).toBe(proposal);
  });
});
