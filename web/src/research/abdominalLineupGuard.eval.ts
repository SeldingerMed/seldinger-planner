// @vitest-environment node
/** The guarded line-up (../abdominalLineup.ts) on prepared C-ArmLSpine
 * design cases, from the stated geometry. Not part of the test suite:
 *   LUMBAR_PREPARED=<dir> LUMBAR_CASES=<design case numbers or design> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/abdominalLineupGuard.eval.ts
 *
 * Three second frames per case:
 * - `own`: the case's own side frame. The guard should keep it.
 * - `other`: the side frame of the next design case, another patient. The
 *   guard should not let it move the front frame's answer.
 * - `flat`: the side frame with its bone smoothed away. Same.
 *
 * Design cases only (1 to 49); the held-back cases were read once under
 * bone-lineup-held-back-v1 and are not read here. Nothing is written: the
 * per-case lines and the summary go to standard output. */
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { fromFrontDeg, proposeAbdominalLineup } from "../abdominalLineup";
import {
  boneSamples,
  proposeBoneLineup,
  type BoneFrameInput,
} from "../boneLineup";
import { camera } from "../carmGeometry";
import { apartMm, lumbarCases, lumbarInputs } from "./lumbarSet";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LUMBAR_PREPARED,
  SET = process.env.LUMBAR_CASES;
const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const bytes = (path: string) => {
  const file = readFileSync(path);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
};

function read(prepared: string, name: string) {
  const record = JSON.parse(
    readFileSync(`${prepared}/${name}/subject.json`, "utf8"),
  );
  const keys = Object.keys(record.frames).sort();
  return lumbarInputs(
    record,
    new Int16Array(bytes(`${prepared}/${name}/volume.i16`)),
    keys.map((key) => new Uint16Array(bytes(`${prepared}/${name}/${key}.u16`))),
  );
}

/** A box blur wide enough to take vertebrae out of a frame and leave its
 * slow shading. */
function flatten(frame: BoneFrameInput, radius = 60): BoneFrameInput {
  const { width: w, height: h } = frame,
    src = Float64Array.from(frame.pixels),
    row = new Float64Array(w * h),
    out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0,
        n = 0;
      for (
        let k = Math.max(0, x - radius);
        k <= Math.min(w - 1, x + radius);
        k++
      ) {
        sum += src[y * w + k];
        n++;
      }
      row[y * w + x] = sum / n;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0,
        n = 0;
      for (
        let k = Math.max(0, y - radius);
        k <= Math.min(h - 1, y + radius);
        k++
      ) {
        sum += row[k * w + x];
        n++;
      }
      out[y * w + x] = Math.round(sum / n);
    }
  return { ...frame, pixels: out };
}

it.skipIf(!PREPARED || !SET)(
  "guarded line-up on lumbar design cases",
  () => {
    const prepared = outsideRepository(PREPARED as string);
    const names = lumbarCases(SET as string);
    if (names.some((name) => Number(name.slice(4)) > 49))
      throw new Error("Design cases only");
    const rows: Record<string, unknown>[] = [];
    for (const [i, name] of names.entries()) {
      const own = read(prepared, name);
      const otherName = names[(i + 1) % names.length];
      const other = otherName === name ? null : read(prepared, otherName);
      const samples = boneSamples(own.volume);
      // The frame nearer the front, as the guard reads it.
      const [front, side] =
        fromFrontDeg(own.frames[1], IDENTITY) <
        fromFrontDeg(own.frames[0], IDENTITY)
          ? [own.frames[1], own.frames[0]]
          : own.frames;
      const beam = camera(front.view, front.isocenter).d;
      const alone = proposeBoneLineup({
        samples,
        frames: [front],
        start: IDENTITY,
      });
      const seconds: [string, BoneFrameInput][] = [["own", side]];
      if (other)
        seconds.push([
          "other",
          // The other patient's frame, in this case's geometry.
          { ...other.frames[1], view: side.view, isocenter: side.isocenter },
        ]);
      seconds.push(["flat", flatten(side)]);
      // The case's own two-frame answer: what a wrong second frame's depth
      // is measured against.
      let ownBoth: number[][] | null = null;
      for (const [kind, second] of seconds) {
        const began = performance.now();
        let found;
        try {
          found = proposeAbdominalLineup({
            samples,
            frames: [front, second],
            start: IDENTITY,
          });
        } catch (error) {
          const row = { case: name, second: kind, error: String(error) };
          rows.push(row);
          console.log(JSON.stringify(row));
          continue;
        }
        const both = found.both;
        if (kind === "own") ownBoth = both?.matrix ?? null;
        const from_own = (m: number[][] | null | undefined) =>
          m && ownBoth ? apartMm(m, ownBoth, own.center) : null;
        const row = {
          case: name,
          second: kind,
          kept: found.second_view.status === "not_given",
          reason:
            found.second_view.status === "set_aside"
              ? found.second_view.reason
              : null,
          frame_scores_both: both?.frame_scores ?? null,
          single_score: alone.score,
          // How far the unguarded two-frame answer moved the front frame's
          // answer across its beam, and how far the kept answer did.
          unguarded_across_mm: both
            ? apartMm(both.matrix, alone.matrix, own.center, beam)
            : null,
          kept_across_mm: apartMm(found.matrix, alone.matrix, own.center, beam),
          // In 3D from the case's own two-frame answer; for a kept answer
          // only, since a single-frame answer claims no depth.
          unguarded_3d_from_own_mm: from_own(both?.matrix),
          kept_3d_from_own_mm:
            found.depth === "two_views" ? from_own(found.matrix) : null,
          ms: Math.round(performance.now() - began),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
    const by = (kind: string) => rows.filter((row) => row.second === kind);
    const summary = ["own", "other", "flat"].map((kind) => {
      const failed = by(kind).filter((row) => "error" in row).length;
      const mine = by(kind).filter((row) => !("error" in row)) as {
        kept: boolean;
        reason: string | null;
        unguarded_across_mm: number | null;
        kept_across_mm: number;
        unguarded_3d_from_own_mm: number | null;
        kept_3d_from_own_mm: number | null;
      }[];
      const over = (
        key: "unguarded_3d_from_own_mm" | "kept_3d_from_own_mm",
        limit: number,
      ) =>
        mine.filter((row) => row[key] !== null && (row[key] as number) > limit)
          .length;
      const moved = (limit: number) =>
        mine.filter(
          (row) =>
            row.unguarded_across_mm !== null && row.unguarded_across_mm > limit,
        ).length;
      return {
        second: kind,
        cases: mine.length,
        failed,
        kept: mine.filter((row) => row.kept).length,
        set_aside_bone_not_held: mine.filter(
          (row) => row.reason === "bone_not_held",
        ).length,
        set_aside_moved_first_frame: mine.filter(
          (row) => row.reason === "moved_first_frame",
        ).length,
        unguarded_moved_over_2mm: moved(2),
        unguarded_moved_over_5mm: moved(5),
        answer_moved_over_2mm: mine.filter((row) => row.kept_across_mm > 2)
          .length,
        answer_moved_over_5mm: mine.filter((row) => row.kept_across_mm > 5)
          .length,
        unguarded_3d_off_own_over_5mm: over("unguarded_3d_from_own_mm", 5),
        kept_two_view_3d_off_own_over_5mm: over("kept_3d_from_own_mm", 5),
      };
    });
    console.log("SUMMARY " + JSON.stringify(summary));
  },
  6 * 3600_000,
);
