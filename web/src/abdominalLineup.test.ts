import { describe, expect, it } from "vitest";
import {
  ABDOMINAL_LINEUP_METHOD,
  createAbdominalLineupJob,
  fromFrontDeg,
  loneFrameHolds,
  projectBranches,
  proposeAbdominalLineup,
} from "./abdominalLineup";
import {
  BONE_LINEUP_BIPLANE_METHOD,
  BONE_LINEUP_METHOD,
  boneSamples,
  proposeBoneLineup,
} from "./boneLineup";
import { camera } from "./carmGeometry";
import {
  apart,
  IDENTITY,
  phantom,
  render,
  rigid,
  TRUE,
  view,
} from "./__fixtures__/bonePhantom";

// Each case runs the bone line-up engine a bounded number of times; the cost
// is set by its evaluation limits, not by the clock.
const SLOW = 180_000;

describe("abdominal line-up, guarded", () => {
  const volume = phantom(),
    samples = boneSamples(volume),
    front = render(volume, TRUE, view(0)),
    side = render(volume, TRUE, view(90)),
    beam = camera(view(0), [0, 0, 0]).d;

  it(
    "with one frame, places the bone across the beam and leaves depth open",
    () => {
      const found = proposeAbdominalLineup({
        samples,
        frames: [front],
        start: IDENTITY,
      });
      expect(found.method).toBe(ABDOMINAL_LINEUP_METHOD);
      expect(found.engine_method).toBe(BONE_LINEUP_METHOD);
      expect(found.depth).toBe("not_determined_single_view");
      expect(found.second_view).toEqual({ status: "not_given" });
      expect(found.used).toEqual([0]);
      expect(apart(found.matrix, TRUE, beam)).toBeLessThan(1.5);
    },
    SLOW,
  );

  it(
    "with a front and a side frame, places the bone in 3D",
    () => {
      // The side frame comes first; the front one is still searched first.
      const found = proposeAbdominalLineup({
        samples,
        frames: [side, front],
        start: IDENTITY,
      });
      expect(found.engine_method).toBe(BONE_LINEUP_BIPLANE_METHOD);
      expect(found.depth).toBe("two_views");
      expect(found.used).toEqual([0, 1]);
      expect(apart(found.matrix, TRUE)).toBeLessThan(1.5);
      expect(Math.min(...found.frame_scores)).toBeGreaterThan(0.1);
    },
    SLOW,
  );

  it(
    "sets aside a second frame that shows no bone and keeps the first answer",
    () => {
      const blank = { ...side, pixels: new Uint16Array(side.pixels.length) };
      blank.pixels.fill(30_000);
      // Soft tissue and noise, no bone: a frame taken off the bone.
      const soft = { ...side, pixels: new Uint16Array(side.pixels.length) };
      let state = 7;
      for (let i = 0; i < soft.pixels.length; i++) {
        state = (state * 1103515245 + 12345) >>> 0;
        const x = i % side.width,
          y = Math.floor(i / side.width);
        soft.pixels[i] =
          30_000 + 4000 * Math.sin(x / 40) * Math.cos(y / 55) + (state % 600);
      }
      const shown = proposeAbdominalLineup({
        samples,
        frames: [front, blank],
        start: IDENTITY,
      });
      expect(shown.second_view).toEqual({
        status: "set_aside",
        frame: 1,
        reason: "bone_not_held",
      });
      expect(shown.both).toBeNull();
      const found = proposeAbdominalLineup({
        samples,
        frames: [front, soft],
        start: IDENTITY,
      });
      const alone = proposeBoneLineup({
        samples,
        frames: [front],
        start: IDENTITY,
      });
      expect(found.second_view).toEqual({
        status: "set_aside",
        frame: 1,
        reason: "bone_not_held",
      });
      expect(found.engine_method).toBe(BONE_LINEUP_METHOD);
      expect(found.depth).toBe("not_determined_single_view");
      expect(found.matrix).toEqual(alone.matrix);
      expect(found.both).not.toBeNull();
      expect(apart(found.matrix, TRUE, beam)).toBeLessThan(1.5);
    },
    SLOW,
  );

  it(
    "sets aside a second frame of another patient position",
    () => {
      // The side frame shows the bone 40 mm higher and turned: the patient
      // moved between the frames. A pose that fits it pulls the front frame
      // off its bone.
      const moved = render(volume, rigid(14, -9, [10, 6, 40]), view(90));
      const found = proposeAbdominalLineup({
        samples,
        frames: [front, moved],
        start: IDENTITY,
      });
      if (found.second_view.status === "not_given") {
        // Kept only if the front frame still holds its bone at the answer.
        expect(found.frame_scores[0]).toBeGreaterThan(0.8 * found.single.score);
      } else {
        expect(found.matrix).toEqual(found.single.matrix);
        expect(apart(found.matrix, TRUE, beam)).toBeLessThan(1.5);
      }
    },
    SLOW,
  );

  it(
    "sets aside a second frame too close to the first",
    () => {
      const near = render(volume, TRUE, view(12));
      const found = proposeAbdominalLineup({
        samples,
        frames: [front, near],
        start: IDENTITY,
      });
      expect(found.second_view).toEqual({
        status: "set_aside",
        frame: 1,
        reason: "too_close",
      });
      expect(found.both).toBeNull();
    },
    SLOW,
  );

  it(
    "refuses a lone side frame and runs in slices",
    () => {
      expect(() =>
        createAbdominalLineupJob({ samples, frames: [side], start: IDENTITY }),
      ).toThrow("No frame is within 60 degrees of the front");
      const job = createAbdominalLineupJob({
        samples,
        frames: [front],
        start: IDENTITY,
      });
      let calls = 0;
      while (!job.advance(() => ++calls % 3 === 0));
      expect(calls).toBeGreaterThan(3);
      expect(job.result().method).toBe(ABDOMINAL_LINEUP_METHOD);
    },
    SLOW,
  );
});

describe("a lone frame at the pose found", () => {
  it("holds within 60 degrees of the front, and not once the pose turns it past", () => {
    const frame = {
      view: view(55),
      isocenter: [0, 0, 0] as [number, number, number],
    };
    expect(fromFrontDeg(frame, IDENTITY)).toBeCloseTo(55, 6);
    expect(loneFrameHolds(frame, IDENTITY)).toBe(true);
    // The search may turn the scan about its long axis by up to 20 degrees.
    const turned = [rigid(10, 0, [0, 0, 0]), rigid(-10, 0, [0, 0, 0])].map(
      (m) => fromFrontDeg(frame, m),
    );
    expect(Math.max(...turned)).toBeGreaterThan(60);
    expect(
      [rigid(10, 0, [0, 0, 0]), rigid(-10, 0, [0, 0, 0])].some(
        (m) => !loneFrameHolds(frame, m),
      ),
    ).toBe(true);
  });
});

describe("projectBranches", () => {
  const v = view(0);
  it("draws a centerline through the pose, with its radius in pixels", () => {
    const [aorta] = projectBranches(
      [
        {
          name: "aorta",
          path_ras: [
            [0, 0, 0],
            [0, 0, 50],
          ],
          radius_mm: [10, 10],
        },
      ],
      IDENTITY,
      v,
      [0, 0, 0],
      { width: 306, height: 306 },
    );
    expect(aorta.name).toBe("aorta");
    // The isocenter lies on the central ray, at the middle of the frame.
    expect(aorta.points[0][0]).toBeCloseTo(153, 6);
    expect(aorta.points[0][1]).toBeCloseTo(153, 6);
    // 1 mm pixels, magnified by 1140 / 745 at the isocenter.
    expect(aorta.points[0][2]).toBeCloseTo((10 * 1140) / 745, 6);
    // Head up: a point above the isocenter is higher in the frame.
    expect(aorta.points[1][1]).toBeLessThan(153);
    // A shifted pose moves the line with it.
    const [moved] = projectBranches(
      [{ name: "aorta", path_ras: [[0, 0, 0]], radius_mm: [10] }],
      rigid(0, 0, [0, 0, 10]),
      v,
      [0, 0, 0],
      { width: 306, height: 306 },
    );
    expect(moved.points[0][1]).toBeCloseTo(153 - (10 * 1140) / 745, 6);
  });
});
