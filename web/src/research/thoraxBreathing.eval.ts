// @vitest-environment node
/** Breathing on real landmarks: the thorax interventional set (Zenodo
 * 1400558, CC BY 4.0), subjects T15 to T17, each a CT and a chest X-ray
 * taken apart, with eight bronchial landmarks marked in both.
 *
 * For each subject and each landmark in turn, the other seven fit
 * - rigid: a rigid pose of the CT under a pinhole X-ray camera, and
 * - rigid with breathing: the same, plus the long-axis movement of
 *   ../vesselCorrection.ts (`breathe`), from nothing at the highest fitted
 *   landmark to the whole shift at the lowest,
 * and the left-out landmark's distance from where the fit puts it is the
 * error. Not part of the test suite:
 *   THORAX_SET=<directory of the fetched set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/thoraxBreathing.eval.ts
 *
 * The X-rays carry no source distance, so the camera is a stated
 * assumption: 0.14 mm pixels as stored, source to detector 1800 mm (a
 * standard chest distance), run also at 1500 and 2000 mm. Archives are read
 * through `bsdtar` to memory; nothing is written. Every subject of the set
 * that has an X-ray is read; there is no design and held-back split, and
 * nothing here is tuned on it. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { breathe, CORRECTION } from "../vesselCorrection";
import { outsideRepository } from "./outsideRepository";

const SET = process.env.THORAX_SET;
const SUBJECTS = ["T15", "T16", "T17"];
const PIXEL_MM = 0.14;

const read = (archive: string, member: string) =>
  execFileSync("bsdtar", ["-xOf", archive, member], {
    maxBuffer: 1 << 20,
  }).toString("utf8");
const rows = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).map(Number));

type Pose = number[]; // rotation vector (3), translation (3), shift (0 or 1)

function rotation([a, b, c]: number[]): number[][] {
  const t = Math.hypot(a, b, c);
  if (t < 1e-12)
    return [
      [1, -c, b],
      [c, 1, -a],
      [-b, a, 1],
    ];
  const [x, y, z] = [a / t, b / t, c / t],
    s = Math.sin(t),
    k = 1 - Math.cos(t);
  return [
    [1 + k * (x * x - 1), -s * z + k * x * y, s * y + k * x * z],
    [s * z + k * x * y, 1 + k * (y * y - 1), -s * x + k * y * z],
    [-s * y + k * x * z, s * x + k * y * z, 1 + k * (z * z - 1)],
  ];
}

/** Pixel position of a CT point (RAS mm) under pose `p` and camera `basis`. */
function projectPoint(
  p: Pose,
  basis: number[][],
  f: number,
  center: number[],
  point: number[],
  breathing: { anchor_s: number; full_s: number } | null,
): number[] {
  const q = breathing ? breathe(point, p[6], breathing) : point;
  const r = rotation(p.slice(0, 3));
  const w = [0, 1, 2].map(
    (i) => r[i][0] * q[0] + r[i][1] * q[1] + r[i][2] * q[2],
  );
  // Camera axes: columns, rows, beam.
  const c = basis.map(
    (axis, i) => axis.reduce((s, v, j) => s + v * w[j], 0) + p[3 + i],
  );
  return [center[0] + (f * c[0]) / c[2], center[1] + (f * c[1]) / c[2]];
}

/** Levenberg-Marquardt on pixel residuals, numeric Jacobian. */
function fit(
  start: Pose,
  residual: (p: Pose) => number[],
  iterations = 200,
): Pose {
  let p = [...start],
    r = residual(p),
    cost = r.reduce((s, v) => s + v * v, 0),
    lambda = 1e-3;
  for (let it = 0; it < iterations; it++) {
    const n = p.length,
      J = r.map(() => new Array(n).fill(0));
    for (let k = 0; k < n; k++) {
      const h = k < 3 ? 1e-6 : 1e-4,
        q = [...p];
      q[k] += h;
      const rq = residual(q);
      for (let i = 0; i < r.length; i++) J[i][k] = (rq[i] - r[i]) / h;
    }
    const A = Array.from({ length: n }, (_, a) =>
        Array.from({ length: n }, (_, b) =>
          J.reduce((s, row) => s + row[a] * row[b], 0),
        ),
      ),
      g = Array.from({ length: n }, (_, a) =>
        J.reduce((s, row, i) => s + row[a] * r[i], 0),
      );
    let improved = false;
    for (let tries = 0; tries < 20 && !improved; tries++) {
      const M = A.map((row, a) =>
        row.map((v, b) => v + (a === b ? lambda * (v + 1e-9) : 0)),
      );
      const step = solve(
        M,
        g.map((v) => -v),
      );
      if (!step) {
        lambda *= 10;
        continue;
      }
      const q = p.map((v, k) => v + step[k]),
        rq = residual(q),
        c = rq.reduce((s, v) => s + v * v, 0);
      if (Number.isFinite(c) && c < cost) {
        p = q;
        r = rq;
        if (cost - c < 1e-10 * cost) it = iterations;
        cost = c;
        lambda = Math.max(1e-9, lambda / 3);
        improved = true;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  return p;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length,
    M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-14) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const k = M[r][c] / M[c][c];
        for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
      }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Two right-handed cameras that give a radiograph either way round: beam
// toward the front with columns toward the patient's right, or beam toward
// the back with columns toward the left. Rows run toward the feet.
const CAMERAS = {
  beam_anterior: [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0],
  ],
  beam_posterior: [
    [-1, 0, 0],
    [0, 0, -1],
    [0, -1, 0],
  ],
};

function run(
  ct: number[][],
  xray: number[][],
  basis: number[][],
  sid: number,
  center: number[],
  breathing: boolean,
) {
  const f = sid / PIXEL_MM;
  const centroid = [0, 1, 2].map(
    (i) => ct.reduce((s, p) => s + p[i], 0) / ct.length,
  );
  const errors: number[] = [];
  let shifts: number[] = [];
  let inSampleRmsPx = 0;
  for (let out = -1; out < ct.length; out++) {
    const keep = ct.map((_, i) => i).filter((i) => i !== out);
    const zs = keep.map((i) => ct[i][2]);
    const ramp = breathing
      ? { anchor_s: Math.max(...zs), full_s: Math.min(...zs) }
      : null;
    // Start: the landmarks' centroid on the central ray, 0.9 of the way to
    // the detector, as for a chest against it.
    const start: Pose = [0, 0, 0];
    const at = basis.map(
      (axis) => -axis.reduce((s, v, j) => s + v * centroid[j], 0),
    );
    start.push(at[0], at[1], at[2] + 0.9 * sid);
    if (breathing) start.push(0);
    const residual = (p: Pose) =>
      keep.flatMap((i) => {
        const [u, v] = projectPoint(p, basis, f, center, ct[i], ramp);
        return [u - xray[i][0], v - xray[i][1]];
      });
    const p = fit(start, residual);
    if (out < 0) {
      const r = residual(p);
      inSampleRmsPx = Math.sqrt(
        r.reduce((s, x) => s + x * x, 0) / (r.length / 2),
      );
      continue;
    }
    const [u, v] = projectPoint(p, basis, f, center, ct[out], ramp);
    errors.push(Math.hypot(u - xray[out][0], v - xray[out][1]) * PIXEL_MM);
    if (breathing) shifts.push(p[6]);
  }
  return { errors, shifts, inSampleRmsPx };
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

it.skipIf(!SET)(
  "breathing against rigid on thorax landmarks",
  () => {
    const root = outsideRepository(SET as string);
    const source = JSON.parse(readFileSync(`${root}/SOURCE.json`, "utf8"));
    const landmarks = `${root}/Landmarks.rar`,
      images = `${root}/Images.rar`;
    const recorded = source.files.find(
      (f: { name: string }) => f.name === "Landmarks.rar",
    ).md5;
    const md5 = createHash("md5").update(readFileSync(landmarks)).digest("hex");
    if (md5 !== recorded) throw new Error("Landmarks archive changed");
    const subjects = SUBJECTS.map((name) => {
      const header = read(images, `Images/Part2/3D CT/ITK Format/${name}.mhd`);
      const spacing = (
        /ElementSpacing = ([^\r\n]+)/.exec(header) as string[]
      )[1]
        .trim()
        .split(/\s+/)
        .map(Number);
      // Voxel indices: right to left, front to back, foot to head.
      const ct = rows(
        read(landmarks, `Landmarks/LandmarksIn3DAnd2D/3D_CT/${name}.txt`),
      ).map(([i, j, k]) => [-i * spacing[0], -j * spacing[1], k * spacing[2]]);
      const xray = rows(
        read(landmarks, `Landmarks/LandmarksIn3DAnd2D/2D Xray/${name}.txt`),
      );
      if (ct.length !== 8 || xray.length !== 8)
        throw new Error(`${name}: eight landmarks expected`);
      return { name, ct, xray };
    });
    // The image center from the stored size of each X-ray.
    const sizes: Record<string, number[]> = {
      T15: [3037, 2673],
      T16: [3039, 2527],
      T17: [3039, 2527],
    };
    // Which camera: the one the rigid fit of all eight landmarks prefers,
    // over the three subjects together, at 1800 mm.
    const whole = (basis: number[][]) =>
      subjects.reduce((sum, s) => {
        const center = sizes[s.name].map((n) => n / 2);
        const r = run(s.ct, s.xray, basis, 1800, center, false);
        return sum + r.errors.reduce((a, b) => a + b, 0);
      }, 0);
    const camera =
      whole(CAMERAS.beam_anterior) <= whole(CAMERAS.beam_posterior)
        ? "beam_anterior"
        : "beam_posterior";
    const summary: Record<string, unknown>[] = [];
    for (const sid of [1800, 1500, 2000]) {
      const all = { rigid: [] as number[], breathing: [] as number[] };
      const perSubject: Record<string, unknown>[] = [];
      for (const s of subjects) {
        const center = sizes[s.name].map((n) => n / 2);
        const rigid = run(s.ct, s.xray, CAMERAS[camera], sid, center, false);
        const moved = run(s.ct, s.xray, CAMERAS[camera], sid, center, true);
        all.rigid.push(...rigid.errors);
        all.breathing.push(...moved.errors);
        perSubject.push({
          subject: s.name,
          rigid_median_mm: +median(rigid.errors).toFixed(2),
          breathing_median_mm: +median(moved.errors).toFixed(2),
          breathing_better: moved.errors.filter((e, i) => e < rigid.errors[i])
            .length,
          fitted_shift_mm_median: +median(moved.shifts).toFixed(1),
          // What the planner's guard would do with all eight marked: propose
          // the breathing term only if it brings the marks in by a fifth and
          // by a pixel of the frame.
          all_eight_rigid_rms_px: +rigid.inSampleRmsPx.toFixed(1),
          all_eight_breathing_rms_px: +moved.inSampleRmsPx.toFixed(1),
          guard_would_propose:
            rigid.inSampleRmsPx - moved.inSampleRmsPx >=
              CORRECTION.min_gain * rigid.inSampleRmsPx &&
            rigid.inSampleRmsPx - moved.inSampleRmsPx >= CORRECTION.min_gain_px,
        });
      }
      summary.push({
        source_detector_mm: sid,
        camera,
        landmarks: all.rigid.length,
        rigid_median_mm: +median(all.rigid).toFixed(2),
        rigid_max_mm: +Math.max(...all.rigid).toFixed(2),
        breathing_median_mm: +median(all.breathing).toFixed(2),
        breathing_max_mm: +Math.max(...all.breathing).toFixed(2),
        breathing_better: all.breathing.filter((e, i) => e < all.rigid[i])
          .length,
        subjects: perSubject,
      });
    }
    console.log("SUMMARY " + JSON.stringify(summary, null, 1));
  },
  1800_000,
);
