// @vitest-environment node
/** Runs the reference-pose diagnostics as written in
 * docs/research/ljubljana-reference-diagnostics-protocol.md. Not part of the
 * test suite: run it with
 *   LJUBLJANA_PREPARED=<dir> LJUBLJANA_DIAGNOSTICS=<dir> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaDiagnostics.eval.ts
 * Both directories must lie outside this repository. Per-frame detail and
 * pictures are written only to LJUBLJANA_DIAGNOSTICS. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { vesselTarget, type VesselTarget } from "../vesselness2d";
import { projectRegistered } from "../projectionRegistration";
import {
  DIAGNOSTICS_PROTOCOL as D,
  backward,
  darkestShift,
  diagnosticDirectory,
  forward,
  framePixels,
  levels,
  overlay,
  percentiles,
  png,
  stretched,
} from "./ljubljanaDiagnostics";
import { referenceGeometry, windowGray } from "./ljubljanaGeometry";
import { perturbed, protocolStarts, quantile } from "./ljubljanaProtocol";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  OUT = process.env.LJUBLJANA_DIAGNOSTICS;

const u16 = (path: string) => {
  const bytes = readFileSync(path);
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
};
const applied = (m: number[][], x: ArrayLike<number>, k: number): Vec3 =>
  [0, 1, 2].map(
    (i) => m[i][0] * x[k] + m[i][1] * x[k + 1] + m[i][2] * x[k + 2] + m[i][3],
  ) as Vec3;

it.skipIf(!PREPARED || !OUT)(
  "runs the committed diagnostics",
  () => {
    const prepared = outsideRepository(PREPARED!),
      out = outsideRepository(OUT!);
    mkdirSync(out, { recursive: true });
    const starts = protocolStarts();
    const frames: Record<string, unknown>[] = [];
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
      const pivot: Vec3 = [0, 0, 0];
      for (let k = 0; k < points.length; k += 3) {
        const x = applied(g.matrix, points, k);
        for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
      }
      g.planes.forEach((plane, k) => {
        const name = k ? "lateral" : "frontal",
          { width, height } = plane.frame,
          stored16 = u16(`${dir}/${name}.u16`),
          raw = framePixels(stored16, stored.views[name], plane.window),
          mm =
            ((plane.view.detector_width_mm / width) *
              plane.view.source_isocenter_mm) /
            plane.view.source_detector_mm;
        const at = (matrix: number[][]) =>
          projectRegistered(
            plane.view,
            plane.isocenter,
            matrix,
            points,
            plane.frame,
          );
        const reference = at(g.matrix),
          perturbedStarts = starts[subject - 1].map((by) =>
            at(perturbed(g.matrix, pivot, by)),
          );
        const display = stretched(raw);
        const inputs: [string, Uint8Array, number][] = [
          [
            "protocol",
            windowGray(stored16, stored.views[name], plane.window),
            0.5,
          ],
          ["stretched", display, 0.5],
          ["stretched_sensitive", display, 0.9],
        ];
        const record: Record<string, unknown> = {
          subject,
          plane: name,
          frame: `${width}x${height}`,
          mm_per_frame_px: mm,
          points: points.length / 3,
          percentiles_16bit: percentiles(raw, [0.01, 0.5, 0.99]),
          levels_after_high_byte: levels(inputs[0][1]),
          darkest_shift_mm: darkestShift(raw, width, height, reference, mm),
        };
        for (const [variant, gray, sensitivity] of inputs) {
          let target: VesselTarget;
          try {
            target = vesselTarget(gray, width, height, D.polarity, sensitivity);
          } catch (error) {
            record[variant] = { failure: String((error as Error).message) };
            continue;
          }
          const score = (pixels: Float32Array, dx = 0, dy = 0) => {
            const f = forward(target, pixels, width, height, mm, dx, dy),
              b = backward(target, pixels, width, height, mm, dx, dy);
            return { ...f, ...b, both: f.forward_mm + b.backward_mm };
          };
          const here = score(reference),
            away = perturbedStarts.map((pixels) => score(pixels));
          let betterShift = 0,
            bestShift = { mm: 0, both: here.both };
          for (const reach of D.shifts_mm)
            for (let turn = 0; turn < 8; turn++) {
              const angle = (turn * Math.PI) / 4,
                shifted = score(
                  reference,
                  (reach * Math.cos(angle)) / mm,
                  (reach * Math.sin(angle)) / mm,
                );
              if (shifted.both < here.both) betterShift++;
              if (shifted.both < bestShift.both)
                bestShift = { mm: reach, both: shifted.both };
            }
          record[variant] = {
            centerline_px: target.centerline.length,
            centerline_mm: target.centerline.length * target.scale * mm,
            at_reference: here,
            starts_worse_forward: away.filter(
              (s) => s.forward_mm > here.forward_mm,
            ).length,
            starts_worse_backward: away.filter(
              (s) => s.backward_mm > here.backward_mm,
            ).length,
            starts_worse_both: away.filter((s) => s.both > here.both).length,
            shifted_poses_better: betterShift,
            best_shift_mm: bestShift.mm,
          };
          writeFileSync(
            `${out}/s${subject}-${name}-${variant}.png`,
            png(overlay(display, width, height, target, reference)),
          );
        }
        frames.push(record);
      });
      console.log(`subject ${subject} done`);
    }
    writeFileSync(`${out}/detail.json`, JSON.stringify(frames, null, 1) + "\n");
    // Aggregates over the frames: least, median and most of each number.
    const spread = (values: number[]) => {
      const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
      return {
        n: sorted.length,
        least: sorted[0],
        median: quantile(sorted, 0.5),
        most: sorted[sorted.length - 1],
      };
    };
    const pick = (path: string[]) =>
      frames.map((frame) => {
        let value: unknown = frame;
        for (const key of path)
          value = (value as Record<string, unknown> | undefined)?.[key];
        return value as number;
      });
    const summary: Record<string, unknown> = {
      protocol: D.id,
      frames: frames.length,
      levels_after_high_byte: spread(pick(["levels_after_high_byte"])),
      darkest_shift_mm: spread(pick(["darkest_shift_mm"])),
      points: spread(pick(["points"])),
    };
    for (const variant of ["protocol", "stretched", "stretched_sensitive"]) {
      const of = (...path: string[]) => spread(pick([variant, ...path]));
      summary[variant] = {
        centerline_mm: of("centerline_mm"),
        forward_matched: of("at_reference", "forward_matched"),
        backward_matched: of("at_reference", "backward_matched"),
        forward_mm: of("at_reference", "forward_mm"),
        backward_mm: of("at_reference", "backward_mm"),
        starts_worse_forward: of("starts_worse_forward"),
        starts_worse_backward: of("starts_worse_backward"),
        starts_worse_both: of("starts_worse_both"),
        shifted_poses_better: of("shifted_poses_better"),
        best_shift_mm: of("best_shift_mm"),
      };
    }
    writeFileSync(
      `${out}/summary.json`,
      JSON.stringify(summary, null, 1) + "\n",
    );
    console.log(JSON.stringify(summary, null, 1));
  },
  60 * 60 * 1000,
);
