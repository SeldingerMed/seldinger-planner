import { describe, expect, it } from "vitest";
import { applyRigid } from "./__fixtures__/angioPhantom";
import {
  gray,
  medial,
  phantom,
  pivot,
  SIDE,
  truth,
  VIEW,
} from "./__fixtures__/overlayCase";
import { createOverlayJob, type OverlayJobInput } from "./projectionOverlayJob";
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
    expect(slices).toBeGreaterThan(5);
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
