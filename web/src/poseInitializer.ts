/** Learned view initializer (Step C4 part 4): a small network reads the
 * vessel evidence of one frame and proposes which way the frame looks at
 * the head, as ranked C-arm angles with an in-plane turn.
 *
 * This file is the browser's side of scripts/research/pose_initializer:
 * the stored network file, its forward pass, the network's input and the
 * reading of its answer. Both sides are held to the same fixtures.
 *
 * A proposal is a starting view for the registration search and nothing
 * more. It carries the network's own share of belief, which is not a
 * probability of being right. The network was trained on synthetic
 * projections of artery masks; nothing here says how it does on a given
 * real frame. */
import { viewFrame } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import {
  VESSEL_EVIDENCE_LIMITS,
  type VesselEvidence,
} from "./vesselEvidence2d";

export const VIEW_NETWORK_FORMAT = "seldinger-view-network-v1";
export const VIEW_BINS = {
  bin_deg: 10,
  primary_deg: [-120, 120],
  secondary_deg: [-50, 50],
  /** Primary centers times secondary centers. */
  count: 275,
  outputs_per_bin: 4,
  turn_unit_deg: 30,
  max_proposals: 5,
  min_separation_deg: 20,
} as const;
export const VIEW_NETWORK_LIMITS = {
  max_bytes: 64 * 1024 * 1024,
  max_header_bytes: 1 << 20,
  grid: [16, 256],
  channels: 2,
  stages: 4,
  max_width: 512,
  max_blocks: 4,
} as const;

const MAGIC = "SLDVIEW1";
const PRIMARY_COUNT =
  (VIEW_BINS.primary_deg[1] - VIEW_BINS.primary_deg[0]) / VIEW_BINS.bin_deg + 1;
/** Bin centers, row-major over (secondary, primary). */
export const binCenter = (index: number): [number, number] => [
  VIEW_BINS.primary_deg[0] + VIEW_BINS.bin_deg * (index % PRIMARY_COUNT),
  VIEW_BINS.secondary_deg[0] +
    VIEW_BINS.bin_deg * Math.floor(index / PRIMARY_COUNT),
];

type Tensor = { shape: number[]; data: Float32Array };
export type ViewNetwork = {
  grid: number;
  /** Blur widths of the evidence levels the network reads, in order. */
  input_blur_px: number[];
  widths: number[];
  blocks: number[];
  tensors: Map<string, Tensor>;
  /** What the file says about how it was made. Not interpreted here. */
  record: unknown;
};
export type ViewAnswer = {
  /** One logit per bin. */
  scores: Float32Array;
  /** Per bin, primary then secondary, in bin widths from the bin center. */
  offsets: Float32Array;
  /** Per bin, in units of `turn_unit_deg`. */
  turns: Float32Array;
};
export type ViewProposal = {
  primary_deg: number;
  secondary_deg: number;
  /** In-plane turn: image right and up are turned counter-clockwise by
   * this about the viewing direction, seen from the detector. */
  turn_deg: number;
  /** This bin's share of the softmax over all bins. Not a probability
   * that the view is right. */
  share: number;
};

const wholeNumbers = (
  value: unknown,
  length: number,
  low: number,
  high: number,
) =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((x) => Number.isInteger(x) && x >= low && x <= high);

/** Names and shapes of every tensor of a network of these widths. */
function expectedTensors(
  channels: number,
  widths: number[],
  blocks: number[],
): [string, number[]][] {
  const out: [string, number[]][] = [];
  const add = (name: string, shape: number[]) =>
    out.push([`${name}.weight`, shape], [`${name}.bias`, [shape[0]]]);
  add("stem", [widths[0], channels, 3, 3]);
  let inputs = widths[0],
    index = 0;
  widths.forEach((width, stage) => {
    for (let position = 0; position < blocks[stage]; position++, index++) {
      const strided = stage > 0 && position === 0;
      add(`layers.${index}.first`, [width, inputs, 3, 3]);
      add(`layers.${index}.second`, [width, width, 3, 3]);
      if (strided || inputs !== width)
        add(`layers.${index}.skip`, [width, inputs, 1, 1]);
      inputs = width;
    }
  });
  add("head", [VIEW_BINS.count * VIEW_BINS.outputs_per_bin, inputs]);
  return out;
}

/** Reads a stored network file. Throws on anything but a complete, finite
 * network of the one architecture this file runs. */
export function parseViewNetwork(file: Uint8Array): ViewNetwork {
  const L = VIEW_NETWORK_LIMITS,
    bad = (what: string) => new Error("Invalid view network file: " + what);
  if (!(file instanceof Uint8Array) || file.length > L.max_bytes)
    throw bad("size");
  if (file.length < 12 || String.fromCharCode(...file.subarray(0, 8)) !== MAGIC)
    throw bad("not a view network");
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
  if (header.format !== VIEW_NETWORK_FORMAT) throw bad("format");
  const grid = header.grid as number;
  if (!Number.isInteger(grid) || grid < L.grid[0] || grid > L.grid[1])
    throw bad("grid");
  if (
    header.channels !== L.channels ||
    header.bins !== VIEW_BINS.count ||
    header.outputs_per_bin !== VIEW_BINS.outputs_per_bin
  )
    throw bad("shape of the answer");
  if (
    !wholeNumbers(header.widths, L.stages, 1, L.max_width) ||
    !wholeNumbers(header.blocks, L.stages, 1, L.max_blocks)
  )
    throw bad("architecture");
  const known = VESSEL_EVIDENCE_LIMITS.blur_px as readonly number[],
    blurs = header.input_blur_px;
  if (
    !Array.isArray(blurs) ||
    blurs.length !== L.channels ||
    !blurs.every((x) => known.includes(x))
  )
    throw bad("input levels");
  const widths = header.widths as number[],
    blocks = header.blocks as number[],
    expected = expectedTensors(L.channels, widths, blocks),
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
    input_blur_px: [...(blurs as number[])],
    widths: [...widths],
    blocks: [...blocks],
    tensors,
    record: header.record,
  };
}

type Maps = { data: Float32Array; channels: number; size: number };

function convolve(
  input: Maps,
  weight: Tensor,
  bias: Tensor,
  stride: number,
): Maps {
  const [outputs, inputs, kernel] = weight.shape,
    pad = kernel >> 1,
    n = input.size,
    m = Math.floor((n + 2 * pad - kernel) / stride) + 1,
    out = new Float32Array(outputs * m * m),
    sum = new Float64Array(m * m);
  for (let o = 0; o < outputs; o++) {
    sum.fill(bias.data[o]);
    for (let i = 0; i < inputs; i++) {
      const plane = i * n * n;
      for (let ky = 0; ky < kernel; ky++)
        for (let kx = 0; kx < kernel; kx++) {
          const w = weight.data[((o * inputs + i) * kernel + ky) * kernel + kx];
          if (w === 0) continue;
          for (let y = 0; y < m; y++) {
            const sy = y * stride + ky - pad;
            if (sy < 0 || sy >= n) continue;
            const row = plane + sy * n,
              to = y * m;
            for (let x = 0; x < m; x++) {
              const sx = x * stride + kx - pad;
              if (sx >= 0 && sx < n) sum[to + x] += w * input.data[row + sx];
            }
          }
        }
    }
    out.set(sum, o * m * m);
  }
  return { data: out, channels: outputs, size: m };
}

const rectify = (maps: Maps) => {
  for (let k = 0; k < maps.data.length; k++)
    if (maps.data[k] < 0) maps.data[k] = 0;
  return maps;
};

/** The network's answer for one input of `channels` by `grid` by `grid`
 * values from 0 to 1, row-major, channels first. */
export function runViewNetwork(
  network: ViewNetwork,
  input: Float32Array,
): ViewAnswer {
  const { grid, tensors } = network,
    channels = VIEW_NETWORK_LIMITS.channels;
  if (
    !(input instanceof Float32Array) ||
    input.length !== channels * grid * grid ||
    !input.every(Number.isFinite)
  )
    throw new Error("Invalid view network input");
  const at = (name: string) => tensors.get(name)!;
  const layer = (maps: Maps, name: string, stride: number) =>
    convolve(maps, at(`${name}.weight`), at(`${name}.bias`), stride);
  let x = rectify(layer({ data: input, channels, size: grid }, "stem", 2)),
    index = 0;
  network.blocks.forEach((count, stage) => {
    for (let position = 0; position < count; position++, index++) {
      const stride = stage > 0 && position === 0 ? 2 : 1,
        name = `layers.${index}`,
        y = layer(
          rectify(layer(x, `${name}.first`, stride)),
          `${name}.second`,
          1,
        ),
        through = tensors.has(`${name}.skip.weight`)
          ? layer(x, `${name}.skip`, stride)
          : x;
      for (let k = 0; k < y.data.length; k++) y.data[k] += through.data[k];
      x = rectify(y);
    }
  });
  const area = x.size * x.size,
    pooled = new Float64Array(x.channels);
  for (let c = 0; c < x.channels; c++) {
    let sum = 0;
    for (let k = 0; k < area; k++) sum += x.data[c * area + k];
    pooled[c] = sum / area;
  }
  const weight = at("head.weight"),
    bias = at("head.bias"),
    per = VIEW_BINS.outputs_per_bin,
    answer: ViewAnswer = {
      scores: new Float32Array(VIEW_BINS.count),
      offsets: new Float32Array(2 * VIEW_BINS.count),
      turns: new Float32Array(VIEW_BINS.count),
    };
  for (let o = 0; o < VIEW_BINS.count * per; o++) {
    let sum = bias.data[o];
    for (let c = 0; c < x.channels; c++)
      sum += weight.data[o * x.channels + c] * pooled[c];
    const bin = Math.floor(o / per),
      part = o % per;
    if (part === 0) answer.scores[bin] = sum;
    else if (part === 3) answer.turns[bin] = sum;
    else answer.offsets[2 * bin + part - 1] = sum;
  }
  return answer;
}

/** Area average of one evidence level onto a square grid. The frame is
 * centered and its longer side fills the grid; cells beyond the shorter
 * side are zero. Mirrors `to_grid` in pose_initializer/frames.py. */
export function toGrid(
  level: Float32Array,
  width: number,
  height: number,
  size: number,
): Float32Array {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    level.length !== width * height ||
    !Number.isInteger(size) ||
    size < 1
  )
    throw new Error("Invalid evidence level");
  const step = Math.max(width, height) / size;
  // For each grid cell along one axis: the pixels it covers and how much.
  const weights = (length: number) =>
    Array.from({ length: size }, (_, cell) => {
      const start = (length - size * step) / 2 + step * cell,
        first = Math.max(0, Math.floor(start)),
        last = Math.min(length - 1, Math.ceil(start + step) - 1),
        covered: [number, number][] = [];
      for (let pixel = first; pixel <= last; pixel++) {
        const overlap =
          Math.min(start + step, pixel + 1) - Math.max(start, pixel);
        if (overlap > 0) covered.push([pixel, overlap / step]);
      }
      return covered;
    });
  const columns = weights(width),
    rows = weights(height),
    // Rows first, as in the Python copy: weights(height) @ level.
    partial = new Float64Array(size * width),
    out = new Float32Array(size * size);
  rows.forEach((covered, cell) => {
    for (const [pixel, share] of covered)
      for (let x = 0; x < width; x++)
        partial[cell * width + x] += share * level[pixel * width + x];
  });
  for (let cell = 0; cell < size; cell++)
    columns.forEach((covered, column) => {
      let sum = 0;
      for (const [pixel, share] of covered)
        sum += partial[cell * width + pixel] * share;
      out[cell * size + column] = sum;
    });
  return out;
}

/** The network's input for one frame's vessel evidence. */
export function networkInput(
  network: ViewNetwork,
  evidence: VesselEvidence,
): Float32Array {
  const blurs = VESSEL_EVIDENCE_LIMITS.blur_px as readonly number[],
    area = network.grid * network.grid,
    input = new Float32Array(network.input_blur_px.length * area);
  network.input_blur_px.forEach((blur, channel) => {
    const level = evidence.levels[blurs.indexOf(blur)];
    if (!level) throw new Error("The evidence lacks a level the network reads");
    input.set(
      toGrid(level, evidence.width, evidence.height, network.grid),
      channel * area,
    );
  });
  return input;
}

const clamp = (value: number, limit: number) =>
  Math.max(-limit, Math.min(limit, value));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Angle between two viewing directions, in degrees. */
export function viewSeparationDeg(
  a: { primary_deg: number; secondary_deg: number },
  b: { primary_deg: number; secondary_deg: number },
): number {
  const da = viewFrame(a.primary_deg, a.secondary_deg).d,
    db = viewFrame(b.primary_deg, b.secondary_deg).d;
  return (Math.acos(Math.max(-1, Math.min(1, dot(da, db)))) * 180) / Math.PI;
}

/** Ranked views from one answer: the best bins, none within
 * `min_separation_deg` of a better one, at most `max_proposals`. Mirrors
 * `proposals` in pose_initializer/views.py. */
export function proposeViews(answer: ViewAnswer): ViewProposal[] {
  const { scores, offsets, turns } = answer,
    n = VIEW_BINS.count;
  if (
    !(scores instanceof Float32Array) ||
    !(offsets instanceof Float32Array) ||
    !(turns instanceof Float32Array) ||
    scores.length !== n ||
    offsets.length !== 2 * n ||
    turns.length !== n ||
    !scores.every(Number.isFinite) ||
    !offsets.every(Number.isFinite) ||
    !turns.every(Number.isFinite)
  )
    throw new Error("Invalid network answer");
  let top = -Infinity,
    total = 0;
  for (const value of scores) top = Math.max(top, value);
  const share = Array.from(scores, (value) => Math.exp(value - top));
  for (const value of share) total += value;
  // Best first; equal shares keep bin order.
  const order = share
    .map((_, index) => index)
    .sort((a, b) => share[b] - share[a] || a - b);
  const found: ViewProposal[] = [];
  for (const index of order) {
    const [primary, secondary] = binCenter(index),
      view = {
        primary_deg: clamp(
          primary + VIEW_BINS.bin_deg * offsets[2 * index],
          180,
        ),
        secondary_deg: clamp(
          secondary + VIEW_BINS.bin_deg * offsets[2 * index + 1],
          90,
        ),
      };
    if (
      found.some(
        (other) =>
          viewSeparationDeg(view, other) < VIEW_BINS.min_separation_deg,
      )
    )
      continue;
    found.push({
      ...view,
      turn_deg: clamp(VIEW_BINS.turn_unit_deg * turns[index], 180),
      share: share[index] / total,
    });
    if (found.length === VIEW_BINS.max_proposals) break;
  }
  return found;
}

/** Image right, image up and viewing direction of a view with an in-plane
 * turn, in patient RAS. */
export function turnedFrame(view: {
  primary_deg: number;
  secondary_deg: number;
  turn_deg: number;
}): { u: Vec3; v: Vec3; d: Vec3 } {
  if (!Number.isFinite(view.turn_deg) || Math.abs(view.turn_deg) > 180)
    throw new Error("Invalid in-plane turn");
  const { u, v, d } = viewFrame(view.primary_deg, view.secondary_deg),
    t = (view.turn_deg * Math.PI) / 180,
    cos = Math.cos(t),
    sin = Math.sin(t);
  return {
    u: [0, 1, 2].map((i) => cos * u[i] + sin * v[i]) as Vec3,
    v: [0, 1, 2].map((i) => cos * v[i] - sin * u[i]) as Vec3,
    d,
  };
}

/** The view, with its in-plane turn, of a frame whose viewing direction
 * and image-up vector are given in patient RAS. */
export function viewOfAxes(
  direction: Vec3,
  up: Vec3,
): { primary_deg: number; secondary_deg: number; turn_deg: number } {
  const length = Math.hypot(...direction);
  if (!(length > 0) || ![...direction, ...up].every(Number.isFinite))
    throw new Error("Invalid viewing direction");
  const d = direction.map((x) => x / length) as Vec3,
    deg = 180 / Math.PI,
    primary_deg = Math.atan2(-d[0], d[1]) * deg,
    secondary_deg = Math.asin(Math.max(-1, Math.min(1, d[2]))) * deg,
    { u, v } = viewFrame(primary_deg, secondary_deg);
  return {
    primary_deg,
    secondary_deg,
    turn_deg: Math.atan2(-dot(up, u), dot(up, v)) * deg,
  };
}
