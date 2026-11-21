/** Devices in an X-ray frame (Step C4 part 3): a small network marks the
 * pixels of catheters and guidewires, so that the vessel evidence of a
 * frame is not read from them.
 *
 * This file is the browser's side of scripts/research/device_detector: the
 * stored network file, its forward pass, the network's input and the frame
 * pixels its answer marks. Both sides are held to the same fixtures. */
import { toGrid } from "./poseInitializer";
import type { Polarity } from "./vesselness2d";

export const DEVICE_NETWORK_FORMAT = "seldinger-device-network-v1";
export const DEVICE_NETWORK_LIMITS = {
  max_bytes: 16 * 1024 * 1024,
  max_header_bytes: 1 << 20,
  /** Side of the square grid the network reads, a multiple of 16. */
  grid: [32, 256],
  levels: 5,
  max_width: 256,
  /** A grid cell at or above this likelihood is device. */
  threshold: 0.5,
  /** Marked cells are grown by this many cells, edge neighbors only. */
  grow_cells: 1,
} as const;

const MAGIC = "SLDDEVC1";

type Tensor = { shape: number[]; data: Float32Array };
export type DeviceNetwork = {
  grid: number;
  widths: number[];
  tensors: Map<string, Tensor>;
  /** What the file says about how it was made. Not interpreted here. */
  record: unknown;
};

/** Names and shapes of every tensor of a network of these widths. */
function expectedTensors(widths: number[]): [string, number[]][] {
  const out: [string, number[]][] = [];
  const add = (name: string, shape: number[]) =>
    out.push([`${name}.weight`, shape], [`${name}.bias`, [shape[0]]]);
  const pair = (name: string, inputs: number, outputs: number) => {
    add(`${name}.first`, [outputs, inputs, 3, 3]);
    add(`${name}.second`, [outputs, outputs, 3, 3]);
  };
  widths.forEach((width, level) =>
    pair(`down.${level}`, level ? widths[level - 1] : 1, width),
  );
  for (let level = 0; level < widths.length - 1; level++)
    pair(`up.${level}`, widths[level + 1] + widths[level], widths[level]);
  add("head", [1, widths[0], 1, 1]);
  return out;
}

/** Reads a stored network file. Throws on anything but a complete, finite
 * network of the one architecture this file runs. */
export function parseDeviceNetwork(file: Uint8Array): DeviceNetwork {
  const L = DEVICE_NETWORK_LIMITS,
    bad = (what: string) => new Error("Invalid device network file: " + what);
  if (!(file instanceof Uint8Array) || file.length > L.max_bytes)
    throw bad("size");
  if (file.length < 12 || String.fromCharCode(...file.subarray(0, 8)) !== MAGIC)
    throw bad("not a device network");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength),
    length = view.getUint32(8, true);
  if (length > L.max_header_bytes || length % 4 || 12 + length > file.length)
    throw bad("header length");
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        file.subarray(12, 12 + length),
      ),
    );
  } catch {
    throw bad("header");
  }
  if (!header || typeof header !== "object" || Array.isArray(header))
    throw bad("header");
  if (header.format !== DEVICE_NETWORK_FORMAT) throw bad("format");
  const grid = header.grid as number;
  if (
    !Number.isInteger(grid) ||
    grid < L.grid[0] ||
    grid > L.grid[1] ||
    grid % (1 << (L.levels - 1))
  )
    throw bad("grid");
  const widths = header.widths;
  if (
    !Array.isArray(widths) ||
    widths.length !== L.levels ||
    !widths.every((x) => Number.isInteger(x) && x >= 1 && x <= L.max_width)
  )
    throw bad("architecture");
  const expected = expectedTensors(widths as number[]),
    listed = header.tensors,
    floats = (file.length - 12 - length) / 4;
  if (!Array.isArray(listed) || listed.length !== expected.length)
    throw bad("tensors");
  if (header.floats !== floats) throw bad("length");
  const body = new DataView(
    file.buffer,
    file.byteOffset + 12 + length,
    floats * 4,
  );
  const tensors = new Map<string, Tensor>();
  let offset = 0;
  expected.forEach(([name, shape], k) => {
    const item = listed[k] as Record<string, unknown>;
    if (
      !item ||
      item.name !== name ||
      item.offset !== offset ||
      !Array.isArray(item.shape) ||
      item.shape.length !== shape.length ||
      !item.shape.every((x, i) => x === shape[i])
    )
      throw bad("tensor " + name);
    const size = shape.reduce((a, b) => a * b, 1);
    if (offset + size > floats) throw bad("length");
    const data = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const value = body.getFloat32((offset + i) * 4, true);
      if (!Number.isFinite(value)) throw bad("a weight is not a number");
      data[i] = value;
    }
    tensors.set(name, { shape, data });
    offset += size;
  });
  if (offset !== floats) throw bad("length");
  return {
    grid,
    widths: [...(widths as number[])],
    tensors,
    record: header.record,
  };
}

/** What the network reads for an 8-bit frame: devices dark, on the square
 * grid, less its mean and over its spread. Mirrors `network_input` in
 * device_detector/network.py. */
export function deviceInput(
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
  grid: number,
): Float32Array {
  if (!(gray instanceof Uint8Array) || gray.length !== width * height)
    throw new Error("Frame pixels do not match its size");
  if (polarity !== "dark" && polarity !== "bright")
    throw new Error("Polarity is dark or bright");
  const cells = toGrid(Float32Array.from(gray), width, height, grid),
    values = new Float64Array(cells.length);
  let mean = 0;
  for (let k = 0; k < cells.length; k++)
    mean += values[k] = polarity === "bright" ? 255 - cells[k] : cells[k];
  mean /= cells.length;
  let spread = 0;
  for (let k = 0; k < cells.length; k++) spread += (values[k] - mean) ** 2;
  spread = Math.sqrt(spread / cells.length);
  const out = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++)
    out[k] = (values[k] - mean) / (spread + 1);
  return out;
}

type Maps = { data: Float32Array; channels: number; size: number };

/** A 3 by 3 or 1 by 1 convolution at stride 1, padded to keep the size,
 * with its bias. Yields after every output channel. */
function* convolve(
  input: Maps,
  weight: Tensor,
  bias: Tensor,
  rectified: boolean,
): Generator<void, Maps> {
  const [outputs, inputs, kernel] = weight.shape,
    pad = kernel >> 1,
    n = input.size,
    area = n * n,
    out = new Float32Array(outputs * area),
    sum = new Float64Array(area);
  for (let o = 0; o < outputs; o++) {
    sum.fill(bias.data[o]);
    for (let i = 0; i < inputs; i++) {
      const plane = i * area;
      for (let ky = 0; ky < kernel; ky++)
        for (let kx = 0; kx < kernel; kx++) {
          const w = weight.data[((o * inputs + i) * kernel + ky) * kernel + kx];
          if (w === 0) continue;
          const dy = ky - pad,
            dx = kx - pad,
            x0 = Math.max(0, -dx),
            x1 = Math.min(n, n - dx);
          for (let y = Math.max(0, -dy); y < Math.min(n, n - dy); y++) {
            const from = plane + (y + dy) * n + dx,
              to = y * n;
            for (let x = x0; x < x1; x++)
              sum[to + x] += w * input.data[from + x];
          }
        }
    }
    const to = o * area;
    if (rectified)
      for (let k = 0; k < area; k++) out[to + k] = sum[k] > 0 ? sum[k] : 0;
    else out.set(sum, to);
    yield;
  }
  return { data: out, channels: outputs, size: n };
}

function halved(maps: Maps): Maps {
  const n = maps.size,
    m = n >> 1,
    out = new Float32Array(maps.channels * m * m);
  for (let c = 0; c < maps.channels; c++)
    for (let y = 0; y < m; y++)
      for (let x = 0; x < m; x++) {
        const at = c * n * n + 2 * y * n + 2 * x;
        out[(c * m + y) * m + x] = Math.max(
          maps.data[at],
          maps.data[at + 1],
          maps.data[at + n],
          maps.data[at + n + 1],
        );
      }
  return { data: out, channels: maps.channels, size: m };
}

/** `low` at twice its size, each value repeated, followed by `kept`. */
function joined(low: Maps, kept: Maps): Maps {
  const n = kept.size,
    area = n * n,
    out = new Float32Array((low.channels + kept.channels) * area);
  for (let c = 0; c < low.channels; c++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++)
        out[c * area + y * n + x] =
          low.data[(c * low.size + (y >> 1)) * low.size + (x >> 1)];
  out.set(kept.data, low.channels * area);
  return { data: out, channels: low.channels + kept.channels, size: n };
}

/** The network's likelihood of a device in each grid cell, row-major, for
 * one input of `grid` by `grid` values. Yields between short slices. */
export function* runDeviceNetworkSteps(
  network: DeviceNetwork,
  input: Float32Array,
): Generator<void, Float32Array> {
  const { grid, tensors, widths } = network;
  if (
    !(input instanceof Float32Array) ||
    input.length !== grid * grid ||
    !input.every(Number.isFinite)
  )
    throw new Error("Invalid device network input");
  const at = (name: string) => tensors.get(name)!;
  function* pair(maps: Maps, name: string): Generator<void, Maps> {
    for (const part of ["first", "second"])
      maps = yield* convolve(
        maps,
        at(`${name}.${part}.weight`),
        at(`${name}.${part}.bias`),
        true,
      );
    return maps;
  }
  let x: Maps = { data: input, channels: 1, size: grid };
  const kept: Maps[] = [];
  for (let level = 0; level < widths.length; level++) {
    x = yield* pair(level ? halved(x) : x, `down.${level}`);
    kept.push(x);
  }
  for (let level = widths.length - 2; level >= 0; level--)
    x = yield* pair(joined(x, kept[level]), `up.${level}`);
  const logits = yield* convolve(x, at("head.weight"), at("head.bias"), false),
    likely = new Float32Array(grid * grid);
  for (let k = 0; k < likely.length; k++)
    likely[k] = 1 / (1 + Math.exp(-logits.data[k]));
  return likely;
}

export function runDeviceNetwork(
  network: DeviceNetwork,
  input: Float32Array,
): Float32Array {
  const steps = runDeviceNetworkSteps(network, input);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Frame pixels marked as device, 1 where so, from the likelihood of each
 * grid cell: cells at or above the threshold, grown by one cell, laid over
 * the frame as the frame was laid on the grid. Mirrors `frame_mask` in
 * device_detector/network.py. */
export function deviceMask(
  likely: Float32Array,
  width: number,
  height: number,
): Uint8Array {
  const grid = Math.round(Math.sqrt(likely.length)),
    L = DEVICE_NETWORK_LIMITS;
  if (
    !(likely instanceof Float32Array) ||
    grid * grid !== likely.length ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("Invalid device likelihoods");
  let cells = new Uint8Array(likely.length);
  for (let k = 0; k < cells.length; k++)
    cells[k] = likely[k] >= L.threshold ? 1 : 0;
  for (let pass = 0; pass < L.grow_cells; pass++) {
    const grown = cells.slice();
    for (let y = 0; y < grid; y++)
      for (let x = 0; x < grid; x++)
        if (cells[y * grid + x]) {
          if (y > 0) grown[(y - 1) * grid + x] = 1;
          if (y < grid - 1) grown[(y + 1) * grid + x] = 1;
          if (x > 0) grown[y * grid + x - 1] = 1;
          if (x < grid - 1) grown[y * grid + x + 1] = 1;
        }
    cells = grown;
  }
  const step = Math.max(width, height) / grid,
    cell = (pixel: number, length: number) =>
      Math.min(
        grid - 1,
        Math.max(
          0,
          Math.floor((pixel + 0.5 - (length - grid * step) / 2) / step),
        ),
      ),
    columns = Int32Array.from({ length: width }, (_, x) => cell(x, width)),
    out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = cell(y, height) * grid;
    for (let x = 0; x < width; x++)
      out[y * width + x] = cells[row + columns[x]];
  }
  return out;
}

/** The frame pixels a network marks as device. Yields between slices. */
export function* markDevicesSteps(
  network: DeviceNetwork,
  gray: Uint8Array,
  width: number,
  height: number,
  polarity: Polarity,
): Generator<void, Uint8Array> {
  const input = deviceInput(gray, width, height, polarity, network.grid);
  yield;
  return deviceMask(
    yield* runDeviceNetworkSteps(network, input),
    width,
    height,
  );
}
