// @vitest-environment node
/** Runs the bone line-up (../boneLineup.ts) on single frames of the prepared
 * DeepFluoro design specimens and scores it against the set's reference: the
 * stored pose with the scan held where the set's poses hold it. The distance
 * from the stored pose as its files give it is kept beside it. Not part of
 * the test suite:
 *   PELVIS_PREPARED=<dir> PELVIS_RESULTS=<dir> PELVIS_SUBJECTS=<set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/pelvisBoneLineup.eval.ts
 * PELVIS_SUBJECTS is `design` (specimens 1 to 3) or design specimen numbers.
 * `held_back` (specimens 4 to 6) is the protocol's one run. Every path must
 * lie outside this repository. The results directory must not exist. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { boneSamples, proposeBoneLineup } from "../boneLineup";
import { camera } from "../carmGeometry";
import { BONE_LINEUP_PROTOCOL, disturbedStart, seeded } from "./lumbarSet";
import { outsideRepository } from "./outsideRepository";
import {
  PELVIS,
  pelvisFrames,
  pelvisInputs,
  pelvisMoving,
  pelvisSubjects,
  pelvisVolume,
  targetErrorMm,
  type PelvisRecord,
} from "./pelvisSet";

const PREPARED = process.env.PELVIS_PREPARED,
  RESULTS = process.env.PELVIS_RESULTS,
  SET = process.env.PELVIS_SUBJECTS;

const bytes = (path: string) => {
  const file = readFileSync(path);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
/** A large file's own bytes, not a copy: the run stays small in memory. */
const whole = (path: string) => {
  const file = readFileSync(path);
  if (file.byteOffset % 2) throw new Error(`Unexpected read: ${path}`);
  return file;
};
const times = (a: number[][], b: number[][]) =>
  a.map((row) =>
    b[0].map((_, j) => row.reduce((sum, value, k) => sum + value * b[k][j], 0)),
  );
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    half = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
};

it.skipIf(!PREPARED || !RESULTS || !SET)(
  "bone line-up on pelvis design specimens",
  () => {
    const prepared = outsideRepository(PREPARED as string),
      results = outsideRepository(RESULTS as string);
    mkdirSync(results, { recursive: false });
    const rows: Record<string, unknown>[] = [];
    for (const name of pelvisSubjects(SET as string)) {
      const record: PelvisRecord = JSON.parse(
          readFileSync(`${prepared}/${name}/subject.json`, "utf8"),
        ),
        marks = new Float32Array(bytes(`${prepared}/${name}/fiducials.f32`));
      // The scan and its labels are held only while the bone is sampled.
      const samples = (() => {
        const held = whole(`${prepared}/${name}/volume.i16`),
          labels = whole(`${prepared}/${name}/labels.u8`);
        return boneSamples({
          ...pelvisVolume(
            record,
            new Int16Array(held.buffer, held.byteOffset, held.length / 2),
          ),
          moving: pelvisMoving(record, labels, labels),
        });
      })();
      const random = seeded(PELVIS.seed);
      for (const key of pelvisFrames(Object.keys(record.frames))) {
        const read = pelvisInputs(
          record,
          marks,
          key,
          new Uint16Array(bytes(`${prepared}/${name}/${key}.u16`)),
        );
        const cam = camera(read.frame.view, read.frame.isocenter),
          axes = [cam.u, cam.v, cam.d];
        const run = (start: number[][]) => {
          const began = performance.now();
          try {
            const found = proposeBoneLineup({
              samples,
              frames: [read.frame],
              start,
            });
            return {
              start_mm: targetErrorMm(read.fiducials, start, read.reference),
              start_across_mm: targetErrorMm(
                read.fiducials,
                start,
                read.reference,
                cam.d,
              ),
              error_mm: targetErrorMm(
                read.fiducials,
                found.matrix,
                read.reference,
              ),
              across_mm: targetErrorMm(
                read.fiducials,
                found.matrix,
                read.reference,
                cam.d,
              ),
              // The same against the stored pose as its files give it.
              stored_error_mm: targetErrorMm(
                read.fiducials,
                found.matrix,
                read.stated,
              ),
              stored_across_mm: targetErrorMm(
                read.fiducials,
                found.matrix,
                read.stated,
                cam.d,
              ),
              // Where the landmarks' middle went: right, up and along the
              // beam, in millimeters.
              offset_mm: axes.map((axis) => {
                let sum = 0;
                for (let k = 0; k < read.fiducials.length; k += 3)
                  for (let r = 0; r < 3; r++)
                    sum +=
                      axis[r] *
                      ((found.matrix[r][0] - read.reference[r][0]) *
                        read.fiducials[k] +
                        (found.matrix[r][1] - read.reference[r][1]) *
                          read.fiducials[k + 1] +
                        (found.matrix[r][2] - read.reference[r][2]) *
                          read.fiducials[k + 2] +
                        found.matrix[r][3] -
                        read.reference[r][3]);
                return sum / (read.fiducials.length / 3);
              }),
              turn_deg: found.rotation_deg,
              score: found.score,
              start_score: found.start_score,
              ms: performance.now() - began,
            };
          } catch (error) {
            return {
              start_mm: targetErrorMm(read.fiducials, start, read.reference),
              refused: String(error),
            };
          }
        };
        const reference = run(read.reference);
        // The C-arm frame's origin is the scan's center under the stored pose.
        const starts = Array.from({ length: PELVIS.starts }, () =>
          run(
            times(
              disturbedStart(random, axes, [0, 0, 0], PELVIS),
              read.reference,
            ),
          ),
        );
        rows.push({
          subject: name,
          frame: key,
          residual_px: read.residual_px,
          // What a check of the reference without the line-up reads.
          stored_pose: read.stated,
          view: read.frame.view,
          isocenter: read.frame.isocenter,
          reference,
          starts,
        });
        writeFileSync(`${results}/runs.json`, JSON.stringify(rows, null, 1));
        const show = (value: unknown) =>
          typeof value === "number" ? value.toFixed(1) : "refused";
        console.log(
          [
            name,
            key,
            "from the reference: score",
            show(reference.start_score && reference.start_score * 100),
            "->",
            show(reference.score && reference.score * 100),
            "across",
            show(reference.across_mm),
            "mm, 3D",
            show(reference.error_mm),
            "| disturbed across:",
            starts.map((s) => show(s.across_mm)).join(" "),
          ].join(" "),
        );
      }
    }
    const all = rows.flatMap((row) =>
        (row.starts as Record<string, number>[]).map((s) => s),
      ),
      done = all.filter((s) => typeof s.across_mm === "number"),
      reference = rows
        .map((row) => row.reference as Record<string, number>)
        .filter((s) => typeof s.across_mm === "number");
    const across = (runs: Record<string, number>[]) => ({
      median_across_mm: median(runs.map((s) => s.across_mm)),
      worst_across_mm: Math.max(...runs.map((s) => s.across_mm)),
      median_3d_mm: median(runs.map((s) => s.error_mm)),
      across_under_half_mm: runs.filter((s) => s.across_mm < 0.5).length,
      across_under_1mm: runs.filter((s) => s.across_mm < 1).length,
      across_under_2mm: runs.filter((s) => s.across_mm < 2).length,
      // Against the stored pose as its files give it.
      stored_median_across_mm: median(runs.map((s) => s.stored_across_mm)),
      stored_across_under_1mm: runs.filter((s) => s.stored_across_mm < 1)
        .length,
    });
    const summary = {
      frames: rows.length,
      grid_offset_voxels: PELVIS.grid_offset_voxels,
      from_reference: {
        ...across(reference),
        median_score: median(reference.map((s) => s.score)),
      },
      disturbed: {
        starts: all.length,
        refused: all.length - done.length,
        median_start_across_mm: median(done.map((s) => s.start_across_mm)),
        ...across(done),
        across_under_5mm: done.filter((s) => s.across_mm < 5).length,
        median_ms: median(done.map((s) => s.ms)),
      },
    };
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          id: SET === "held_back" ? BONE_LINEUP_PROTOCOL : PELVIS.id,
          set: SET,
          summary,
        },
        null,
        1,
      ),
    );
    console.log(JSON.stringify(summary));
  },
  6 * 3600_000,
);
