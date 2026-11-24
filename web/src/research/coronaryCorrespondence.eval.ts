// @vitest-environment node
/** The CT tree against cines rendered from real CT coronary anatomy:
 * ImageCAS-X (Zenodo 10.5281/zenodo.23562647, CC BY 4.0) left coronary
 * centerlines, each moved by the synthetic beat and breathing of
 * ../__fixtures__/coronaryCtCine.ts and projected through its C-arm into a
 * cine with known truth for every branch point in every frame. Not part of
 * the test suite:
 *   ICX_ZIP=<ImageCAS-X_dataset_v2.zip> CINE_PYTHON=<ingest python> \
 *   ICX_SPLIT=design npx vitest run --config vitest.research.config.ts \
 *     src/research/coronaryCorrespondence.eval.ts
 *
 * These cines are made from the CT. They are a known-truth check of the
 * engine on real vessel shapes, not an angiogram and not a measurement of
 * CT-to-angiogram registration on any patient.
 *
 * Per case:
 * - the case's own tree on its own cine: proposed or refused, each branch's
 *   status, and the error of the followed branches against truth over every
 *   frame, beside the error of the same branches held still at the phase
 *   frame (pixels of 0.8 mm at the detector);
 * - three trees of other patients on that cine (the next case of the split,
 *   the synthetic tracer tree, and the synthetic second patient): each
 *   should be refused.
 *
 * Splits, fixed before any run: `design` is case 190 and the first four of
 * ImageCAS-X filelist/test.txt (878, 844, 80, 686), on which
 * `min_mirror_margin` was set; `heldout` is test.txt lines 5 to 14, run once
 * under docs/research/step-e-correspondence-heldout-protocol.md. Each tree
 * is read from the zip in memory; nothing is written. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { it } from "vitest";
import {
  CORRESPONDENCE,
  proposeCorrespondence,
  type CtTreeBranch,
} from "../coronaryCorrespondence";
import {
  CT_CINE,
  ctTree,
  otherPatientTree,
  renderCtCine,
} from "../__fixtures__/coronaryCtCine";
import { median } from "./cineSet";

const ZIP = process.env.ICX_ZIP,
  PYTHON = process.env.CINE_PYTHON,
  SPLIT = process.env.ICX_SPLIT;
const SPLITS: Record<string, string[]> = {
  design: ["190", "878", "844", "80", "686"],
  heldout: ["87", "789", "448", "625", "954", "580", "85", "368", "806", "88"],
};
const READER = new URL(
  "../../../scripts/research/imagecasx_tree.py",
  import.meta.url,
).pathname;
const PARENT: Record<string, string | null> = {
  LM: null,
  LAD: "lm",
  LCX: "lm",
  D1: "lad",
  D2: "lad",
  OM1: "lcx",
  OM2: "lcx",
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function resample(p: number[][], step = 1): number[][] {
  const out = [p[0]];
  let run = 0;
  for (let i = 1; i < p.length; i++) {
    run += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
    if (run >= step) {
      out.push(p[i]);
      run = 0;
    }
  }
  return out;
}

/** The case's left tree, named branches only, centred on its own mean. */
function caseTree(id: string): CtTreeBranch[] {
  const out = execFileSync(PYTHON!, ["-W", "ignore", READER, ZIP!, id], {
    maxBuffer: 2 ** 26,
    env: Object.fromEntries(
      Object.entries({ ...process.env, PYTHONDONTWRITEBYTECODE: "1" }).filter(
        ([name]) => name !== "PYTHONPATH" && name !== "PYTHONHOME",
      ),
    ),
  });
  const named: Record<string, number[][]> = JSON.parse(out.toString("utf8")).left.branches;
  const raw = Object.keys(PARENT)
    .filter((name) => named[name])
    .map((name) => ({
      id: name.toLowerCase(),
      label: name,
      parent: PARENT[name],
      path_ras: resample(named[name]),
    }));
  const all = raw.flatMap((b) => b.path_ras);
  const mid = [0, 1, 2].map((k) => all.reduce((s, p) => s + p[k], 0) / all.length);
  return raw.map((b) => ({ ...b, path_ras: b.path_ras.map((p) => p.map((v, k) => v - mid[k])) }));
}

/** Mean distance of the given points from the true course, pixels. */
function offCourse(points: number[][], course: number[][]): number {
  const from = (p: number[]) => {
    let best = Infinity;
    for (let i = 1; i < course.length; i++) {
      const [ax, ay] = course[i - 1],
        [bx, by] = course[i];
      const dx = bx - ax,
        dy = by - ay,
        l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l)) : 0;
      best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
    }
    return best;
  };
  return points.reduce((s, p) => s + from(p), 0) / points.length;
}

const quantile = (v: number[], q: number) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const round = (v: number | null | undefined, d = 3) =>
  v === null || v === undefined ? null : +v.toFixed(d);

it(
  "CT tree against cines from real CT anatomy",
  async () => {
    if (!ZIP || !PYTHON || !SPLIT || !SPLITS[SPLIT])
      throw new Error("Set ICX_ZIP, CINE_PYTHON and ICX_SPLIT (design or heldout)");
    const cases = SPLITS[SPLIT];
    const trees = Object.fromEntries(cases.map((c) => [c, caseTree(c)]));
    const run = (tree: CtTreeBranch[], cine: Parameters<typeof proposeCorrespondence>[0]["cine"]) => {
      const tree_sha256 = sha(JSON.stringify(tree));
      return proposeCorrespondence({
        tree: { tree_sha256, ct_phase_percent: CT_CINE.ct_phase_percent, branches: tree },
        cine,
        pair: { record_id: "evaluation", tree_sha256, cine_source_sha256: cine.source_sha256 },
      });
    };
    const own: Record<string, unknown>[] = [],
      foreign: Record<string, unknown>[] = [];
    const followedAll: number[] = [],
      stillAll: number[] = [];
    const statuses: Record<string, number> = {};
    for (const [n, c] of cases.entries()) {
      const tree = trees[c];
      const { frames, truth } = renderCtCine({ tree });
      const cine = {
        source_sha256: sha(`imagecasx-${c}-cine`),
        bundle_sha256: sha(`imagecasx-${c}-bundle`),
        frames,
        timing: "frame_time_vector" as const,
        view: { ...CT_CINE.view },
        geometry: "fixed" as const,
      };
      const r = run(tree, cine);
      if (r.status !== "proposed") {
        own.push({ case: c, status: r.status, reason: r.reason, fit: round(r.fit_score), mirror: round(r.mirror_score) });
      } else {
        const phase = r.motion.frames[r.phase.frame];
        const held = phase.status === "refused" ? [] : phase.branches;
        const followed: number[] = [],
          still: number[] = [];
        r.motion.frames.forEach((f, k) => {
          if (f.status === "refused") return;
          for (const b of f.branches) {
            const course = truth[k][b.id];
            if (!course || !b.points_px.length) continue;
            followed.push(offCourse(b.points_px, course));
            const h = held.find((x) => x.id === b.id);
            if (h?.points_px.length) still.push(offCourse(h.points_px, course));
          }
        });
        followedAll.push(...followed);
        stillAll.push(...still);
        const branches = Object.fromEntries(r.branches.map((b) => [b.id, b.status]));
        for (const b of r.branches) statuses[b.status] = (statuses[b.status] ?? 0) + 1;
        own.push({
          case: c,
          status: r.status,
          fit: round(r.fit.score),
          mirror: round(r.fit.mirror_score),
          period_ms: Math.round(r.phase.period_ms),
          phase_frame: r.phase.frame,
          branches,
          followed_frames: r.motion.followed,
          of_frames: frames.length,
          followed_px: { median: round(median(followed), 2), p95: round(quantile(followed, 0.95), 2) },
          still_px: { median: round(median(still), 2), p95: round(quantile(still, 0.95), 2) },
        });
      }
      console.log(JSON.stringify({ own: own[own.length - 1] }));
      const next = cases[(n + 1) % cases.length];
      for (const [name, other] of [
        [`imagecasx_${next}`, trees[next]],
        ["tracer", ctTree() as CtTreeBranch[]],
        ["second_patient", otherPatientTree() as CtTreeBranch[]],
      ] as [string, CtTreeBranch[]][]) {
        const f = run(other, cine);
        const row =
          f.status === "refused"
            ? { cine: c, tree: name, status: f.status, reason: f.reason, fit: round(f.fit_score), mirror: round(f.mirror_score) }
            : { cine: c, tree: name, status: f.status, fit: round(f.fit.score), mirror: round(f.fit.mirror_score) };
        foreign.push(row);
        console.log(JSON.stringify({ foreign: row }));
      }
    }
    const count = (rows: Record<string, unknown>[], key: string) =>
      rows.reduce<Record<string, number>>((m, r) => {
        const k = String(r[key]);
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {});
    console.log(
      JSON.stringify({
        split: SPLIT,
        cases: cases.length,
        min_fit: CORRESPONDENCE.min_fit,
        min_mirror_margin: CORRESPONDENCE.min_mirror_margin,
        own_proposed: own.filter((r) => r.status === "proposed").length,
        own_refusals: count(own.filter((r) => r.status === "refused"), "reason"),
        own_branch_status: statuses,
        followed_px: { n: followedAll.length, median: round(median(followedAll), 2), p95: round(quantile(followedAll, 0.95), 2) },
        still_px: { n: stillAll.length, median: round(median(stillAll), 2), p95: round(quantile(stillAll, 0.95), 2) },
        foreign: foreign.length,
        foreign_refused: foreign.filter((r) => r.status === "refused").length,
        foreign_refusals: count(foreign.filter((r) => r.status === "refused"), "reason"),
      }),
    );
  },
  3_600_000,
);
