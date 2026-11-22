import { describe, expect, it } from "vitest";
import { pivot, SIDE, truth, VIEW } from "./__fixtures__/overlayCase";
import { projectRegistered } from "./projectionRegistration";
import { parseSidecar } from "./recordingSidecar";
import {
  createReplayOverlay,
  frameAt,
  frameView,
  likeness,
  REPLAY_LIMITS,
  sourceRectangle,
  timeOf,
} from "./replayOverlay";

const size = { width: SIDE, height: SIDE },
  points = Float32Array.from([0, 0, 0, 12, -4, 9, -20, 6, 15, 5, 5, -18]),
  table = (rows: [string, string][]) =>
    parseSidecar(
      [
        "frame,frame_type,BottomLeft_1,BottomLeft_3",
        ...rows.map(([field, angles], k) => `${k},WC50,${field},"${angles}"`),
      ].join("\n"),
    ),
  // The saved frame is frame 2. The screen showed LAO 10 / CRAN 5 there.
  sidecar = table([
    ["cm32", "LAO 10°/CRAN 5°"],
    ["cm32", "LAO 10°/CRAN 5°"],
    ["cm32", "LAO 10°/CRAN 5°"],
    ["cm32", "LAO 22°/CRAN 5°"],
    ["cm32", "LAO 10°/CAUD 3°"],
    ["cm42", "LAO 10°/CRAN 5°"],
    ["cm32", "RAO 4°/CRAN 5°"],
    ["cm32", "unread"],
  ]),
  plane = {
    view: VIEW,
    isocenter: pivot,
    matrix: truth,
    points,
    size,
    frame_index: 2,
  },
  at = (view: typeof VIEW) =>
    projectRegistered(view, pivot, truth, points, size);

describe("the view a frame of a recording was taken in", () => {
  it("is the saved view at the saved frame and wherever the screen showed the same", () => {
    for (const frame of [0, 1, 2])
      expect(frameView(VIEW, sidecar, 2, frame)).toBe(VIEW);
  });

  it("is turned by what the angles on the screen changed since the saved frame", () => {
    expect(frameView(VIEW, sidecar, 2, 3)).toEqual({
      ...VIEW,
      primary_deg: VIEW.primary_deg + 12,
    });
    expect(frameView(VIEW, sidecar, 2, 4)).toEqual({
      ...VIEW,
      secondary_deg: VIEW.secondary_deg - 8,
    });
    expect(frameView(VIEW, sidecar, 2, 6)).toEqual({
      ...VIEW,
      primary_deg: VIEW.primary_deg - 14,
    });
    // A frame whose text was not read has the view of the frame before it.
    expect(frameView(VIEW, sidecar, 2, 7)).toEqual(
      frameView(VIEW, sidecar, 2, 6),
    );
  });

  it("has a field as much larger as the screen showed", () => {
    expect(frameView(VIEW, sidecar, 2, 5)).toEqual({
      ...VIEW,
      detector_width_mm: (VIEW.detector_width_mm * 42) / 32,
      detector_height_mm: (VIEW.detector_height_mm * 42) / 32,
    });
  });

  it("turns past the back of the patient onto the other side", () => {
    const turned = table([
      ["cm32", "LAO 170°/0°"],
      ["cm32", "RAO 170°/0°"],
    ]);
    expect(
      frameView({ ...VIEW, primary_deg: 175 }, turned, 0, 1)?.primary_deg,
    ).toBe(-165);
    expect(
      frameView({ ...VIEW, primary_deg: -175 }, turned, 1, 0)?.primary_deg,
    ).toBe(165);
    // A saved view near the back, turned on past it.
    const on = table([
      ["cm32", "LAO 10°/0°"],
      ["cm32", "LAO 30°/0°"],
    ]);
    expect(
      frameView({ ...VIEW, primary_deg: 175 }, on, 0, 1)?.primary_deg,
    ).toBe(-165);
    expect(
      frameView({ ...VIEW, primary_deg: -175 }, on, 1, 0)?.primary_deg,
    ).toBe(165);
  });

  it("follows the field of a recording whose angles were never read", () => {
    const fields = table([
      ["cm32", ""],
      ["cm42", ""],
    ]);
    expect(frameView(VIEW, fields, 0, 1)).toEqual({
      ...VIEW,
      detector_width_mm: (VIEW.detector_width_mm * 42) / 32,
      detector_height_mm: (VIEW.detector_height_mm * 42) / 32,
    });
  });

  it("is the saved view on every frame of a recording without readings", () => {
    const blank = table([
      ["", ""],
      ["", ""],
    ]);
    expect(frameView(VIEW, blank, 0, 1)).toBe(VIEW);
  });

  it("is none where the frame's angles or field are beyond what a view can have", () => {
    const far = table([
      ["cm32", "0°/CRAN 40°"],
      ["cm32", "0°/CAUD 40°"],
      ["cm99", "0°/CRAN 40°"],
      ["cm10", "0°/CRAN 40°"],
    ]);
    expect(frameView({ ...VIEW, secondary_deg: 60 }, far, 1, 0)).toBeNull();
    expect(frameView({ ...VIEW, secondary_deg: -60 }, far, 0, 1)).toBeNull();
    expect(frameView({ ...VIEW, secondary_deg: 10 }, far, 1, 0)).toEqual({
      ...VIEW,
      secondary_deg: 90,
    });
    expect(
      frameView({ ...VIEW, detector_width_mm: 300 }, far, 0, 2),
    ).toBeNull();
    expect(
      frameView({ ...VIEW, detector_height_mm: 100 }, far, 0, 3),
    ).toBeNull();
  });

  it("refuses a frame that is not in the recording", () => {
    for (const [confirmed, frame] of [
      [8, 0],
      [0, 8],
      [-1, 0],
      [0, 1.5],
    ])
      expect(() => frameView(VIEW, sidecar, confirmed, frame)).toThrow(
        "The frame is not in the recording",
      );
  });
});

describe("the vessel axis over a frame of a recording", () => {
  it("lies at the saved frame where the saved proposal has it", () => {
    const overlay = createReplayOverlay(plane, sidecar);
    for (const frame of [0, 1, 2])
      expect(overlay.pixels(frame)).toEqual(at(VIEW));
  });

  it("turns with the C-arm, and is drawn smaller in a larger field", () => {
    const overlay = createReplayOverlay(plane, sidecar);
    expect(overlay.pixels(3)).toEqual(
      at({ ...VIEW, primary_deg: VIEW.primary_deg + 12 }),
    );
    expect(overlay.pixels(3)).not.toEqual(at(VIEW));
    const wide = overlay.pixels(5)!,
      saved = at(VIEW);
    // About the frame's middle, by the ratio of the fields.
    for (let i = 0; i < wide.length; i++)
      expect(wide[i] - SIDE / 2).toBeCloseTo(
        ((saved[i] - SIDE / 2) * 32) / 42,
        3,
      );
  });

  it("gives the same pixels again for a view it has placed, and forgets the oldest", () => {
    const overlay = createReplayOverlay(plane, sidecar),
      first = overlay.pixels(3);
    expect(overlay.pixels(3)).toBe(first);
    // A sweep over more views than are kept.
    const sweep = table(
        Array.from(
          { length: REPLAY_LIMITS.kept_views + 2 },
          (_, k): [string, string] => ["cm32", `LAO ${k + 1}°/0°`],
        ),
      ),
      swept = createReplayOverlay({ ...plane, frame_index: 0 }, sweep),
      start = swept.pixels(1);
    expect(swept.pixels(1)).toBe(start);
    for (let k = 2; k < sweep.frames; k++) swept.pixels(k);
    expect(swept.pixels(1)).not.toBe(start);
    expect(swept.pixels(1)).toEqual(start);
  });

  it("places a larger field anew at the angles of a view it has placed", () => {
    const overlay = createReplayOverlay(plane, sidecar);
    overlay.pixels(2);
    expect(overlay.pixels(5)).toEqual(
      at({
        ...VIEW,
        detector_width_mm: (VIEW.detector_width_mm * 42) / 32,
        detector_height_mm: (VIEW.detector_height_mm * 42) / 32,
      }),
    );
  });

  it("has no pixels where the frame has no view", () => {
    const far = table([
      ["cm32", "0°/CRAN 40°"],
      ["cm32", "0°/CAUD 40°"],
    ]);
    expect(
      createReplayOverlay(
        { ...plane, view: { ...VIEW, secondary_deg: -60 }, frame_index: 0 },
        far,
      ).pixels(1),
    ).toBeNull();
  });

  it("refuses a saved frame that is not in the recording", () => {
    expect(() =>
      createReplayOverlay({ ...plane, frame_index: 8 }, sidecar),
    ).toThrow("The saved frame is not in the recording");
  });
});

describe("frames and times of a recording", () => {
  it("names the frame shown at a time, and the time at a frame's middle", () => {
    // 300 frames in 10 s.
    expect(frameAt(0, 10, 300)).toBe(0);
    expect(frameAt(1 / 30, 10, 300)).toBe(1);
    expect(frameAt(1 / 30 + 0.02, 10, 300)).toBe(1);
    expect(frameAt(4.0001, 10, 300)).toBe(120);
    expect(frameAt(3.9999, 10, 300)).toBe(120);
    expect(frameAt(10, 10, 300)).toBe(299);
    expect(frameAt(-0.01, 10, 300)).toBe(0);
    expect(timeOf(120, 10, 300)).toBeCloseTo(4 + 1 / 60, 9);
    for (const frame of [0, 1, 17, 299])
      expect(frameAt(timeOf(frame, 10, 300), 10, 300)).toBe(frame);
  });

  it("refuses a recording without a length or frames", () => {
    for (const [duration, frames] of [
      [0, 300],
      [NaN, 300],
      [Infinity, 300],
      [10, 0],
      [10, 1.5],
    ]) {
      expect(() => frameAt(1, duration, frames)).toThrow(
        "Invalid recording length",
      );
      expect(() => timeOf(1, duration, frames)).toThrow(
        "Invalid recording length",
      );
    }
  });
});

describe("the admitted part of a decoded picture", () => {
  it("is the crop where the picture is decoded at the size it was admitted from", () => {
    expect(
      sourceRectangle(
        [100, 50, 256, 256],
        { rows: 480, columns: 720 },
        { width: 720, height: 480 },
      ),
    ).toEqual([100, 50, 256, 256]);
  });

  it("is scaled where the browser decodes the picture at another size", () => {
    expect(
      sourceRectangle(
        [90, 60, 360, 240],
        { rows: 480, columns: 720 },
        { width: 640, height: 480 },
      ),
    ).toEqual([80, 60, 320, 240]);
  });

  it("refuses a picture without a size", () => {
    expect(() =>
      sourceRectangle(
        [0, 0, 8, 8],
        { rows: 8, columns: 8 },
        { width: 0, height: 8 },
      ),
    ).toThrow("Invalid picture size");
  });
});

describe("likeness of two pictures", () => {
  const a = Uint8Array.from([10, 40, 90, 200, 30, 120, 60, 250]);
  it("is 1 for the same picture, also brighter or with more contrast", () => {
    expect(likeness(a, a)).toBeCloseTo(1, 9);
    expect(
      likeness(
        a,
        a.map((v) => v / 2 + 20),
      ),
    ).toBeGreaterThan(0.999);
  });
  it("is low for another picture, and 0 for a flat one", () => {
    expect(likeness(a, Uint8Array.from(a).reverse())).toBeLessThan(0.5);
    expect(
      likeness(
        a,
        a.map((v) => 255 - v),
      ),
    ).toBeCloseTo(-1, 9);
    expect(likeness(a, new Uint8Array(8).fill(7))).toBe(0);
  });
  it("refuses pictures of different sizes, and empty ones", () => {
    expect(() => likeness(a, a.subarray(1))).toThrow("Invalid pictures");
    expect(() => likeness(new Uint8Array(0), new Uint8Array(0))).toThrow(
      "Invalid pictures",
    );
  });
});
