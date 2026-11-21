import { describe, expect, it } from "vitest";
import { applyRigid } from "./__fixtures__/angioPhantom";
import {
  gray,
  medial,
  pairGray,
  pairTruth,
  phantom,
  pivot,
  SIDE,
  truth,
  VIEW,
  VIEW_B,
} from "./__fixtures__/overlayCase";
import {
  createBiplaneOverlayJob,
  createOverlayJob,
  type BiplaneOverlayJobInput,
  type OverlayJobInput,
} from "./projectionOverlayJob";
import { centroid } from "./maskPoints";
import { startFromProposedView } from "./poseInitializer";
import { projectRegistered } from "./projectionRegistration";

const input: OverlayJobInput = {
  mask: phantom.mask,
  shape: phantom.shape,
  affine: phantom.affine,
  frame: { gray, width: SIDE, height: SIDE },
  view: VIEW,
  isocenter: null,
  search: { polarity: "dark", sensitivity: 0.5, fit_detector_scale: false },
};
const size = { width: SIDE, height: SIDE };

describe("overlay job", () => {
  it("proposes a pose that lays the mask on the frame it was rendered from", () => {
    const job = createOverlayJob(input);
    expect(() => job.result()).toThrow("not complete");
    // Driven in single steps, as a busy browser tab would.
    let slices = 0;
    while (!job.advance(() => true)) slices++;
    // The search itself gives way at every slice boundary, not only the
    // stages around it.
    expect(slices).toBeGreaterThan(1000);
    const result = job.result();
    expect(result.points).toEqual(medial.points);
    expect(result.pooling).toBe(1);
    result.isocenter.forEach((x, i) => expect(x).toBeCloseTo(pivot[i], 6));
    const proposal = result.proposal!;
    const got = projectRegistered(
        proposal.view,
        result.isocenter,
        proposal.matrix,
        result.points,
        size,
      ),
      want = projectRegistered(VIEW, pivot, truth, medial.points, size);
    let sum = 0;
    for (let k = 0; k < got.length; k += 2)
      sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
    const pitch_mm = ((180 / SIDE) * 800) / 1200;
    // Mean projected distance to the true pose, at the isocenter plane.
    expect((sum / (got.length / 2)) * pitch_mm).toBeLessThan(1);
    expect(proposal.score.mean_distance_mm).toBeLessThan(
      proposal.start_score.mean_distance_mm,
    );
    expect(result.target!.centerline.length).toBeGreaterThan(40);
    // The same answer whatever the slicing.
    const whole = createOverlayJob(input);
    expect(whole.advance(() => false)).toBe(true);
    expect(whole.result().proposal!.matrix).toEqual(proposal.matrix);
  });

  it("uses an entered isocenter and only extracts points for a redraw", () => {
    const entered = applyRigid(truth, pivot);
    const job = createOverlayJob({
      ...input,
      isocenter: entered,
      search: null,
    });
    expect(job.advance(() => false)).toBe(true);
    expect(job.result()).toMatchObject({
      isocenter: entered,
      target: null,
      proposal: null,
    });
    expect(job.result().points).toEqual(medial.points);
  });

  it("keeps failing once it has failed", () => {
    const empty = createOverlayJob({
      ...input,
      mask: new Uint8Array(phantom.mask.length),
    });
    expect(() => empty.advance(() => false)).toThrow();
    expect(() => empty.advance(() => false)).toThrow();
    expect(() => empty.result()).toThrow("not complete");
    // A frame with no lines to match is a failure, not an identity proposal.
    const blank = createOverlayJob({
      ...input,
      frame: {
        gray: new Uint8Array(SIDE * SIDE).fill(128),
        width: SIDE,
        height: SIDE,
      },
    });
    expect(() => blank.advance(() => false)).toThrow();
  });
});

const plane = (k: number) => ({
  frame: { gray: pairGray[k], width: SIDE, height: SIDE },
  view: k ? VIEW_B : VIEW,
  polarity: "dark" as const,
  sensitivity: 0.5,
  fit_detector_scale: false,
});
const pair: BiplaneOverlayJobInput = {
  mask: phantom.mask,
  shape: phantom.shape,
  affine: phantom.affine,
  planes: [plane(0), plane(1)],
  isocenter: null,
  search: true,
};
/** Mean 3D distance between where two poses put the vessel points. */
function pointError(found: number[][], want: number[][]) {
  const points = medial.points;
  let sum = 0;
  for (let k = 0; k < points.length; k += 3) {
    const x: [number, number, number] = [
        points[k],
        points[k + 1],
        points[k + 2],
      ],
      a = applyRigid(found, x),
      b = applyRigid(want, x);
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return sum / (points.length / 3);
}

describe("two-plane overlay job", () => {
  it("proposes one pose that is right in three dimensions", () => {
    const job = createBiplaneOverlayJob(pair);
    expect(() => job.result()).toThrow("not complete");
    let slices = 0;
    while (!job.advance(() => true)) slices++;
    expect(slices).toBeGreaterThan(1000);
    const result = job.result(),
      proposal = result.proposal!;
    expect(result.points).toEqual(medial.points);
    result.isocenter.forEach((x, i) => expect(x).toBeCloseTo(pivot[i], 6));
    expect(result.targets).toHaveLength(2);
    expect(proposal.method).toBe("centerline_distance_compass_biplane_v1");
    expect(proposal.plane_angle_deg).toBeCloseTo(90);
    // The start, the volume's own position, is several millimeters off.
    const identity = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    expect(pointError(identity, pairTruth)).toBeGreaterThan(5);
    expect(pointError(proposal.matrix, pairTruth)).toBeLessThan(1);
    proposal.planes.forEach((found, k) => {
      expect(found.view).toEqual(k ? VIEW_B : VIEW);
      expect(found.detector_scale).toBe(1);
      expect(found.score.mean_distance_mm).toBeLessThan(
        found.start_score.mean_distance_mm,
      );
    });
    // The same answer whatever the slicing.
    const whole = createBiplaneOverlayJob(pair);
    expect(whole.advance(() => false)).toBe(true);
    expect(whole.result().proposal!.matrix).toEqual(proposal.matrix);
  }, 60000);

  it("only extracts points for a redraw, at an entered isocenter", () => {
    const job = createBiplaneOverlayJob({
      ...pair,
      isocenter: [1, 2, 3],
      search: false,
    });
    expect(job.advance(() => false)).toBe(true);
    expect(job.result()).toMatchObject({
      isocenter: [1, 2, 3],
      targets: null,
      proposal: null,
    });
    expect(job.result().points).toEqual(medial.points);
  });

  it("keeps failing once it has failed", () => {
    // Two planes at one angle cannot be fitted together.
    const job = createBiplaneOverlayJob({
      ...pair,
      planes: [plane(0), { ...plane(1), view: VIEW }],
    });
    expect(() => job.advance(() => false)).toThrow("too close to parallel");
    expect(() => job.advance(() => false)).toThrow("too close to parallel");
    expect(() => job.result()).toThrow("not complete");
  });
});

describe("overlay jobs by vessel evidence", () => {
  const evidence = {
    ...input,
    search: { ...input.search!, method: "vessel_evidence" as const },
  };

  it("proposes one plane's pose with no line set and no sensitivity", () => {
    const job = createOverlayJob(evidence);
    let slices = 0;
    while (!job.advance(() => true)) slices++;
    expect(slices).toBeGreaterThan(100);
    const result = job.result(),
      found = result.evidence!;
    // One kind of proposal, never both, and no extracted lines.
    expect(result.proposal).toBeNull();
    expect(result.target).toBeNull();
    expect(found.method).toBe("vessel_evidence_compass_v1");
    expect(found.detector_fit).toBe("not_requested");
    expect(found.planes).toHaveLength(1);
    expect(found.planes[0].view).toEqual(VIEW);
    expect(found.planes[0].score.mean_evidence).toBeGreaterThan(
      found.planes[0].start_score.mean_evidence,
    );
    const got = projectRegistered(
        found.planes[0].view,
        result.isocenter,
        found.matrix,
        result.points,
        size,
      ),
      want = projectRegistered(VIEW, pivot, truth, medial.points, size);
    let sum = 0;
    for (let k = 0; k < got.length; k += 2)
      sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
    expect(
      (sum / (got.length / 2)) * (((180 / SIDE) * 800) / 1200),
    ).toBeLessThan(1);
    // The sensitivity is not read: another value gives the same pose.
    const other = createOverlayJob({
      ...evidence,
      search: { ...evidence.search, sensitivity: 0.05 },
    });
    expect(other.advance(() => false)).toBe(true);
    expect(other.result().evidence!.matrix).toEqual(found.matrix);
  }, 60000);

  it("proposes one pose for two planes that is right in three dimensions", () => {
    const job = createBiplaneOverlayJob({ ...pair, method: "vessel_evidence" });
    expect(job.advance(() => false)).toBe(true);
    const result = job.result(),
      found = result.evidence!;
    expect(result.proposal).toBeNull();
    expect(result.targets).toBeNull();
    expect(found.method).toBe("vessel_evidence_compass_biplane_v1");
    expect(found.plane_angle_deg).toBeCloseTo(90);
    expect(found.planes.map((one) => one.view)).toEqual([VIEW, VIEW_B]);
    expect(pointError(found.matrix, pairTruth)).toBeLessThan(1);
  }, 60000);

  it("reports the outcome of a requested fit of the field size", () => {
    const job = createOverlayJob({
      ...evidence,
      search: { ...evidence.search, fit_detector_scale: true },
    });
    expect(job.advance(() => false)).toBe(true);
    const found = job.result().evidence!;
    expect(["kept", "dropped"]).toContain(found.detector_fit);
    // A fit that was not kept leaves the entered size.
    if (found.detector_fit === "dropped")
      expect(found.planes[0].detector_scale).toBe(1);
  }, 60000);

  it("reads bright vessels when the frame is declared bright", () => {
    // The same frames with the gray scale reversed.
    const reversed = (frame: Uint8Array) => frame.map((value) => 255 - value);
    const one = createOverlayJob({
      ...evidence,
      frame: { ...evidence.frame, gray: reversed(gray) },
      search: { ...evidence.search, polarity: "bright" },
    });
    expect(one.advance(() => false)).toBe(true);
    const found = one.result().evidence!,
      got = projectRegistered(
        found.planes[0].view,
        one.result().isocenter,
        found.matrix,
        medial.points,
        size,
      ),
      want = projectRegistered(VIEW, pivot, truth, medial.points, size);
    let sum = 0;
    for (let k = 0; k < got.length; k += 2)
      sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
    expect(
      (sum / (got.length / 2)) * (((180 / SIDE) * 800) / 1200),
    ).toBeLessThan(1);
    expect(found.planes[0].score.mean_evidence).toBeGreaterThan(0.4);
    const two = createBiplaneOverlayJob({
      ...pair,
      method: "vessel_evidence",
      planes: [
        {
          ...pair.planes[0],
          polarity: "bright",
          frame: { ...pair.planes[0].frame, gray: reversed(pairGray[0]) },
        },
        {
          ...pair.planes[1],
          polarity: "bright",
          frame: { ...pair.planes[1].frame, gray: reversed(pairGray[1]) },
        },
      ],
    });
    expect(two.advance(() => false)).toBe(true);
    const both = two.result().evidence!;
    expect(pointError(both.matrix, pairTruth)).toBeLessThan(1);
    both.planes.forEach((plane) =>
      expect(plane.score.mean_evidence).toBeGreaterThan(0.4),
    );
  }, 60000);

  it("only redraws when no search is asked for, whatever the method", () => {
    const job = createBiplaneOverlayJob({
      ...pair,
      search: false,
      method: "vessel_evidence",
    });
    expect(job.advance(() => false)).toBe(true);
    expect(job.result()).toMatchObject({
      targets: null,
      proposal: null,
      evidence: null,
    });
  });

  it("fails on a frame with nothing line-like, as the other method does", () => {
    const blank = createOverlayJob({
      ...evidence,
      frame: {
        gray: new Uint8Array(SIDE * SIDE).fill(128),
        width: SIDE,
        height: SIDE,
      },
    });
    expect(() => blank.advance(() => false)).toThrow();
    expect(() => blank.result()).toThrow("not complete");
  });
});

describe("overlay jobs started from a proposed view", () => {
  const OFF = 40,
    identity = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    // The operator's angles are 40 degrees off. The frame was taken at VIEW.
    entered = { ...VIEW, primary_deg: VIEW.primary_deg + OFF },
    seen = {
      primary_deg: VIEW.primary_deg,
      secondary_deg: VIEW.secondary_deg,
      turn_deg: 0,
    },
    evidence = {
      ...input,
      view: entered,
      search: { ...input.search!, method: "vessel_evidence" as const },
    };
  /** Mean distance, in pixels, between where a result puts the vessel
   * points and where the frame's true pose puts them. */
  const pixelsOff = (
    view: typeof VIEW,
    result: { isocenter: [number, number, number]; points: Float32Array },
    matrix: number[][],
    trueView = VIEW,
    truePose = truth,
  ) => {
    const got = projectRegistered(
        view,
        result.isocenter,
        matrix,
        result.points,
        size,
      ),
      want = projectRegistered(trueView, pivot, truePose, medial.points, size);
    let sum = 0;
    for (let k = 0; k < got.length; k += 2)
      sum += Math.hypot(got[k] - want[k], got[k + 1] - want[k + 1]);
    return sum / (got.length / 2);
  };

  it("starts at the volume's own position when no view is given", () => {
    const job = createOverlayJob({ ...input, search: null });
    expect(job.advance(() => false)).toBe(true);
    expect(job.result().start).toEqual(identity);
    const pairJob = createBiplaneOverlayJob({ ...pair, search: false });
    expect(pairJob.advance(() => false)).toBe(true);
    expect(pairJob.result().start).toEqual(identity);
  });

  it("finds the pose from a proposed view that the entered angles miss", () => {
    const from = createOverlayJob({ ...evidence, start_view: seen });
    expect(from.advance(() => false)).toBe(true);
    const result = from.result(),
      found = result.evidence!;
    expect(result.start).toEqual(
      startFromProposedView(entered, seen, centroid(medial.points)),
    );
    // The entered angles are kept: the model was turned under them.
    expect(found.planes[0].view).toEqual(entered);
    expect(pixelsOff(entered, result, found.matrix)).toBeLessThan(1.5);
    // The same search from the volume's own position ends further off.
    const without = createOverlayJob(evidence);
    expect(without.advance(() => false)).toBe(true);
    const missed = without.result();
    expect(missed.start).toEqual(identity);
    expect(pixelsOff(entered, missed, missed.evidence!.matrix)).toBeGreaterThan(
      3,
    );
  }, 120000);

  it("starts the centerline distance search the same way", () => {
    const job = createOverlayJob({
      ...input,
      view: entered,
      start_view: seen,
    });
    expect(job.advance(() => false)).toBe(true);
    const result = job.result();
    expect(result.start).toEqual(
      startFromProposedView(entered, seen, centroid(medial.points)),
    );
    expect(pixelsOff(entered, result, result.proposal!.matrix)).toBeLessThan(
      1.5,
    );
  }, 120000);

  it("turns the model once for two planes, from either plane's view", () => {
    const planes = pair.planes.map((plane) => ({
        ...plane,
        view: { ...plane.view, primary_deg: plane.view.primary_deg + OFF },
      })) as BiplaneOverlayJobInput["planes"],
      off = { ...pair, planes, method: "vessel_evidence" as const };
    for (const k of [0, 1] as const) {
      const truly = [VIEW, VIEW_B][k],
        job = createBiplaneOverlayJob({
          ...off,
          start_view: {
            plane: k,
            view: {
              primary_deg: truly.primary_deg,
              secondary_deg: truly.secondary_deg,
              turn_deg: 0,
            },
          },
        });
      expect(job.advance(() => false)).toBe(true);
      const result = job.result(),
        found = result.evidence!;
      expect(result.start).toEqual(
        startFromProposedView(
          planes[k].view,
          { ...truly, turn_deg: 0 },
          centroid(medial.points),
        ),
      );
      expect(found.planes.map((one) => one.view)).toEqual([
        planes[0].view,
        planes[1].view,
      ]);
      // Right in both frames at once.
      expect(
        pixelsOff(planes[0].view, result, found.matrix, VIEW, pairTruth),
      ).toBeLessThan(1.5);
      expect(
        pixelsOff(planes[1].view, result, found.matrix, VIEW_B, pairTruth),
      ).toBeLessThan(1.5);
    }
  }, 240000);

  it("carries the start through a redraw", () => {
    const job = createOverlayJob({
      ...input,
      view: entered,
      search: null,
      start_view: seen,
    });
    expect(job.advance(() => false)).toBe(true);
    expect(job.result().start).toEqual(
      startFromProposedView(entered, seen, centroid(medial.points)),
    );
    expect(job.result().evidence).toBeNull();
  });
});
