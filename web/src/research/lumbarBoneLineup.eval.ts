// @vitest-environment node
/** Runs the bone line-up (../boneLineup.ts) on prepared C-ArmLSpine cases,
 * with both frames and with the front frame alone. Not part of the test
 * suite:
 *   LUMBAR_PREPARED=<dir> LUMBAR_RESULTS=<dir> LUMBAR_CASES=<set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/lumbarBoneLineup.eval.ts
 * LUMBAR_CASES is `design` (cases 1 to 49) or design case numbers, as in
 * `1,2,3`. `held_back` (cases 50 to 149) is the protocol's one run. A case
 * the format step left out (`left-out.json`) is not run. Every path must
 * lie outside this repository. The results directory must not exist. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  boneSamples,
  proposeBoneLineup,
  type BoneFrameInput,
  type BoneLineupProposal,
} from "../boneLineup";
import { camera } from "../carmGeometry";
import {
  apartMm,
  BONE_LINEUP_PROTOCOL,
  disturbedStart,
  LUMBAR,
  lumbarCases,
  lumbarInputs,
  seeded,
} from "./lumbarSet";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LUMBAR_PREPARED,
  RESULTS = process.env.LUMBAR_RESULTS,
  SET = process.env.LUMBAR_CASES;
const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
// The side frame alone is not an arm: it brought 116 of 294 disturbed starts
// back on the design cases, and the line-up refuses it.
const ARMS = [
  ["both", [0, 1]],
  ["front", [0]],
] as const;

const bytes = (path: string) => {
  const file = readFileSync(path);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    half = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
};

it.skipIf(!PREPARED || !RESULTS || !SET)(
  "bone line-up on lumbar cases",
  () => {
    const prepared = outsideRepository(PREPARED as string),
      results = outsideRepository(RESULTS as string);
    mkdirSync(results, { recursive: false });
    const left_out: string[] = existsSync(`${prepared}/left-out.json`)
      ? JSON.parse(readFileSync(`${prepared}/left-out.json`, "utf8"))
      : [];
    const rows: Record<string, unknown>[] = [];
    for (const name of lumbarCases(SET as string)) {
      if (left_out.includes(name)) continue;
      const record = JSON.parse(
        readFileSync(`${prepared}/${name}/subject.json`, "utf8"),
      );
      const keys = Object.keys(record.frames).sort();
      const read = lumbarInputs(
        record,
        new Int16Array(bytes(`${prepared}/${name}/volume.i16`)),
        keys.map(
          (key) => new Uint16Array(bytes(`${prepared}/${name}/${key}.u16`)),
        ),
      );
      const samples = boneSamples(read.volume);
      for (const [arm, which] of ARMS) {
        const frames: BoneFrameInput[] = which.map((k) => read.frames[k]),
          cam = camera(frames[0].view, frames[0].isocenter),
          axes = [cam.u, cam.v, cam.d],
          // One frame cannot place the bone along its own beam.
          beam = which.length === 1 ? cam.d : undefined;
        const run = (start: number[][]): [BoneLineupProposal, number] => {
          const began = performance.now();
          return [
            proposeBoneLineup({ samples, frames, start }),
            performance.now() - began,
          ];
        };
        // A case the line-up refuses from the stated geometry has no answer
        // of its own: it is recorded, and none of its starts count as back.
        let first: [BoneLineupProposal, number];
        try {
          first = run(IDENTITY);
        } catch (error) {
          rows.push({
            case: name,
            arm,
            refused: String(error),
            back_1mm: 0,
            back_2mm: 0,
          });
          writeFileSync(`${results}/runs.json`, JSON.stringify(rows, null, 1));
          console.log([name, arm, "refused:", String(error)].join(" "));
          continue;
        }
        const [stated, stated_ms] = first;
        const random = seeded(LUMBAR.seed);
        const starts = Array.from({ length: LUMBAR.starts }, () => {
          const start = disturbedStart(random, axes, read.center);
          try {
            const [found, ms] = run(start);
            return {
              start_mm: apartMm(start, IDENTITY, read.center),
              back_mm: apartMm(found.matrix, stated.matrix, read.center),
              back_across_mm: apartMm(
                found.matrix,
                stated.matrix,
                read.center,
                cam.d,
              ),
              score: found.score,
              ms,
            };
          } catch (error) {
            return {
              start_mm: apartMm(start, IDENTITY, read.center),
              refused: String(error),
            };
          }
        });
        const near = (key: "back_mm" | "back_across_mm", limit: number) =>
          starts.filter(
            (s) => typeof s[key] === "number" && (s[key] as number) < limit,
          ).length;
        const row = {
          case: name,
          arm,
          points: samples.weights.length,
          score: stated.score,
          frame_scores: stated.frame_scores,
          start_score: stated.start_score,
          from_stated_mm: apartMm(stated.matrix, IDENTITY, read.center, beam),
          from_stated_turn_deg: stated.rotation_deg,
          matrix: stated.matrix,
          depth_candidates_mm: stated.depth_candidates_mm,
          evaluations: stated.evaluations,
          ms: stated_ms,
          starts,
          back_1mm: near(beam ? "back_across_mm" : "back_mm", 1),
          back_2mm: near(beam ? "back_across_mm" : "back_mm", 2),
        };
        rows.push(row);
        writeFileSync(`${results}/runs.json`, JSON.stringify(rows, null, 1));
        console.log(
          [
            name,
            arm,
            "score",
            row.score.toFixed(3),
            "from stated",
            row.from_stated_mm.toFixed(2),
            "mm",
            row.from_stated_turn_deg.toFixed(2),
            "deg",
            "| back <1mm",
            row.back_1mm,
            "<2mm",
            row.back_2mm,
            "of",
            LUMBAR.starts,
            "|",
            Math.round(stated_ms),
            "ms",
          ].join(" "),
        );
      }
    }
    const summary = ARMS.map(([arm]) => {
      const every = rows.filter((row) => row.arm === arm) as {
          back_1mm: number;
          back_2mm: number;
          from_stated_mm: number;
          score: number;
          ms: number;
          case: string;
          refused?: string;
        }[],
        mine = every.filter((row) => row.refused === undefined);
      return {
        arm,
        cases: every.length,
        refused: every
          .filter((row) => row.refused !== undefined)
          .map((row) => [row.case, row.refused]),
        starts: every.length * LUMBAR.starts,
        back_1mm: mine.reduce((sum, row) => sum + row.back_1mm, 0),
        back_2mm: mine.reduce((sum, row) => sum + row.back_2mm, 0),
        cases_with_every_start_back_1mm: mine.filter(
          (row) => row.back_1mm === LUMBAR.starts,
        ).length,
        median_from_stated_mm: median(mine.map((row) => row.from_stated_mm)),
        within_3mm_of_stated: mine.filter((row) => row.from_stated_mm < 3)
          .length,
        farther: mine
          .filter((row) => row.from_stated_mm >= 3)
          .map((row) => [row.case, Number(row.from_stated_mm.toFixed(1))]),
        median_score: median(mine.map((row) => row.score)),
        median_ms: median(mine.map((row) => row.ms)),
      };
    });
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          id: SET === "held_back" ? BONE_LINEUP_PROTOCOL : LUMBAR.id,
          set: SET,
          left_out: lumbarCases(SET as string).filter((name) =>
            left_out.includes(name),
          ),
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
