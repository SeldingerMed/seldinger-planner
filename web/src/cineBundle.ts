/** The local cine bundle (planner/cine_bundle.py), read in the browser.
 *
 * The bundle stays on the operator's machine and is never sent to the
 * server: only its digests go into a confirmed record. Its frames are 8-bit
 * brightness, contrast dark, one window over the whole cine. Its times are
 * those the file recorded; a file holding only a display rate has none. */
import { sha256Hex } from "./browserCrypto";
import { validateView, type ViewNumbers } from "./carmGeometry";
import type { CineFrame } from "./coronaryMotion";

export const CINE_BUNDLE_FORMAT = "seldinger-cine-bundle-v1";
const MAX_FRAMES = 600,
  MAX_SIDE = 2048;
const KEYS = [
  "format",
  "source_sha256",
  "frames",
  "rows",
  "columns",
  "times_ms",
  "timing",
  "view",
  "geometry",
  "transfer_syntax",
  "window",
  "identifiers",
];
const SHA = /^[a-f0-9]{64}$/;

export type CineBundle = {
  source_sha256: string;
  bundle_sha256: string;
  timing: "frame_time_vector" | "frame_time" | "cine_rate" | null;
  view: ViewNumbers | null;
  geometry: "fixed" | "moving" | "unknown";
  transfer_syntax: string;
  /** Times are NaN where the file recorded none. */
  frames: CineFrame[];
};

function fail(): never {
  throw new Error("Not a cine bundle");
}

const count = (v: unknown, low: number, high: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= low && v <= high;

export async function parseCineBundle(buffer: ArrayBuffer): Promise<CineBundle> {
  const bytes = new Uint8Array(buffer);
  const first = bytes.indexOf(10);
  if (first < 0 || first > 64) fail();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let format: string, header: Record<string, unknown>, second: number;
  try {
    format = decoder.decode(bytes.subarray(0, first));
    second = bytes.indexOf(10, first + 1);
    if (second < 0 || second - first > 1 << 20) fail();
    header = JSON.parse(decoder.decode(bytes.subarray(first + 1, second)));
  } catch {
    fail();
  }
  if (format !== CINE_BUNDLE_FORMAT || !header || typeof header !== "object" || Array.isArray(header))
    fail();
  const have = Object.keys(header);
  if (have.length !== KEYS.length || !KEYS.every((k) => have.includes(k))) fail();
  const h = header as Record<string, any>;
  if (
    h.format !== CINE_BUNDLE_FORMAT ||
    typeof h.source_sha256 !== "string" ||
    !SHA.test(h.source_sha256) ||
    !count(h.frames, 2, MAX_FRAMES) ||
    !count(h.rows, 1, MAX_SIDE) ||
    !count(h.columns, 1, MAX_SIDE) ||
    !["frame_time_vector", "frame_time", "cine_rate", null].includes(h.timing) ||
    !["fixed", "moving", "unknown"].includes(h.geometry) ||
    typeof h.transfer_syntax !== "string" ||
    h.transfer_syntax.length > 64 ||
    h.window !== "percentile_0.5_99.5_whole_cine" ||
    h.identifiers !== "not_carried"
  )
    fail();
  const recorded = h.timing === "frame_time_vector" || h.timing === "frame_time";
  if (recorded) {
    const t = h.times_ms;
    if (
      !Array.isArray(t) ||
      t.length !== h.frames ||
      t.some((x: unknown) => typeof x !== "number" || !Number.isFinite(x)) ||
      t.some((x: number, k: number) => k > 0 && x <= t[k - 1])
    )
      fail();
  } else if (h.times_ms !== null) fail();
  let view: ViewNumbers | null = null;
  if (h.view !== null) {
    if (typeof h.view !== "object" || Array.isArray(h.view) || Object.keys(h.view).length !== 6)
      fail();
    try {
      view = validateView(h.view);
    } catch {
      fail();
    }
  }
  const size = h.rows * h.columns,
    body = bytes.subarray(second + 1);
  if (body.length !== size * h.frames) fail();
  const frames: CineFrame[] = Array.from({ length: h.frames }, (_, k) => ({
    pixels: body.slice(k * size, (k + 1) * size),
    width: h.columns,
    height: h.rows,
    time_ms: recorded ? h.times_ms[k] : NaN,
  }));
  return {
    source_sha256: h.source_sha256,
    bundle_sha256: await sha256Hex(buffer),
    timing: h.timing,
    view,
    geometry: h.geometry,
    transfer_syntax: h.transfer_syntax,
    frames,
  };
}
