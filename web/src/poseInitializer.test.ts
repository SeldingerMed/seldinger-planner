// @vitest-environment node
/** The browser's side of the learned view initializer, held to the answers
 * of the training framework and of the Python research code. */
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/view-network-forward.json";
import {
  binCenter,
  networkInput,
  parseViewNetwork,
  proposeViews,
  runViewNetwork,
  toGrid,
  turnedFrame,
  VIEW_BINS,
  viewOfAxes,
  viewSeparationDeg,
  type ViewAnswer,
} from "./poseInitializer";
import type { VesselEvidence } from "./vesselEvidence2d";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const floats = (text: string) => {
  const raw = bytes(text);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
};
const worst = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  let most = 0;
  for (let k = 0; k < a.length; k++)
    most = Math.max(most, Math.abs(a[k] - b[k]));
  return most;
};
const file = () => bytes(fixture.file);
const stored = (): ViewAnswer => ({
  scores: floats(fixture.scores),
  offsets: floats(fixture.offsets),
  turns: floats(fixture.turns),
});

/** The file with its JSON header changed, re-padded and re-measured. */
function withHeader(change: (header: any) => void): Uint8Array {
  const data = file(),
    length = new DataView(data.buffer).getUint32(8, true),
    header = JSON.parse(Buffer.from(data.subarray(12, 12 + length)).toString());
  change(header);
  let text = JSON.stringify(header);
  text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const out = new Uint8Array(
    12 + Buffer.byteLength(text) + data.length - 12 - length,
  );
  out.set(data.subarray(0, 8));
  new DataView(out.buffer).setUint32(8, Buffer.byteLength(text), true);
  out.set(Buffer.from(text), 12);
  out.set(data.subarray(12 + length), 12 + Buffer.byteLength(text));
  return out;
}

describe("the stored view network", () => {
  it("answers as the training framework does", () => {
    const network = parseViewNetwork(file()),
      answer = runViewNetwork(network, floats(fixture.input)),
      expected = stored();
    expect(network.grid).toBe(32);
    expect(network.input_blur_px).toEqual([8, 2]);
    // The comparison is not one of zeros.
    expect(Math.max(...expected.scores.map(Math.abs))).toBeGreaterThan(0.5);
    expect(worst(answer.scores, expected.scores)).toBeLessThan(1e-4);
    expect(worst(answer.offsets, expected.offsets)).toBeLessThan(1e-4);
    expect(worst(answer.turns, expected.turns)).toBeLessThan(1e-4);
  });

  it("carries its record through unread", () => {
    expect(parseViewNetwork(file()).record).toEqual({
      purpose: "forward pass fixture, random weights",
    });
  });

  it("gives a different answer for a different input", () => {
    const network = parseViewNetwork(file()),
      input = floats(fixture.input).slice();
    input.fill(0, 0, 400);
    const answer = runViewNetwork(network, input);
    expect(worst(answer.scores, stored().scores)).toBeGreaterThan(1e-3);
  });

  it.each([
    ["a short input", (input: Float32Array) => input.subarray(1)],
    [
      "an input with a value that is not a number",
      (input: Float32Array) => {
        const copy = input.slice();
        copy[7] = NaN;
        return copy;
      },
    ],
    [
      "an input that is not float32",
      (input: Float32Array) => Array.from(input),
    ],
  ])("refuses %s", (_, change) => {
    const network = parseViewNetwork(file());
    expect(() =>
      runViewNetwork(network, change(floats(fixture.input)) as Float32Array),
    ).toThrow("Invalid view network input");
  });

  it.each<[string, () => Uint8Array, string]>([
    ["another kind of file", () => file().fill(65, 0, 8), "not a view network"],
    [
      "a file cut inside its start",
      () => file().subarray(0, 10),
      "not a view network",
    ],
    [
      "a header longer than the file",
      () => {
        const data = file();
        new DataView(data.buffer).setUint32(8, 1 << 19, true);
        return data;
      },
      "header length",
    ],
    [
      "a header that is not JSON",
      () => {
        const data = file();
        data.set([123, 123, 123, 123], 12);
        return data;
      },
      "header",
    ],
    [
      "a header that is a list",
      () => withHeader((h) => Object.keys(h).forEach((k) => delete h[k])),
      "format",
    ],
    [
      "another format",
      () => withHeader((h) => (h.format = "seldinger-view-network-v2")),
      "format",
    ],
    [
      "a grid that is too large",
      () => withHeader((h) => (h.grid = 4096)),
      "grid",
    ],
    [
      "a grid that is not whole",
      () => withHeader((h) => (h.grid = 32.5)),
      "grid",
    ],
    [
      "another number of bins",
      () => withHeader((h) => (h.bins = 100)),
      "shape of the answer",
    ],
    [
      "another number of channels",
      () => withHeader((h) => (h.channels = 3)),
      "shape of the answer",
    ],
    ["five stages", () => withHeader((h) => h.widths.push(7)), "architecture"],
    [
      "a stage with no blocks",
      () => withHeader((h) => (h.blocks[1] = 0)),
      "architecture",
    ],
    [
      "a level the filter does not make",
      () => withHeader((h) => (h.input_blur_px = [8, 3])),
      "input levels",
    ],
    ["a missing tensor", () => withHeader((h) => h.tensors.pop()), "tensors"],
    [
      "a renamed tensor",
      () => withHeader((h) => (h.tensors[0].name = "stem.w")),
      "tensor stem.weight",
    ],
    [
      "a tensor of another shape",
      () => withHeader((h) => (h.tensors[0].shape = [3, 2, 9])),
      "tensor stem.weight",
    ],
    [
      "a tensor out of place",
      () => withHeader((h) => (h.tensors[1].offset += 1)),
      "tensor stem.bias",
    ],
    [
      "widths the tensors do not have",
      () => withHeader((h) => (h.widths[0] = 4)),
      "tensor stem.weight",
    ],
    [
      "a wrong count of floats",
      () => withHeader((h) => (h.floats += 1)),
      "length",
    ],
    ["a file cut short", () => file().subarray(0, file().length - 4), "length"],
    [
      "a weight that is not a number",
      () => {
        const data = file();
        new DataView(data.buffer).setFloat32(data.length - 4, NaN, true);
        return data;
      },
      "a weight is not a number",
    ],
  ])("refuses %s", (_, make, message) => {
    expect(() => parseViewNetwork(make())).toThrow(
      "Invalid view network file: " + message,
    );
  });

  it("refuses something that is not bytes", () => {
    expect(() => parseViewNetwork([1, 2, 3] as unknown as Uint8Array)).toThrow(
      "Invalid view network file: size",
    );
  });
});

describe("the network's input", () => {
  it.each(fixture.grids)(
    "averages a $width by $height level as the Python code does",
    ({ width, height, size, level, grid }) => {
      expect(
        worst(toGrid(floats(level), width, height, size), floats(grid)),
      ).toBeLessThan(1e-6);
    },
  );

  it("refuses a level whose size does not match", () => {
    expect(() => toGrid(new Float32Array(10), 4, 3, 16)).toThrow(
      "Invalid evidence level",
    );
    expect(() => toGrid(new Float32Array(12), 4, 3, 0)).toThrow(
      "Invalid evidence level",
    );
  });

  it("reads the levels the network names, in its order", () => {
    const network = parseViewNetwork(file()),
      width = 80,
      height = 64,
      levels = [16, 8, 4, 2, 1].map((blur) =>
        new Float32Array(width * height).fill(blur / 16),
      ),
      evidence = {
        width,
        height,
        scale: 1,
        levels,
        strong: new Int32Array(0),
      } as VesselEvidence,
      input = networkInput(network, evidence),
      area = network.grid * network.grid,
      middle = (network.grid / 2) * network.grid + network.grid / 2;
    expect(input).toHaveLength(2 * area);
    expect(input[middle]).toBeCloseTo(8 / 16, 6);
    expect(input[area + middle]).toBeCloseTo(2 / 16, 6);
    // The shorter side is centered: the top rows are empty.
    expect(input[network.grid / 2]).toBe(0);
    expect(() =>
      networkInput(network, { ...evidence, levels: levels.slice(0, 2) }),
    ).toThrow("lacks a level");
  });
});

describe("reading the answer", () => {
  it("lays the bins out as the Python code does", () => {
    expect(VIEW_BINS.count).toBe(275);
    expect(binCenter(0)).toEqual([-120, -50]);
    expect(binCenter(24)).toEqual([120, -50]);
    expect(binCenter(25)).toEqual([-120, -40]);
    expect(binCenter(274)).toEqual([120, 50]);
  });

  it("proposes the views the Python code proposes", () => {
    const found = proposeViews(stored());
    expect(found).toHaveLength(fixture.proposals.length);
    found.forEach((mine, k) => {
      const kept = fixture.proposals[k];
      expect(mine.primary_deg).toBeCloseTo(kept.primary_deg, 4);
      expect(mine.secondary_deg).toBeCloseTo(kept.secondary_deg, 4);
      expect(mine.turn_deg).toBeCloseTo(kept.turn_deg, 4);
      expect(mine.share).toBeCloseTo(kept.share, 6);
    });
  });

  const answer = (peaks: [number, number, [number, number], number][]) => {
    const made: ViewAnswer = {
      scores: new Float32Array(VIEW_BINS.count).fill(-9),
      offsets: new Float32Array(2 * VIEW_BINS.count),
      turns: new Float32Array(VIEW_BINS.count),
    };
    for (const [bin, logit, offset, turn] of peaks) {
      made.scores[bin] = logit;
      made.offsets.set(offset, 2 * bin);
      made.turns[bin] = turn;
    }
    return made;
  };
  // Bin of primary 90, secondary 0 and of primary -90, secondary 0.
  const LEFT = 5 * 25 + 21,
    RIGHT = 5 * 25 + 3;

  it("ranks the proposals and applies the offsets of their bins", () => {
    expect(binCenter(LEFT)).toEqual([90, 0]);
    expect(binCenter(RIGHT)).toEqual([-90, 0]);
    const found = proposeViews(
      answer([
        [LEFT, 5, [0.3, -0.4], 0.5],
        [RIGHT, 4, [0, 0], -0.2],
      ]),
    );
    expect(found).toHaveLength(VIEW_BINS.max_proposals);
    // The offsets are float32.
    expect(found[0].primary_deg).toBeCloseTo(93, 5);
    expect(found[0].secondary_deg).toBeCloseTo(-4, 5);
    expect(found[0].turn_deg).toBeCloseTo(15, 5);
    expect(found[1].primary_deg).toBe(-90);
    expect(found[1].turn_deg).toBeCloseTo(-6, 5);
    expect(found[0].share).toBeGreaterThan(found[1].share);
    expect(found[1].share).toBeGreaterThan(found[2].share);
    expect(
      found.reduce((sum, item) => sum + item.share, 0),
    ).toBeLessThanOrEqual(1);
  });

  it("keeps no two proposals closer than the minimum separation", () => {
    const found = proposeViews(
      answer([
        [5 * 25 + 15, 5, [0, 0], 0],
        [5 * 25 + 16, 4.9, [0, 0], 0],
        [8 * 25 + 12, 3, [0, 0], 0],
      ]),
    );
    expect(
      found.slice(0, 2).map((p) => [p.primary_deg, p.secondary_deg]),
    ).toEqual([
      [30, 0],
      [0, 30],
    ]);
    for (const [i, a] of found.entries())
      for (const b of found.slice(i + 1))
        expect(viewSeparationDeg(a, b)).toBeGreaterThanOrEqual(
          VIEW_BINS.min_separation_deg,
        );
  });

  it.each<[string, (a: ViewAnswer) => unknown]>([
    ["too few scores", (a) => ({ ...a, scores: a.scores.subarray(1) })],
    ["too few offsets", (a) => ({ ...a, offsets: a.offsets.subarray(2) })],
    ["too few turns", (a) => ({ ...a, turns: a.turns.subarray(1) })],
    ["a score that is not a number", (a) => ((a.scores[3] = NaN), a)],
    ["an infinite offset", (a) => ((a.offsets[9] = Infinity), a)],
    ["plain arrays", (a) => ({ ...a, turns: Array.from(a.turns) })],
  ])("refuses an answer with %s", (_, change) => {
    expect(() =>
      proposeViews(change(answer([[LEFT, 1, [0.1, 0.1], 0]])) as ViewAnswer),
    ).toThrow("Invalid network answer");
  });
});

describe("views with an in-plane turn", () => {
  it.each(fixture.frames)(
    "turns the frame of $view as the Python code does",
    ({ view, u, v, d }) => {
      const frame = turnedFrame(view);
      expect(worst(frame.u, u)).toBeLessThan(1e-12);
      expect(worst(frame.v, v)).toBeLessThan(1e-12);
      expect(worst(frame.d, d)).toBeLessThan(1e-12);
      const back = viewOfAxes(
        frame.d.map((x) => 2.5 * x) as [number, number, number],
        frame.v,
      );
      expect(back.primary_deg).toBeCloseTo(view.primary_deg, 9);
      expect(back.secondary_deg).toBeCloseTo(view.secondary_deg, 9);
      expect(back.turn_deg).toBeCloseTo(view.turn_deg, 9);
    },
  );

  it("refuses a turn or a direction that is not usable", () => {
    expect(() =>
      turnedFrame({ primary_deg: 0, secondary_deg: 0, turn_deg: 181 }),
    ).toThrow("Invalid in-plane turn");
    expect(() =>
      turnedFrame({ primary_deg: 0, secondary_deg: 0, turn_deg: NaN }),
    ).toThrow("Invalid in-plane turn");
    expect(() => viewOfAxes([0, 0, 0], [0, 0, 1])).toThrow(
      "Invalid viewing direction",
    );
    expect(() => viewOfAxes([0, 1, 0], [0, NaN, 1])).toThrow(
      "Invalid viewing direction",
    );
  });

  it("measures the angle between two viewing directions", () => {
    const at = (primary_deg: number, secondary_deg: number) => ({
      primary_deg,
      secondary_deg,
    });
    expect(viewSeparationDeg(at(0, 0), at(90, 0))).toBeCloseTo(90, 9);
    expect(viewSeparationDeg(at(10, 0), at(10, 35))).toBeCloseTo(35, 9);
    expect(viewSeparationDeg(at(0, 50), at(10, 50))).toBeLessThan(6.5);
  });
});
