// @vitest-environment node
/** The coronary tree over real cines: CardioSYNTAX holdouts (Hugging Face
 * MesserMMP/coronary-angiography-syntax, CC BY 4.0), native DICOM cine from
 * Philips and Siemens systems. Not part of the test suite:
 *   CINE_SET=<directory of the fetched set> CINE_PYTHON=<ingest python> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/coronaryCine.eval.ts
 *
 * There is no CT of these patients and no marked truth, so nothing here is
 * paired with a CT and no distance to a truth is claimed. What is measured,
 * per cine, with the tracking constants as set on the synthetic cine:
 * - how many frames the tree is followed in, and how many are refused;
 * - the image evidence under the tree: how much darker the frame is on the
 *   tree's points than around them (`vesselEvidence`), for the tree left
 *   where it was drawn and for the moving tree, on the frames followed;
 * - the heart's period read from the frames' recorded times;
 * - refusal: the frame next to the reference replaced by a frame of the
 *   cine before (another patient), which should be refused.
 *
 * The image evidence is not independent of the tracking, which seeks the
 * drawn tree's pictures: it shows the moving tree lies on dark vessel where
 * the still one does not, not that it lies on the right vessel.
 *
 * The drawn tree stands in for the operator's: on the frame with the
 * strongest dark lines, the strongest line points at least 8 pixels apart,
 * chained into branches. That choice is fixed here and not tuned.
 *
 * Cines: per study in name order, the first file of at least 30 frames;
 * the first 15 studies of each holdout. Each file is decoded to memory by
 * scripts/research/decode_cine.py; nothing is written. */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { it } from "vitest";
import {
  proposeCoronaryMotion,
  vesselEvidence,
  type CineFrame,
  type TreeBranch,
} from "../coronaryMotion";
import { drawTree, lineMap, percentile } from "./drawnTree";
import { outsideRepository } from "./outsideRepository";

const SET = process.env.CINE_SET,
  PYTHON = process.env.CINE_PYTHON;
const PER_HOLDOUT = Number(process.env.CINE_PER_HOLDOUT ?? 15),
  MIN_FRAMES = 30,
  SCRIPT = new URL("../../../scripts/research/decode_cine.py", import.meta.url)
    .pathname;

type Decoded = {
  header: {
    frames: number;
    rows: number;
    columns: number;
    times_ms: number[] | null;
    timing: string | null;
    manufacturer: string;
    sha256: string;
  };
  frames: Uint8Array[];
};

function decode(path: string): Decoded {
  const out = execFileSync(PYTHON as string, ["-W", "ignore", SCRIPT, path], {
    maxBuffer: 1 << 30,
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

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function pick(root: string, holdout: string): string[] {
  const base = `${root}/test_data/${holdout}`;
  const studies = readdirSync(base)
    .filter((n) => !n.startsWith(".") && statSync(`${base}/${n}`).isDirectory())
    .sort()
    .slice(0, PER_HOLDOUT);
  return studies.map((study) => {
    const files = readdirSync(`${base}/${study}`)
      .filter((n) => !n.startsWith("."))
      .sort();
    return files.map((f) => `${base}/${study}/${f}`).join("\n");
  });
}

it.skipIf(!SET || !PYTHON)(
  "coronary tree over real cines",
  () => {
    const root = outsideRepository(SET as string);
    const rows: Record<string, unknown>[] = [];
    // A frame of the cine before, another patient's, for the refusal check.
    let foreign: CineFrame | null = null;
    for (const holdout of ["philips_97", "siemens_20"])
      for (const candidates of pick(root, holdout)) {
        let decoded: Decoded | null = null,
          failure: string | null = null,
          used = "";
        for (const path of candidates.split("\n")) {
          try {
            const d = decode(path);
            if (d.header.frames >= MIN_FRAMES && d.header.times_ms) {
              decoded = d;
              used = path;
              break;
            }
          } catch (error) {
            // The decoder's last word, else the error.
            const said = String(
              (error as { stderr?: Buffer }).stderr ?? "",
            ).trim();
            failure = (said.split("\n").at(-1) || String(error)).slice(0, 160);
          }
        }
        const study = candidates.split("\n")[0].split("/").slice(-2, -1)[0];
        if (!decoded) {
          rows.push({ holdout, study, status: "no_cine", failure });
          console.log(JSON.stringify(rows.at(-1)));
          continue;
        }
        let { rows: hgt, columns: wid } = decoded.header;
        let frames: CineFrame[] = decoded.frames.map((pixels, k) => ({
          pixels,
          width: wid,
          height: hgt,
          time_ms: (decoded as Decoded).header.times_ms![k],
        }));
        // Frames above 512 pixels a side are averaged over 2 by 2.
        if (wid > 512) {
          const w2 = wid >> 1,
            h2 = hgt >> 1;
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
          wid = w2;
          hgt = h2;
        }
        // The reference: the frame with the strongest dark lines.
        const strength = frames.map((f) => percentile(lineMap(f), 0.995));
        const reference = strength.indexOf(Math.max(...strength));
        const branches = drawTree(frames[reference]);
        const drawn = branches.flatMap((b) => b.points);
        const began = performance.now();
        let found;
        try {
          found = proposeCoronaryMotion({ frames, reference, branches });
        } catch (error) {
          rows.push({
            holdout,
            study,
            status: "refused_input",
            failure: String(error),
          });
          console.log(JSON.stringify(rows.at(-1)));
          continue;
        }
        const ms = performance.now() - began;
        const still: number[] = [],
          moving: number[] = [],
          gain: number[] = [];
        found.frames.forEach((f, k) => {
          if (f.status !== "tracked") return;
          const a = vesselEvidence(frames[k], drawn),
            b = vesselEvidence(
              frames[k],
              f.branches.flatMap((x) => x.points),
            );
          still.push(a);
          moving.push(b);
          gain.push(b - a);
        });
        const refused = found.frames.filter((f) => f.status === "refused");
        // Refusal: the same cine with one frame next to the reference
        // replaced by another patient's frame of the same size.
        let foreign_refused: boolean | null = null;
        const swap =
          reference + 1 < frames.length ? reference + 1 : reference - 1;
        if (foreign && foreign.width === wid && foreign.height === hgt) {
          const swapped = frames.map((f, k) =>
            k === swap ? { ...f, pixels: (foreign as CineFrame).pixels } : f,
          );
          foreign_refused =
            proposeCoronaryMotion({ frames: swapped, reference, branches })
              .frames[swap].status === "refused";
        }
        // The other patient's frame for the next cine: this cine's reference.
        const nextForeign = frames[reference];
        const row = {
          holdout,
          study,
          file: used.split("/").pop(),
          sha256: decoded.header.sha256.slice(0, 16),
          manufacturer: decoded.header.manufacturer,
          timing: decoded.header.timing,
          frames: frames.length,
          size: wid,
          reference,
          tree_points: drawn.length,
          branches: branches.length,
          tracked: moving.length,
          refused: refused.length,
          refused_first_frames: found.frames
            .slice(0, 5)
            .filter((f) => f.status === "refused").length,
          period_ms:
            found.period_ms === null ? null : Math.round(found.period_ms),
          phase_matched: found.phase_matched.length,
          evidence_still_median: median(still),
          evidence_moving_median: median(moving),
          moving_better_frames: gain.filter((g) => g > 0).length,
          max_moved_px: Math.max(
            0,
            ...found.frames.map((f) =>
              f.status === "refused" ? 0 : f.moved_px,
            ),
          ),
          ms: Math.round(ms),
          neighbour_refused_in_own_cine:
            found.frames[swap].status === "refused",
          foreign_refused,
        };
        rows.push(row);
        foreign = nextForeign;
        console.log(JSON.stringify(row));
      }
    const done = rows.filter((r) => "tracked" in r) as Record<string, any>[];
    const summary = {
      cines: done.length,
      not_read: rows.length - done.length,
      frames: done.reduce((s, r) => s + r.frames, 0),
      tracked: done.reduce((s, r) => s + r.tracked, 0),
      refused: done.reduce((s, r) => s + r.refused, 0),
      refused_share_median: median(done.map((r) => r.refused / r.frames)),
      cines_followed_on_most_frames: done.filter(
        (r) => r.tracked > r.frames / 2,
      ).length,
      by_maker: Object.fromEntries(
        [...new Set(done.map((r) => r.manufacturer))].map((maker) => {
          const mine = done.filter((r) => r.manufacturer === maker);
          return [
            maker,
            {
              cines: mine.length,
              frames: mine.reduce((s, r) => s + r.frames, 0),
              tracked: mine.reduce((s, r) => s + r.tracked, 0),
            },
          ];
        }),
      ),
      not_read_reasons: [
        ...new Set(
          rows
            .filter((r) => !("tracked" in r) && r.failure)
            .map(
              (r) =>
                /Unable to decompress '([^']+)'/.exec(String(r.failure))?.[1] ??
                String(r.failure).slice(0, 80),
            ),
        ),
      ],
      cines_with_period: done.filter((r) => r.period_ms !== null).length,
      period_ms_median: median(
        done.filter((r) => r.period_ms !== null).map((r) => r.period_ms),
      ),
      cines_moving_evidence_higher: done.filter(
        (r) =>
          r.evidence_moving_median !== null &&
          r.evidence_moving_median > r.evidence_still_median,
      ).length,
      evidence_still_median: median(
        done
          .filter((r) => r.evidence_still_median !== null)
          .map((r) => r.evidence_still_median),
      ),
      evidence_moving_median: median(
        done
          .filter((r) => r.evidence_moving_median !== null)
          .map((r) => r.evidence_moving_median),
      ),
      moving_better_frames: done.reduce(
        (s, r) => s + r.moving_better_frames,
        0,
      ),
      ms_median: median(done.map((r) => r.ms)),
      foreign_checked: done.filter((r) => r.foreign_refused !== null).length,
      foreign_refused: done.filter((r) => r.foreign_refused === true).length,
      // Of those, where the own frame was followed: a refusal there is the
      // foreign frame's, not the place in the cine.
      foreign_refused_where_own_followed: done.filter(
        (r) => r.foreign_refused === true && !r.neighbour_refused_in_own_cine,
      ).length,
      foreign_checked_where_own_followed: done.filter(
        (r) => r.foreign_refused !== null && !r.neighbour_refused_in_own_cine,
      ).length,
    };
    console.log("SUMMARY " + JSON.stringify(summary));
  },
  3600_000,
);
