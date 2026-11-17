// @vitest-environment node
/** Design probe for the Step C4 score rework, on Ljubljana subjects 01 to 05
 * only. It tries candidate scores built on a continuous vessel-evidence map
 * (no threshold, finer grid) and reports whether each one knows the
 * reference pose and where a plain descent on it ends. A probe, not a
 * method and not an evaluation: see
 * docs/research/ljubljana-reference-diagnostics-results.md.
 *   LJUBLJANA_PREPARED=<dir> LJUBLJANA_DIAGNOSTICS=<dir> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/evidenceProbe.eval.ts */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { camera, viewFrame, type ViewNumbers } from "../carmGeometry";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { orthonormal, rotation } from "../projectionRegistration";
import {
  DIAGNOSTICS_PROTOCOL as D,
  diagnosticDirectory,
} from "./ljubljanaDiagnostics";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
} from "./ljubljanaGeometry";
import { perturbed, protocolStarts } from "./ljubljanaProtocol";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  OUT = process.env.LJUBLJANA_DIAGNOSTICS,
  VARIANTS = (process.env.PROBE_VARIANTS ?? "lin,sqrt,lin+rev,sqrt+rev").split(
    ",",
  );

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const u16 = (path: string) => {
  const b = readFileSync(path);
  return new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2);
};
const f32 = (path: string) => {
  const b = readFileSync(path);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function blur(src: Float32Array, w: number, h: number, sigma: number) {
  const radius = Math.ceil(3 * sigma),
    kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i++)
    total += kernel[i + radius] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const reflect = (i: number, n: number) =>
    i < 0 ? Math.min(n - 1, -i - 1) : i >= n ? Math.max(0, 2 * n - i - 1) : i;
  const pass = new Float32Array(w * h),
    out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += kernel[k + radius] * src[y * w + reflect(x + k, w)];
      pass[y * w + x] = sum;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += kernel[k + radius] * pass[reflect(y + k, h) * w + x];
      out[y * w + x] = sum;
    }
  return out;
}

/** Ridge response of dark lines, largest over scales given in millimeters. */
function ridge(gray: Uint8Array, w: number, h: number, mm: number) {
  const image = Float32Array.from(gray),
    response = new Float32Array(w * h);
  for (const sigma_mm of [0.3, 0.5, 0.8, 1.3, 2]) {
    const sigma = Math.max(0.8, sigma_mm / mm),
      g = blur(image, w, h, sigma),
      margin = Math.ceil(2 * sigma) + 1,
      reach = Math.max(1, Math.round(sigma));
    for (let y = margin; y < h - margin; y++)
      for (let x = margin; x < w - margin; x++) {
        const at = y * w + x,
          gx = (g[at + 1] - g[at - 1]) / 2,
          gy = (g[at + w] - g[at - w]) / 2,
          a = g[at + 1] - 2 * g[at] + g[at - 1],
          c = g[at + w] - 2 * g[at] + g[at - w],
          b =
            (g[at + w + 1] - g[at + w - 1] - g[at - w + 1] + g[at - w - 1]) / 4;
        const half = (a + c) / 2,
          root = Math.hypot((a - c) / 2, b),
          strong = half + root,
          weak = half - root;
        if (!(strong > 0)) continue;
        const ratio = weak / strong;
        if (ratio > 0.5) continue;
        const value =
          sigma * sigma * strong * Math.exp(-2 * ratio * ratio) -
          0.5 * sigma * Math.hypot(gx, gy);
        if (value > response[at]) {
          let ex = b,
            ey = strong - a;
          if (Math.abs(ex) + Math.abs(ey) < 1e-12) {
            ex = strong - c;
            ey = b;
          }
          const n = Math.hypot(ex, ey) || 1,
            step = reach * Math.round(ex / n) + reach * w * Math.round(ey / n);
          if (step === 0 || !(g[at] < g[at + step] && g[at] < g[at - step]))
            continue;
          response[at] = value;
        }
      }
  }
  return response;
}

type PlaneSetup = {
  view: ViewNumbers;
  isocenter: Vec3;
  w: number;
  h: number;
  mm: number;
  /** Evidence blurred to each level of `LEVELS_MM`. */
  levels: Float32Array[];
  /** Strong-evidence samples for the reverse term, working pixel indices. */
  strong: Int32Array;
};
const LEVELS_MM = [4, 2, 1, 0.5, 0.25];

function evidence(
  gray: Uint8Array,
  w: number,
  h: number,
  mm: number,
  gamma: number,
) {
  const r = ridge(gray, w, h, mm),
    sorted = Float32Array.from(r).sort(),
    low = sorted[Math.floor(sorted.length * 0.75)],
    high = sorted[Math.floor(sorted.length * 0.995)],
    e = new Float32Array(w * h);
  if (high > low)
    for (let k = 0; k < e.length; k++) {
      const t = (r[k] - low) / (high - low);
      e[k] = t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(t, gamma);
    }
  const strong: number[] = [];
  for (let k = 0; k < e.length; k++) if (e[k] >= 0.5) strong.push(k);
  const stride = Math.ceil(strong.length / 4000);
  return {
    levels: LEVELS_MM.map((s) => {
      const b = blur(e, w, h, Math.max(0.5, s / mm));
      // Each level is scaled so that a pose on the lines scores near 1.
      const top = Float32Array.from(b).sort()[Math.floor(b.length * 0.995)];
      if (top > 0)
        for (let k = 0; k < b.length; k++) b[k] = Math.min(1, b[k] / top);
      return b;
    }),
    strong: Int32Array.from(strong.filter((_, k) => k % stride === 0)),
  };
}

it.skipIf(!PREPARED || !OUT)(
  "probes candidate scores",
  () => {
    const prepared = outsideRepository(PREPARED!),
      out = outsideRepository(OUT!);
    mkdirSync(out, { recursive: true });
    const starts = protocolStarts();
    const rows: Record<string, unknown>[] = [];
    for (const subject of D.subjects) {
      const dir = diagnosticDirectory(prepared, subject),
        stored = JSON.parse(readFileSync(`${dir}/subject.json`, "utf8"));
      const { points } = medialPoints(
        new Uint8Array(readFileSync(`${dir}/mask.u8`)),
        stored.mask_shape,
        stored.mask_affine,
      );
      const g = referenceGeometry(
        stored.volume_shape,
        stored.volume_affine,
        stored.views.frontal,
        stored.views.lateral,
      );
      const fiducials = storedPoints(f32(`${dir}/fiducials.f32`), g.center);
      const total = points.length / 3;
      const grays = g.planes.map((plane, k) =>
        windowGray(
          u16(`${dir}/${k ? "lateral" : "frontal"}.u16`),
          stored.views[k ? "lateral" : "frontal"],
          plane.window,
        ),
      );
      for (const variant of VARIANTS) {
        const gamma = variant.startsWith("sqrt") ? 0.5 : 1,
          reverse = variant.includes("+rev") ? 0.5 : 0;
        const setups: PlaneSetup[] = g.planes.map((plane, k) => {
          const { width: w, height: h } = plane.frame,
            mm =
              ((plane.view.detector_width_mm / w) *
                plane.view.source_isocenter_mm) /
              plane.view.source_detector_mm;
          return {
            view: plane.view,
            isocenter: plane.isocenter,
            w,
            h,
            mm,
            ...evidence(grays[k], w, h, mm, gamma),
          };
        });
        const frameA = viewFrame(
            setups[0].view.primary_deg,
            setups[0].view.secondary_deg,
          ),
          axes: Vec3[] = [frameA.u, frameA.v, frameA.d];

        /** A search about `start`: cost(p, level, planes) and p to matrix. */
        const search = (start: number[][], used: number[]) => {
          const pivot = [0, 0, 0],
            world = new Float64Array(points.length);
          for (let k = 0; k < total; k++)
            for (let i = 0; i < 3; i++) {
              const v =
                start[i][0] * points[3 * k] +
                start[i][1] * points[3 * k + 1] +
                start[i][2] * points[3 * k + 2] +
                start[i][3];
              world[3 * k + i] = v;
              pivot[i] += v / total;
            }
          const stride = Math.ceil(total / 4000),
            count = Math.ceil(total / stride),
            local = new Float32Array(3 * count);
          for (let k = 0; k < count; k++)
            for (let i = 0; i < 3; i++) {
              const at = 3 * k * stride;
              local[3 * k + i] =
                axes[i][0] * (world[at] - pivot[0]) +
                axes[i][1] * (world[at + 1] - pivot[1]) +
                axes[i][2] * (world[at + 2] - pivot[2]);
            }
          const planes = used.map((index) => {
            const s = setups[index],
              cam = camera(s.view, s.isocenter),
              pa = [cam.u, cam.v, cam.d],
              m = pa.flatMap((axis) => axes.map((a) => dot(axis, a))),
              offset = pa.map((axis) =>
                dot(axis, [
                  pivot[0] - s.isocenter[0],
                  pivot[1] - s.isocenter[1],
                  pivot[2] - s.isocenter[2],
                ]),
              ),
              sid = s.view.source_detector_mm,
              sod = s.view.source_isocenter_mm,
              kx = (sid / s.view.detector_width_mm) * s.w,
              ky = (sid / s.view.detector_height_mm) * s.h,
              cell = Math.max(1, Math.round(1 / s.mm)),
              gw = Math.ceil(s.w / cell),
              gh = Math.ceil(s.h / cell),
              grid = new Uint32Array(gw * gh);
            let stamp = 0;
            return (r: number[], p: number[], level: number) => {
              const map = s.levels[level];
              stamp++;
              let sum = 0,
                inside = 0;
              for (let k = 0; k < count; k++) {
                const x = local[3 * k],
                  y = local[3 * k + 1],
                  z = local[3 * k + 2];
                const ax = r[0] * x + r[1] * y + r[2] * z + p[0],
                  ay = r[3] * x + r[4] * y + r[5] * z + p[1],
                  az = r[6] * x + r[7] * y + r[8] * z + p[2];
                const depth =
                  sod + m[6] * ax + m[7] * ay + m[8] * az + offset[2];
                if (!(depth >= 1) || depth > sid) continue;
                const px =
                    ((m[0] * ax + m[1] * ay + m[2] * az + offset[0]) / depth) *
                      kx +
                    s.w / 2 -
                    0.5,
                  py =
                    s.h / 2 -
                    ((m[3] * ax + m[4] * ay + m[5] * az + offset[1]) / depth) *
                      ky -
                    0.5;
                if (!(px >= 0 && py >= 0 && px <= s.w - 1 && py <= s.h - 1))
                  continue;
                inside++;
                const x0 = Math.min(s.w - 2, Math.floor(px)),
                  y0 = Math.min(s.h - 2, Math.floor(py)),
                  fx = px - x0,
                  fy = py - y0,
                  at = y0 * s.w + x0;
                sum +=
                  map[at] * (1 - fx) * (1 - fy) +
                  map[at + 1] * fx * (1 - fy) +
                  map[at + s.w] * (1 - fx) * fy +
                  map[at + s.w + 1] * fx * fy;
                if (reverse) {
                  const cx = Math.floor(px / cell),
                    cy = Math.floor(py / cell);
                  for (let j = cy > 0 ? cy - 1 : 0; j <= cy + 1 && j < gh; j++)
                    for (
                      let i = cx > 0 ? cx - 1 : 0;
                      i <= cx + 1 && i < gw;
                      i++
                    )
                      grid[j * gw + i] = stamp;
                }
              }
              if (inside < count / 2) return 2;
              let c = 1 - sum / count;
              if (reverse) {
                let uncovered = 0;
                for (const at of s.strong) {
                  const x = at % s.w,
                    y = (at - x) / s.w;
                  if (
                    grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] !==
                    stamp
                  )
                    uncovered++;
                }
                c += (reverse * uncovered) / s.strong.length;
              }
              return c;
            };
          });
          const cost = (p: number[], level: number) => {
            const r = rotation(p[3], p[4], p[5]);
            let sum = 0;
            for (const plane of planes) {
              const c = plane(r, p, level);
              if (c >= 2) return 2;
              sum += c;
            }
            return sum / planes.length;
          };
          const matrix = (p: number[]) => {
            const r = rotation(p[3], p[4], p[5]);
            const turn = [0, 1, 2].map((i) =>
              [0, 1, 2].map((j) => {
                let sum = 0;
                for (let a = 0; a < 3; a++)
                  for (let b = 0; b < 3; b++)
                    sum += axes[a][i] * r[3 * a + b] * axes[b][j];
                return sum;
              }),
            );
            const shift = [0, 1, 2].map(
              (i) => axes[0][i] * p[0] + axes[1][i] * p[1] + axes[2][i] * p[2],
            );
            return orthonormal(
              [0, 1, 2].map((i) => {
                const row = [0, 1, 2].map(
                  (j) =>
                    turn[i][0] * start[0][j] +
                    turn[i][1] * start[1][j] +
                    turn[i][2] * start[2][j],
                );
                const moved =
                  turn[i][0] * (start[0][3] - pivot[0]) +
                  turn[i][1] * (start[1][3] - pivot[1]) +
                  turn[i][2] * (start[2][3] - pivot[2]);
                return [...row, pivot[i] + shift[i] + moved];
              }),
            );
          };
          /** Compass descent through the levels, coarse to fine. */
          const descend = (from: number[], firstLevel: number) => {
            let p = from;
            for (let level = firstLevel; level < LEVELS_MM.length; level++) {
              let step = LEVELS_MM[level],
                best = cost(p, level);
              const stop = LEVELS_MM[level] / 8;
              while (step >= stop) {
                let moved = false;
                for (let i = 0; i < 6; i++)
                  for (const sign of [1, -1]) {
                    const q = p.slice();
                    q[i] += sign * step;
                    const c = cost(q, level);
                    if (c < best - 1e-12) {
                      best = c;
                      p = q;
                      moved = true;
                    }
                  }
                if (!moved) step /= 2;
              }
            }
            return p;
          };
          return { cost, matrix, descend };
        };

        const zero = [0, 0, 0, 0, 0, 0];
        for (const [arm, used] of [
          ["biplane", [0, 1]],
          ["frontal", [0]],
          ["lateral", [1]],
        ] as [string, number[]][]) {
          const atReference = search(g.matrix, used);
          // 1. Does each level's cost have its 1-D minimum at the reference?
          const worst_offset = LEVELS_MM.map((_, level) => {
            let worst = 0;
            for (let i = 0; i < 6; i++) {
              let best = atReference.cost(zero, level),
                where = 0;
              for (const d of [-8, -4, -2, -1, -0.5, 0.5, 1, 2, 4, 8]) {
                const q = zero.slice();
                q[i] = d;
                const c = atReference.cost(q, level);
                if (c < best) {
                  best = c;
                  where = d;
                }
              }
              worst = Math.max(worst, Math.abs(where));
            }
            return worst;
          });
          // 2. Starts ranked against the reference, at the finest level.
          const fine = LEVELS_MM.length - 1,
            reference_cost = atReference.cost(zero, fine);
          const pivot: Vec3 = [0, 0, 0];
          for (let k = 0; k < points.length; k += 3)
            for (let i = 0; i < 3; i++)
              pivot[i] +=
                (g.matrix[i][0] * points[k] +
                  g.matrix[i][1] * points[k + 1] +
                  g.matrix[i][2] * points[k + 2] +
                  g.matrix[i][3]) /
                total;
          const froms = starts[subject - 1].map((by) =>
            perturbed(g.matrix, pivot, by),
          );
          const start_costs = froms.map((from) =>
            search(from, used).cost(zero, fine),
          );
          // 3. Where a descent ends, from the reference and from each start.
          const from_reference = meanTargetError(
            fiducials,
            atReference.matrix(atReference.descend(zero, 2)),
            g.matrix,
          );
          const began = performance.now();
          const errors = froms.map((from) => {
            const s = search(from, used);
            return meanTargetError(
              fiducials,
              s.matrix(s.descend(zero, 0)),
              g.matrix,
            );
          });
          rows.push({
            subject,
            variant,
            arm,
            worst_offset,
            reference_cost,
            starts_worse: start_costs.filter((c) => c > reference_cost).length,
            from_reference_mm: from_reference,
            start_error_mm: froms.map((from) =>
              meanTargetError(fiducials, from, g.matrix),
            ),
            error_mm: errors,
            seconds_per_run: (performance.now() - began) / 1000 / froms.length,
          });
        }
      }
      console.log(`subject ${subject} done`);
    }
    writeFileSync(`${out}/probe.json`, JSON.stringify(rows, null, 1) + "\n");
    const lines: string[] = [];
    for (const variant of VARIANTS)
      for (const arm of ["biplane", "frontal", "lateral"]) {
        const set = rows.filter((r) => r.variant === variant && r.arm === arm),
          errors = set
            .flatMap((r) => r.error_mm as number[])
            .sort((a, b) => a - b),
          refs = set.map((r) => r.from_reference_mm as number);
        const under = (limit: number) => errors.filter((e) => e < limit).length;
        lines.push(
          `${variant.padEnd(9)} ${arm.padEnd(8)} from-ref max ${Math.max(...refs).toFixed(2)} | ` +
            `runs ${errors.length} <1:${under(1)} <2:${under(2)} <5:${under(5)} median ${errors[Math.floor(errors.length / 2)].toFixed(2)} max ${errors[errors.length - 1].toFixed(1)} | ` +
            `starts worse ${set.map((r) => r.starts_worse).join("")} | 1-D worst offset by level ${LEVELS_MM.map((_, l) => Math.max(...set.map((r) => (r.worst_offset as number[])[l]))).join("/")} | ${(set[0].seconds_per_run as number).toFixed(2)} s`,
        );
      }
    console.log(lines.join("\n"));
  },
  60 * 60 * 1000,
);
