// @vitest-environment node
/** Protocol `ljubljana-detector-size-v1`: the fit of the field size from
 * the entered size alone against the search from several entered sizes, on
 * the Ljubljana subjects. Not part of the test suite:
 *   LJUBLJANA_PREPARED=<dir> DETECTOR_SIZE_RESULTS=<dir> \
 *     LJUBLJANA_SUBJECTS=<development|all> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaDetectorSize.eval.ts
 * The results directory must not exist. `all` is the protocol run, once. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  EVIDENCE_NO_POSE,
  proposeEvidenceRegistration,
  type EvidencePlaneInput,
  type EvidenceRegistrationInput,
  type EvidenceRegistrationProposal,
} from "../evidenceRegistration";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { sizeSearchSteps } from "../sizeSearch";
import { vesselEvidence } from "../vesselEvidence2d";
import { applied, f32, inPlaneError, u16 } from "./ljubljanaEvaluation";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
} from "./ljubljanaGeometry";
import {
  LJUBLJANA_PROTOCOL as P,
  perturbed,
  protocolStarts,
} from "./ljubljanaProtocol";
import { outsideRepository } from "./outsideRepository";

export const DETECTOR_SIZE_PROTOCOL = {
  id: "ljubljana-detector-size-v1",
  development: [1, 2, 3, 4, 5],
  held_back: [6, 7, 8, 9, 10],
  /** Entered size as a multiple of the stored size, frontal then lateral.
   * The first pair is that of `ljubljana-evidence-v1`. */
  entered_factors: [
    [0.85, 1.2],
    [1.33, 0.75],
    [1, 1],
  ],
  arms: { biplane: [0, 1], frontal: [0], lateral: [1] },
  under_mm: 1,
} as const;

const PREPARED = process.env.LJUBLJANA_PREPARED,
  RESULTS = process.env.DETECTOR_SIZE_RESULTS,
  SET = process.env.LJUBLJANA_SUBJECTS;

/** Null where the search found no pose. Any other error stops the run. */
function attempt(
  run: () => EvidenceRegistrationProposal,
): EvidenceRegistrationProposal | null {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== EVIDENCE_NO_POSE)
      throw error;
    return null;
  }
}
function sizeSearch(input: EvidenceRegistrationInput) {
  const steps = sizeSearchSteps(input, { expired: () => false });
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}
type Row = {
  subject: number;
  start: number;
  factors: readonly number[];
  arm: string;
  fit: Measured | null;
  size_search: Measured | null;
};
type Measured = {
  /** Mean target error for two planes, in-plane error for one. */
  mm: number;
  scale_error: number[];
  detector_fit: string;
  seconds: number;
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function summary(rows: Row[]) {
  const out: Record<string, unknown> = {};
  for (const factors of DETECTOR_SIZE_PROTOCOL.entered_factors)
    for (const arm of Object.keys(DETECTOR_SIZE_PROTOCOL.arms)) {
      const chosen = rows.filter(
          (row) => row.arm === arm && row.factors === factors,
        ),
        side = (key: "fit" | "size_search") => {
          const found = chosen.flatMap((row) => (row[key] ? [row[key]] : []));
          return {
            runs: chosen.length,
            no_proposal: chosen.length - found.length,
            under: found.filter(
              (one) => one.mm < DETECTOR_SIZE_PROTOCOL.under_mm,
            ).length,
            median_mm: found.length ? median(found.map((one) => one.mm)) : null,
            median_scale_error: found.length
              ? median(found.flatMap((one) => one.scale_error.map(Math.abs)))
              : null,
            kept: found.filter((one) => one.detector_fit === "kept").length,
            median_seconds: found.length
              ? median(found.map((one) => one.seconds))
              : null,
          };
        },
        both = chosen.filter((row) => row.fit && row.size_search);
      out[`${factors.join("_")}/${arm}`] = {
        fit: side("fit"),
        size_search: side("size_search"),
        // Of the runs with a proposal from both.
        size_search_nearer: both.filter(
          (row) => row.size_search!.mm < row.fit!.mm - 0.5,
        ).length,
        size_search_farther: both.filter(
          (row) => row.size_search!.mm > row.fit!.mm + 0.5,
        ).length,
      };
    }
  return out;
}

it.skipIf(!PREPARED || !RESULTS || !SET)(
  "runs the detector size protocol",
  () => {
    const prepared = outsideRepository(PREPARED!),
      results = outsideRepository(RESULTS!),
      { development, held_back } = DETECTOR_SIZE_PROTOCOL;
    if (SET !== "development" && SET !== "all")
      throw new Error("LJUBLJANA_SUBJECTS is development or all");
    const subjects =
      SET === "all" ? [...development, ...held_back] : [...development];
    // Refuses a directory that exists: a protocol run is not repeated.
    mkdirSync(results);
    const starts = protocolStarts(),
      rows: Row[] = [];
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
      const fiducials = storedPoints(f32(`${dir}/fiducials.f32`), g.center);
      const planes = g.planes.map((plane, k): EvidencePlaneInput => {
        const name = k ? "lateral" : "frontal";
        return {
          view: plane.view,
          isocenter: plane.isocenter,
          frame: plane.frame,
          evidence: vesselEvidence(
            windowGray(
              u16(`${dir}/${name}.u16`),
              stored.views[name],
              plane.window,
            ),
            plane.frame.width,
            plane.frame.height,
            P.polarity,
          ),
          fit_detector_scale: true,
        };
      });
      const pivot: Vec3 = [0, 0, 0];
      for (let k = 0; k < points.length; k += 3) {
        const x = applied(g.matrix, points, k);
        for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
      }
      starts[subject - 1].forEach((by, j) => {
        const start = perturbed(g.matrix, pivot, by);
        for (const factors of DETECTOR_SIZE_PROTOCOL.entered_factors)
          for (const [arm, which] of Object.entries(
            DETECTOR_SIZE_PROTOCOL.arms,
          )) {
            const input: EvidenceRegistrationInput = {
              points,
              start,
              planes: which.map((k) => ({
                ...planes[k],
                view: {
                  ...planes[k].view,
                  detector_width_mm:
                    planes[k].view.detector_width_mm * factors[k],
                  detector_height_mm:
                    planes[k].view.detector_height_mm * factors[k],
                },
              })),
            };
            const measured = (
              run: () => EvidenceRegistrationProposal,
            ): Measured | null => {
              const began = performance.now(),
                found = attempt(run),
                seconds = (performance.now() - began) / 1000;
              return (
                found && {
                  mm:
                    which.length === 2
                      ? meanTargetError(fiducials, found.matrix, g.matrix)
                      : inPlaneError(
                          fiducials,
                          g.planes[which[0]],
                          g.matrix,
                          found.matrix,
                          found.planes[0].view,
                        ),
                  scale_error: found.planes.map(
                    (plane, i) => plane.detector_scale * factors[which[i]] - 1,
                  ),
                  detector_fit: found.detector_fit,
                  seconds,
                }
              );
            };
            rows.push({
              subject,
              start: j,
              factors,
              arm,
              fit: measured(() => proposeEvidenceRegistration(input)),
              size_search: measured(() => sizeSearch(input)),
            });
          }
      });
      writeFileSync(`${results}/detail.json`, JSON.stringify(rows) + "\n");
      console.log(`subject ${subject} done`);
    }
    const of = (set: readonly number[]) =>
      summary(rows.filter((row) => set.includes(row.subject)));
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          protocol: DETECTOR_SIZE_PROTOCOL.id,
          set: SET,
          development: of(development),
          ...(SET === "all" ? { held_back: of(held_back) } : {}),
        },
        null,
        1,
      ) + "\n",
    );
  },
  12 * 60 * 60 * 1000,
);
