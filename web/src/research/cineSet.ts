/** Reading the CardioSYNTAX cines (Hugging Face
 * MesserMMP/coronary-angiography-syntax, CC BY 4.0) for the research
 * evaluations. Each file is decoded to memory by
 * scripts/research/decode_cine.py; nothing is written. */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import type { CineFrame } from "../coronaryMotion";

export const DECODER = new URL(
  "../../../scripts/research/decode_cine.py",
  import.meta.url,
).pathname;

export type DecodedHeader = {
  format: string;
  source_sha256: string;
  frames: number;
  rows: number;
  columns: number;
  times_ms: number[] | null;
  timing: "frame_time_vector" | "frame_time" | "cine_rate" | null;
  view: {
    primary_deg: number;
    secondary_deg: number;
    source_detector_mm: number;
    source_isocenter_mm: number;
    detector_width_mm: number;
    detector_height_mm: number;
  } | null;
  geometry: "fixed" | "moving" | "unknown";
  transfer_syntax: string;
  manufacturer: string;
  sha256: string;
};
export type Decoded = { header: DecodedHeader; frames: Uint8Array[] };

export function decode(python: string, path: string): Decoded {
  const out = execFileSync(python, ["-W", "ignore", DECODER, path], {
    maxBuffer: 2 ** 31,
    // The decoder's own interpreter and packages, not the caller's.
    env: Object.fromEntries(
      Object.entries({ ...process.env, PYTHONDONTWRITEBYTECODE: "1" }).filter(
        ([name]) => name !== "PYTHONPATH" && name !== "PYTHONHOME",
      ),
    ),
  });
  const cut = out.indexOf(10);
  const header = JSON.parse(out.subarray(0, cut).toString("utf8"));
  const size = header.rows * header.columns,
    body = out.subarray(cut + 1);
  if (body.length !== size * header.frames) throw new Error("Short cine");
  return {
    header,
    frames: Array.from(
      { length: header.frames },
      (_, k) => new Uint8Array(body.subarray(k * size, (k + 1) * size)),
    ),
  };
}

/** Studies of a holdout in name order, `from` (inclusive) to `to`
 * (exclusive); each as its files in name order. */
export function studies(
  root: string,
  holdout: string,
  from: number,
  to: number,
): { study: string; files: string[] }[] {
  const base = `${root}/test_data/${holdout}`;
  return readdirSync(base)
    .filter((n) => !n.startsWith(".") && statSync(`${base}/${n}`).isDirectory())
    .sort()
    .slice(from, to)
    .map((study) => ({
      study,
      files: readdirSync(`${base}/${study}`)
        .filter((n) => !n.startsWith("."))
        .sort()
        .map((f) => `${base}/${study}/${f}`),
    }));
}

/** Frames with their recorded times; above 512 pixels a side, averaged
 * over 2 by 2. */
export function cineFrames(d: Decoded): CineFrame[] {
  let { rows: h, columns: w } = d.header;
  const times = d.header.times_ms;
  if (!times) throw new Error("No frame times");
  let frames: CineFrame[] = d.frames.map((pixels, k) => ({
    pixels,
    width: w,
    height: h,
    time_ms: times[k],
  }));
  while (w > 512) {
    const w2 = w >> 1,
      h2 = h >> 1,
      wid = w;
    frames = frames.map((f) => {
      const out = new Uint8Array(w2 * h2);
      for (let y = 0; y < h2; y++)
        for (let x = 0; x < w2; x++)
          out[y * w2 + x] =
            (f.pixels[2 * y * wid + 2 * x] +
              f.pixels[2 * y * wid + 2 * x + 1] +
              f.pixels[(2 * y + 1) * wid + 2 * x] +
              f.pixels[(2 * y + 1) * wid + 2 * x + 1] +
              2) >>
            2;
      return { ...f, pixels: out, width: w2, height: h2 };
    });
    w = w2;
    h = h2;
  }
  return frames;
}

export const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
