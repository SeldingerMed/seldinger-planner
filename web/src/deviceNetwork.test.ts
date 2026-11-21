// @vitest-environment node
/** The browser's side of the device network, held to the answers of the
 * training framework and of the Python research code. */
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/device-network-forward.json";
import {
  DEVICE_NETWORK_LIMITS,
  deviceInput,
  deviceMask,
  markDevicesSteps,
  parseDeviceNetwork,
  runDeviceNetwork,
  runDeviceNetworkSteps,
} from "./deviceNetwork";

const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const floats = (text: string) => {
  const raw = bytes(text);
  return new Float32Array(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  );
};
const worst = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  let most = 0;
  for (let k = 0; k < a.length; k++)
    most = Math.max(most, Math.abs(a[k] - b[k]));
  return most;
};
const file = () => bytes(fixture.file);
const SIDE = 32;

/** The file with its header changed and re-padded. */
function withHeader(change: (header: Record<string, unknown>) => void) {
  const data = file(),
    view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    length = view.getUint32(8, true),
    header = JSON.parse(
      new TextDecoder().decode(data.subarray(12, 12 + length)),
    );
  change(header);
  let text = JSON.stringify(header);
  text += " ".repeat((4 - (text.length % 4)) % 4);
  const out = new Uint8Array(12 + text.length + data.length - 12 - length);
  out.set(data.subarray(0, 8));
  new DataView(out.buffer).setUint32(8, text.length, true);
  out.set(new TextEncoder().encode(text), 12);
  out.set(data.subarray(12 + length), 12 + text.length);
  return out;
}

describe("the stored device network", () => {
  it("reads the fixture file", () => {
    const network = parseDeviceNetwork(file());
    expect(network.grid).toBe(SIDE);
    expect(network.widths).toEqual([2, 3, 4, 5, 6]);
    expect(network.record).toEqual({
      purpose: "forward pass fixture, random weights",
    });
    expect(network.tensors.size).toBe(38);
    expect(network.tensors.get("up.3.first.weight")!.shape).toEqual([
      5, 11, 3, 3,
    ]);
  });

  it("answers as the training framework does", () => {
    const network = parseDeviceNetwork(file()),
      likely = runDeviceNetwork(network, floats(fixture.input)),
      stored = floats(fixture.likely);
    expect(worst(likely, stored)).toBeLessThan(1e-4);
    // The answer depends on the input.
    const other = floats(fixture.input);
    other[5 * SIDE + 9] += 3;
    expect(worst(runDeviceNetwork(network, other), stored)).toBeGreaterThan(
      1e-3,
    );
  });

  it("yields between slices and gives the same answer", () => {
    const network = parseDeviceNetwork(file()),
      steps = runDeviceNetworkSteps(network, floats(fixture.input));
    let slices = 0,
      next = steps.next();
    for (; !next.done; next = steps.next()) slices++;
    // One slice for every output channel of every convolution.
    expect(slices).toBe(2 * (2 + 3 + 4 + 5 + 6) + 2 * (2 + 3 + 4 + 5) + 1);
    expect(next.value).toEqual(
      runDeviceNetwork(network, floats(fixture.input)),
    );
  });

  it.each([
    ["an input of another size", new Float32Array(SIDE * SIDE - 1)],
    ["a value that is not a number", floats(fixture.input).fill(NaN, 3, 4)],
    ["another kind of array", new Float64Array(SIDE * SIDE)],
  ])("refuses %s", (_, input) => {
    expect(() =>
      runDeviceNetwork(
        parseDeviceNetwork(file()),
        input as unknown as Float32Array,
      ),
    ).toThrow("Invalid device network input");
  });

  it.each<[string, () => Uint8Array, string]>([
    ["another file's magic", () => file().fill(86, 3, 4), "not a device"],
    ["a short file", () => file().subarray(0, 11), "not a device"],
    ["a cut body", () => file().subarray(0, file().length - 4), "length"],
    [
      "a body with more in it",
      () => Uint8Array.from([...file(), 0, 0, 0, 0]),
      "length",
    ],
    [
      "a header longer than the file",
      () => {
        const data = file();
        new DataView(data.buffer).setUint32(8, data.length, true);
        return data;
      },
      "header length",
    ],
    [
      "a header that is not JSON",
      () => {
        const data = file();
        data[12] = 120;
        return data;
      },
      "header",
    ],
    ["another format", () => withHeader((h) => (h.format = "x")), "format"],
    ["a grid of 24", () => withHeader((h) => (h.grid = 24)), "grid"],
    ["a grid of 40", () => withHeader((h) => (h.grid = 40)), "grid"],
    ["a grid of 512", () => withHeader((h) => (h.grid = 512)), "grid"],
    [
      "four levels",
      () => withHeader((h) => (h.widths = [2, 3, 4, 5])),
      "architecture",
    ],
    [
      "a width of none",
      () => withHeader((h) => (h.widths = [2, 3, 4, 5, 0])),
      "architecture",
    ],
    [
      "widths its tensors do not have",
      () => withHeader((h) => (h.widths = [2, 3, 4, 5, 7])),
      "tensor down.4.first.weight",
    ],
    [
      "a tensor left out",
      () => withHeader((h) => (h.tensors as unknown[]).pop()),
      "tensors",
    ],
    [
      "a tensor under another name",
      () =>
        withHeader(
          (h) => ((h.tensors as { name: string }[])[2].name = "down.0.other"),
        ),
      "tensor down.0.second.weight",
    ],
    [
      "a tensor at another offset",
      () =>
        withHeader((h) => ((h.tensors as { offset: number }[])[1].offset += 1)),
      "tensor down.0.first.bias",
    ],
    [
      "a count of floats that is not the body's",
      () => withHeader((h) => (h.floats = (h.floats as number) + 1)),
      "length",
    ],
    [
      "a weight that is not a number",
      () => {
        const data = file();
        new DataView(data.buffer).setFloat32(data.length - 8, NaN, true);
        return data;
      },
      "a weight is not a number",
    ],
  ])("refuses %s", (_, damaged, what) => {
    expect(() => parseDeviceNetwork(damaged())).toThrow(
      "Invalid device network file: " + what,
    );
  });

  it("refuses a file over the size limit and anything that is not bytes", () => {
    expect(() =>
      parseDeviceNetwork(new Uint8Array(DEVICE_NETWORK_LIMITS.max_bytes + 1)),
    ).toThrow("Invalid device network file: size");
    expect(() =>
      parseDeviceNetwork([1, 2, 3] as unknown as Uint8Array),
    ).toThrow("Invalid device network file: size");
  });
});

describe("the network's input for a frame", () => {
  it.each(fixture.inputs)(
    "is the Python side's for a $width by $height frame, vessels $polarity",
    (stored) => {
      const input = deviceInput(
        bytes(stored.gray),
        stored.width,
        stored.height,
        stored.polarity as "dark" | "bright",
        SIDE,
      );
      expect(worst(input, floats(stored.input))).toBeLessThan(2e-5);
    },
  );

  it("refuses pixels that do not match the size, and an unknown polarity", () => {
    expect(() => deviceInput(new Uint8Array(11), 4, 3, "dark", SIDE)).toThrow(
      "Frame pixels do not match its size",
    );
    expect(() =>
      deviceInput(new Uint8Array(12), 4, 3, "white" as "dark", SIDE),
    ).toThrow("Polarity is dark or bright");
  });
});

describe("the frame pixels marked", () => {
  it.each(fixture.masks)(
    "are the Python side's for a $width by $height frame",
    (stored) => {
      const mask = deviceMask(
        floats(stored.likely),
        stored.width,
        stored.height,
      );
      expect(mask).toEqual(bytes(stored.mask));
      // Some pixels are marked and some are not.
      const marked = mask.reduce((a, b) => a + b, 0);
      expect(marked).toBeGreaterThan(0);
      expect(marked).toBeLessThan(mask.length);
    },
  );

  it("marks a cell at the threshold with its four edge neighbors, and none below it", () => {
    const likely = new Float32Array(SIDE * SIDE);
    likely[10 * SIDE + 12] = DEVICE_NETWORK_LIMITS.threshold;
    const mask = deviceMask(likely, SIDE, SIDE),
      on = [...mask.keys()].filter((k) => mask[k]);
    expect(on).toEqual([
      9 * SIDE + 12,
      10 * SIDE + 11,
      10 * SIDE + 12,
      10 * SIDE + 13,
      11 * SIDE + 12,
    ]);
    likely[10 * SIDE + 12] = 0.49;
    expect(deviceMask(likely, SIDE, SIDE).some(Boolean)).toBe(false);
  });

  it("refuses likelihoods that are not a square grid, and a frame of no size", () => {
    expect(() => deviceMask(new Float32Array(1000), 10, 10)).toThrow(
      "Invalid device likelihoods",
    );
    expect(() => deviceMask(new Float32Array(1024), 0, 10)).toThrow(
      "Invalid device likelihoods",
    );
    expect(() => deviceMask(new Float32Array(1024), 10, 2.5)).toThrow(
      "Invalid device likelihoods",
    );
  });
});

describe("marking a frame", () => {
  it("is the input, the network and the mask in turn", () => {
    const network = parseDeviceNetwork(file()),
      stored = fixture.inputs[0],
      gray = bytes(stored.gray),
      steps = markDevicesSteps(
        network,
        gray,
        stored.width,
        stored.height,
        "dark",
      );
    let next = steps.next(),
      slices = 0;
    for (; !next.done; next = steps.next()) slices++;
    expect(slices).toBeGreaterThan(10);
    expect(next.value).toEqual(
      deviceMask(
        runDeviceNetwork(
          network,
          deviceInput(gray, stored.width, stored.height, "dark", SIDE),
        ),
        stored.width,
        stored.height,
      ),
    );
    expect(next.value).toHaveLength(stored.width * stored.height);
  });
});
