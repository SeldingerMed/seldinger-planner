// @vitest-environment node
/** Runs the best-start search (../bestStart.ts) on prepared Ljubljana
 * subjects. Not part of the test suite:
 *   LJUBLJANA_PREPARED=<dir> VIEW_NETWORK=<view-network.bin> \
 *   BEST_START_RESULTS=<dir> LJUBLJANA_SUBJECTS=<set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaBestStart.eval.ts
 * LJUBLJANA_SUBJECTS is `development` (subjects 01 to 05) or `protocol`
 * (all ten, once, as written in docs/research/ljubljana-best-start-protocol.md).
 * Every path must lie outside this repository. The results directory must
 * not exist. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { bestStartSteps } from "../bestStart";
import {
  type EvidencePlaneInput,
  type EvidenceRegistrationInput,
} from "../evidenceRegistration";
import { centroid, medialPoints } from "../maskPoints";
import { parseViewNetwork } from "../poseInitializer";
import { vesselEvidence } from "../vesselEvidence2d";
import { evidenceViews } from "../viewProposals";
import { f32, u16 } from "./ljubljanaEvaluation";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
} from "./ljubljanaGeometry";
import { LJUBLJANA_PROTOCOL as P } from "./ljubljanaProtocol";
import { startFromView, VIEW_PROTOCOL } from "./ljubljanaViewInitializer";
import { outsideRepository } from "./outsideRepository";

export const BEST_START_PROTOCOL = {
  id: "ljubljana-best-start-v1",
  development: VIEW_PROTOCOL.development,
  held_back: VIEW_PROTOCOL.held_back,
} as const;

const PREPARED = process.env.LJUBLJANA_PREPARED,
  NETWORK = process.env.VIEW_NETWORK,
  RESULTS = process.env.BEST_START_RESULTS,
  SET = process.env.LJUBLJANA_SUBJECTS;
const NAMES = ["frontal", "lateral"] as const,
  ARMS = [
    ["frontal", [0], "frontal"],
    ["lateral", [1], "lateral"],
    ["biplane", [0, 1], "frontal"],
    // A lateral frame whose view is not known, started as a frontal one.
    ["lateral_unknown", [1], "frontal"],
  ] as const;
type Run = {
  subject: number;
  arm: string;
  single_mm: number | null;
  best_mm: number | null;
  searched: number;
  kept: number;
};

function finish<T>(steps: Generator<void, T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    half = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[half]
    : (sorted[half - 1] + sorted[half]) / 2;
};
function summarize(runs: Run[], subjects: readonly number[]) {
  return Object.fromEntries(
    ARMS.map(([arm]) => {
      const mine = runs.filter(
          (run) => run.arm === arm && subjects.includes(run.subject),
        ),
        of = (key: "single_mm" | "best_mm") => {
          const got = mine
            .map((run) => run[key])
            .filter((value): value is number => value !== null);
          return {
            runs: mine.length,
            no_proposal: mine.length - got.length,
            median_mm: got.length ? median(got) : null,
            under_1_mm: got.filter((value) => value < 1).length,
            under_2_mm: got.filter((value) => value < 2).length,
            under_5_mm: got.filter((value) => value < 5).length,
          };
        };
      return [
        arm,
        {
          single: of("single_mm"),
          best: of("best_mm"),
          kept_own_position: mine.filter((run) => run.kept === 0).length,
          best_nearer: mine.filter(
            (run) =>
              run.best_mm !== null &&
              (run.single_mm === null || run.best_mm < run.single_mm - 0.05),
          ).length,
          best_farther: mine.filter(
            (run) =>
              run.single_mm !== null &&
              (run.best_mm === null || run.best_mm > run.single_mm + 0.05),
          ).length,
        },
      ];
    }),
  );
}

it.skipIf(!PREPARED || !NETWORK || !RESULTS || !SET)(
  "runs the best-start search",
  () => {
    if (SET !== "development" && SET !== "protocol")
      throw new Error("LJUBLJANA_SUBJECTS must be development or protocol");
    const prepared = outsideRepository(PREPARED!),
      results = outsideRepository(RESULTS!),
      file = new Uint8Array(readFileSync(outsideRepository(NETWORK!))),
      network = parseViewNetwork(file),
      axes = VIEW_PROTOCOL.volume_axes,
      D = VIEW_PROTOCOL.default_views,
      development = [...BEST_START_PROTOCOL.development],
      held = [...BEST_START_PROTOCOL.held_back],
      subjects = SET === "protocol" ? [...development, ...held] : development;
    // One run per directory: an existing one is refused.
    mkdirSync(results);
    const runs: Run[] = [];
    for (const subject of subjects) {
      const dir = `${prepared}/subject${String(subject).padStart(2, "0")}`,
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
      const fiducials = storedPoints(f32(`${dir}/fiducials.f32`), g.center),
        pivot = centroid(points);
      const planes = g.planes.map((plane, k): EvidencePlaneInput => ({
        view: plane.view,
        isocenter: plane.isocenter,
        frame: plane.frame,
        evidence: vesselEvidence(
          windowGray(
            u16(`${dir}/${NAMES[k]}.u16`),
            stored.views[NAMES[k]],
            plane.window,
          ),
          plane.frame.width,
          plane.frame.height,
          P.polarity,
        ),
        fit_detector_scale: false,
      }));
      const proposed = planes.map((plane) =>
        evidenceViews(network, plane.evidence),
      );
      for (const [arm, which, assumed] of ARMS) {
        const input: EvidenceRegistrationInput = {
            points,
            planes: which.map((k) => planes[k]),
            start: startFromView(g.planes[which[0]], D[assumed], pivot, axes),
          },
          others = which.flatMap((k) =>
            proposed[k].map((view) =>
              startFromView(g.planes[k], view, pivot, axes),
            ),
          ),
          error = (others: number[][][]) => {
            try {
              const found = finish(
                bestStartSteps(input, others, { expired: () => false }),
              );
              return {
                mm: meanTargetError(fiducials, found.proposal.matrix, g.matrix),
                searched: found.searched,
                kept: found.kept,
              };
            } catch {
              return { mm: null, searched: others.length + 1, kept: -1 };
            }
          },
          single = error([]),
          best = error(others);
        runs.push({
          subject,
          arm,
          single_mm: single.mm,
          best_mm: best.mm,
          searched: best.searched,
          kept: best.kept,
        });
      }
      console.log(`subject ${subject} done`);
    }
    writeFileSync(`${results}/detail.json`, JSON.stringify(runs) + "\n");
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          protocol: BEST_START_PROTOCOL.id,
          set: SET,
          network_sha256: createHash("sha256").update(file).digest("hex"),
          development: summarize(runs, development),
          held_back: SET === "protocol" ? summarize(runs, held) : undefined,
          all: SET === "protocol" ? summarize(runs, subjects) : undefined,
        },
        null,
        2,
      ) + "\n",
    );
  },
  60 * 60 * 1000,
);
