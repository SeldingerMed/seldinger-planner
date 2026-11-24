// @vitest-environment node
/** The heart's period read from real cines: CardioSYNTAX holdouts (Hugging
 * Face MesserMMP/coronary-angiography-syntax, CC BY 4.0). Not part of the
 * test suite:
 *   CINE_SET=<directory of the set> CINE_PYTHON=<ingest python> \
 *   CINE_SPLIT=design npx vitest run --config vitest.research.config.ts \
 *     src/research/cardiacPeriod.eval.ts
 *
 * There is no ECG in these files, so no period here has a truth. What is
 * measured, per cine:
 * - whether `cine_heart_period_v2` reads a period from the frames and their
 *   recorded times, and the one read by the Step E tracker
 *   (`coronary_tree_tracking_v1` over the stand-in drawn tree), the method
 *   of PR #27, on the same frames;
 * - agreement of the two where both read one;
 * - agreement of the period read on the first and on the second half of
 *   the cine, where each half holds enough beats: a reading the image
 *   repeats on its own, not a truth.
 *
 * Splits, fixed before any run: `design` is the first 15 studies of each
 * holdout in name order (the cines of PR #27); `heldout` is every later
 * study, run once under docs/research/step-e-period-heldout-protocol.md.
 * Per study, the first file of at least 30 frames with recorded times.
 * Each file is decoded to memory; nothing is written. */
import { it } from "vitest";
import { cardiacPeriod, CARDIAC_PERIOD } from "../cardiacPeriod";
import { proposeCoronaryMotion, type CineFrame } from "../coronaryMotion";
import { cineFrames, decode, median, studies, type Decoded } from "./cineSet";
import { drawTree, lineMap, percentile } from "./drawnTree";
import { outsideRepository } from "./outsideRepository";

const SET = process.env.CINE_SET,
  PYTHON = process.env.CINE_PYTHON,
  SPLIT = process.env.CINE_SPLIT;
const MIN_FRAMES = 30;
const RANGES: Record<string, [number, number]> = {
  design: [0, 15],
  heldout: [15, 10_000],
};

function tracked(frames: CineFrame[]): number | null {
  const strength = frames.map((f) => percentile(lineMap(f), 0.995));
  const reference = strength.indexOf(Math.max(...strength));
  const branches = drawTree(frames[reference]);
  try {
    return proposeCoronaryMotion({ frames, reference, branches }).period_ms;
  } catch {
    return null;
  }
}

/** Phase matching on a still overlay: the tree drawn on one quiet frame,
 * scored (mean dark-line strength along it, best over shifts of up to 6
 * pixels for panning, over the frame's own 99.5th percentile of line
 * strength) on the other quiet frames and on every frame at
 * least two frames from a quiet one. A heart in the same phase should hold
 * the still tree better than one in another phase. */
function phaseMatch(frames: CineFrame[], quiet: number[]) {
  if (quiet.length < 2) return null;
  const maps = frames.map((f) => lineMap(f));
  const strength = quiet.map((k) => percentile(maps[k], 0.995));
  const ref = quiet[strength.indexOf(Math.max(...strength))];
  const pts = drawTree(frames[ref]).flatMap((b) => b.points);
  if (pts.length < 5) return null;
  const { width: w, height: h } = frames[0];
  const score = (k: number) => {
    let best = -Infinity;
    for (let dy = -6; dy <= 6; dy += 2)
      for (let dx = -6; dx <= 6; dx += 2) {
        let s = 0,
          n = 0;
        for (const [x, y] of pts) {
          const xx = Math.round(x + dx),
            yy = Math.round(y + dy);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += maps[k][yy * w + xx];
          n++;
        }
        if (n) best = Math.max(best, s / n);
      }
    // Relative to the frame's own strongest lines, so the filling and
    // washing out of contrast does not count as phase.
    return best / Math.max(1e-6, percentile(maps[k], 0.995));
  };
  const same = quiet.filter((k) => k !== ref).map(score);
  const other = frames
    .map((_, k) => k)
    .filter((k) => quiet.every((q) => Math.abs(q - k) >= 2))
    .map(score);
  if (!same.length || !other.length) return null;
  return { same: median(same) as number, other: median(other) as number };
}

const halves = (frames: CineFrame[]) => {
  const n = frames.length >> 1;
  const shift = (f: CineFrame[]) => f.map((x) => ({ ...x, time_ms: x.time_ms - f[0].time_ms }));
  return [shift(frames.slice(0, n)), shift(frames.slice(n))];
};

it.skipIf(!SET || !PYTHON || !SPLIT)(
  "heart period over real cines",
  () => {
    const range = RANGES[SPLIT as string];
    if (!range) throw new Error("CINE_SPLIT is design or heldout");
    const root = outsideRepository(SET as string);
    const rows: Record<string, unknown>[] = [];
    for (const holdout of ["philips_97", "siemens_20"])
      for (const { study, files } of studies(root, holdout, ...range)) {
        let decoded: Decoded | null = null,
          failure: string | null = null,
          skipped_no_times = 0;
        for (const path of files) {
          try {
            const d = decode(PYTHON as string, path);
            if (d.header.frames < MIN_FRAMES) continue;
            if (!d.header.times_ms) {
              skipped_no_times++;
              continue;
            }
            decoded = d;
            break;
          } catch (error) {
            const said = String((error as { stderr?: Buffer }).stderr ?? "").trim();
            failure = (said.split("\n").at(-1) || String(error)).slice(0, 160);
          }
        }
        if (!decoded) {
          rows.push({ holdout, study, status: "no_cine", failure, skipped_no_times });
          console.log(JSON.stringify(rows.at(-1)));
          continue;
        }
        const frames = cineFrames(decoded);
        const began = performance.now();
        const found = cardiacPeriod(frames);
        const ms = performance.now() - began;
        const [a, b] = halves(frames).map((h) => {
          try {
            const r = cardiacPeriod(h);
            return r.status === "read" ? r.period_ms : null;
          } catch {
            return null;
          }
        });
        const track = tracked(frames);
        const phase = found.status === "read" ? phaseMatch(frames, found.quiet_frames) : null;
        const row = {
          holdout,
          study,
          status: found.status,
          reason: found.status === "not_read" ? found.reason : null,
          sha256: decoded.header.sha256.slice(0, 16),
          syntax: decoded.header.transfer_syntax,
          timing: decoded.header.timing,
          frames: frames.length,
          duration_ms: Math.round(frames[frames.length - 1].time_ms - frames[0].time_ms),
          step_ms: Math.round(10 * (frames[1].time_ms - frames[0].time_ms)) / 10,
          period_ms: found.status === "read" ? Math.round(found.period_ms) : null,
          repeat: found.repeat === null ? null : Math.round(1000 * found.repeat) / 1000,
          quiet_frames: found.status === "read" ? found.quiet_frames.length : 0,
          tracker_period_ms: track === null ? null : Math.round(track),
          first_half_ms: a === null ? null : Math.round(a),
          second_half_ms: b === null ? null : Math.round(b),
          same_phase: phase ? Math.round(100 * phase.same) / 100 : null,
          other_phase: phase ? Math.round(100 * phase.other) / 100 : null,
          ms: Math.round(ms),
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    const done = rows.filter((r) => r.status !== "no_cine") as Record<string, any>[];
    const read = done.filter((r) => r.period_ms !== null);
    const both = read.filter((r) => r.tracker_period_ms !== null);
    const halvesBoth = read.filter((r) => r.first_half_ms !== null && r.second_half_ms !== null);
    const rel = (x: number, y: number) => Math.abs(x - y) / ((x + y) / 2);
    console.log(
      JSON.stringify({
        split: SPLIT,
        constants: CARDIAC_PERIOD,
        studies: rows.length,
        cines: done.length,
        no_cine: rows.length - done.length,
        no_cine_failures: rows.filter((r) => r.status === "no_cine").map((r) => r.failure),
        read: read.length,
        not_read_reasons: Object.fromEntries(
          ["too_short", "uneven_times", "no_rhythm"].map((k) => [
            k,
            done.filter((r) => r.reason === k).length,
          ]),
        ),
        tracker_read: done.filter((r) => r.tracker_period_ms !== null).length,
        period_ms_median: median(read.map((r) => r.period_ms)),
        period_ms_range: read.length
          ? [Math.min(...read.map((r) => r.period_ms)), Math.max(...read.map((r) => r.period_ms))]
          : null,
        with_tracker: both.length,
        tracker_within_10pct: both.filter((r) => rel(r.period_ms, r.tracker_period_ms) <= 0.1).length,
        halves_read: halvesBoth.length,
        halves_within_10pct: halvesBoth.filter((r) => rel(r.first_half_ms, r.second_half_ms) <= 0.1)
          .length,
        whole_within_10pct_of_both_halves: halvesBoth.filter(
          (r) => rel(r.period_ms, r.first_half_ms) <= 0.1 && rel(r.period_ms, r.second_half_ms) <= 0.1,
        ).length,
        phase_measured: read.filter((r) => r.same_phase !== null).length,
        same_phase_higher: read.filter((r) => r.same_phase !== null && r.same_phase > r.other_phase)
          .length,
        same_over_other_median: median(
          read.filter((r) => r.same_phase !== null).map((r) => r.same_phase / r.other_phase),
        ),
        by_syntax: Object.fromEntries(
          [...new Set(done.map((r) => r.syntax))].map((s) => [
            s,
            {
              cines: done.filter((r) => r.syntax === s).length,
              read: read.filter((r) => r.syntax === s).length,
            },
          ]),
        ),
      }),
    );
  },
  3_600_000,
);
