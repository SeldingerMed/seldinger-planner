/** The Ljubljana known-pose evaluation of the vessel evidence methods, over
 * a directory of prepared subjects (see scripts/research/prepare_ljubljana.py).
 * It runs the arms of the first protocol with the same starts, so the two
 * can be read side by side. Research only: nothing here is reachable from
 * the application. */
import { readFileSync } from "node:fs";
import {
  EVIDENCE_BIPLANE_REGISTRATION_METHOD,
  EVIDENCE_REGISTRATION_METHOD,
  proposeEvidenceRegistration,
  type EvidencePlaneInput,
  type EvidenceScore,
} from "../evidenceRegistration";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { vesselEvidence } from "../vesselEvidence2d";
import {
  ARMS as FIRST_ARMS,
  applied,
  f32,
  inPlaneError,
  u16,
} from "./ljubljanaEvaluation";
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
  summarize,
  type Perturbation,
} from "./ljubljanaProtocol";

/** The written protocol is docs/research/ljubljana-evidence-protocol.md; a
 * change here after its run is a new protocol, not a correction. */
export const EVIDENCE_PROTOCOL = {
  id: "ljubljana-evidence-v1",
  /** Subjects the methods were built against, and subjects no diagnostic
   * or development run opened. */
  development: [1, 2, 3, 4, 5],
  held_back: [6, 7, 8, 9, 10],
} as const;

/** The arms of the first protocol, and three in which the entered detector
 * sizes are right and a fit is requested all the same. */
export const ARMS = [
  ...FIRST_ARMS,
  "biplane_fit_right_size",
  "frontal_fit_right_size",
  "lateral_fit_right_size",
] as const;
export type Arm = (typeof ARMS)[number];

export type EvidenceRun = {
  subject: number;
  start: number | "reference";
  start_error_mm: number;
  error_mm: number | null;
  in_plane_mm?: (number | null)[];
  detector_scale_error?: (number | null)[];
  detector_fit?: string;
  fit_gain?: number | null;
  score?: EvidenceScore[];
  start_score?: EvidenceScore[];
  evaluations?: number;
  seconds: number;
  failure?: string;
};

/** Runs every arm on the given prepared subjects (1-based numbers).
 * `starts` holds one list of perturbations per subject of the protocol. */
export function evaluateEvidence(
  prepared: string,
  subjects: readonly number[],
  starts: Perturbation[][] = protocolStarts(),
  progress: (message: string) => void = () => {},
) {
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, []]),
  ) as unknown as Record<Arm, EvidenceRun[]>;
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
        fit_detector_scale: false,
      };
    });
    // The pivot of every perturbation: the vessel points' centroid at the
    // reference pose.
    const pivot: Vec3 = [0, 0, 0];
    for (let k = 0; k < points.length; k += 3) {
      const x = applied(g.matrix, points, k);
      for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
    }
    const entered = (k: number, factor: number): EvidencePlaneInput => ({
      ...planes[k],
      view: {
        ...planes[k].view,
        detector_width_mm: planes[k].view.detector_width_mm * factor,
        detector_height_mm: planes[k].view.detector_height_mm * factor,
      },
      fit_detector_scale: true,
    });
    const run = (
      arm: Arm,
      start: EvidenceRun["start"],
      from: number[][],
      which: number[],
      /** Not fitted, fitted from wrong entered sizes, or from right ones. */
      fit: false | "wrong" | "right",
    ) => {
      const factor = (k: number) =>
        fit === "wrong" ? P.entered_detector_factor[k] : 1;
      const began = performance.now();
      let outcome: Partial<EvidenceRun> & { error_mm: number | null };
      try {
        const p = proposeEvidenceRegistration({
          points,
          planes: which.map((k) => (fit ? entered(k, factor(k)) : planes[k])),
          start: from,
        });
        outcome = {
          error_mm: meanTargetError(fiducials, p.matrix, g.matrix),
          in_plane_mm: p.planes.map((plane, i) =>
            inPlaneError(
              fiducials,
              g.planes[which[i]],
              g.matrix,
              p.matrix,
              plane.view,
            ),
          ),
          detector_scale_error: fit
            ? p.planes.map(
                (plane, i) => plane.detector_scale * factor(which[i]) - 1,
              )
            : undefined,
          detector_fit: p.detector_fit,
          fit_gain: p.fit_gain,
          score: p.planes.map((plane) => plane.score),
          start_score: p.planes.map((plane) => plane.start_score),
          evaluations: p.evaluations,
        };
      } catch (error) {
        outcome = { error_mm: null, failure: String((error as Error).message) };
      }
      arms[arm].push({
        subject,
        start,
        start_error_mm: meanTargetError(fiducials, from, g.matrix),
        ...outcome,
        seconds: (performance.now() - began) / 1000,
      });
    };
    run("biplane_from_reference", "reference", g.matrix, [0, 1], false);
    run("frontal_from_reference", "reference", g.matrix, [0], false);
    run("lateral_from_reference", "reference", g.matrix, [1], false);
    starts[subject - 1].forEach((by, j) => {
      const from = perturbed(g.matrix, pivot, by);
      run("biplane", j, from, [0, 1], false);
      run("biplane_uncalibrated", j, from, [0, 1], "wrong");
      run("biplane_fit_right_size", j, from, [0, 1], "right");
      run("frontal", j, from, [0], false);
      run("lateral", j, from, [1], false);
      run("frontal_uncalibrated", j, from, [0], "wrong");
      run("lateral_uncalibrated", j, from, [1], "wrong");
      run("frontal_fit_right_size", j, from, [0], "right");
      run("lateral_fit_right_size", j, from, [1], "right");
    });
    progress(`subject ${subject} done`);
  }
  return { arms, summary: summarizeEvidence(arms, subjects) };
}

/** The reported numbers for a set of subjects. */
export function summarizeEvidence(
  arms: Record<Arm, EvidenceRun[]>,
  subjects: readonly number[],
) {
  const of = (runs: EvidenceRun[]) =>
    runs.filter((run) => subjects.includes(run.subject));
  // One value per plane per run; a run with no proposal counts once per plane.
  const flat = (
    runs: EvidenceRun[],
    planes: number,
    pick: (run: EvidenceRun) => (number | null)[] | undefined,
  ) => runs.flatMap((run) => pick(run) ?? Array<null>(planes).fill(null));
  const middle = (values: number[]) => summarize(values).median;
  // The method's own cost of a pose, from its reported score.
  const evidence = (scores: EvidenceScore[]) =>
    scores.reduce((sum, s) => sum + s.mean_evidence, 0) / scores.length;
  return {
    methods: [
      EVIDENCE_REGISTRATION_METHOD,
      EVIDENCE_BIPLANE_REGISTRATION_METHOD,
    ],
    subjects: [...subjects],
    arms: Object.fromEntries(
      ARMS.map((name) => {
        const runs = of(arms[name]),
          scored = runs.filter((run) => run.score),
          planes = name.startsWith("biplane") ? 2 : 1,
          errors = runs.map((run) => run.error_mm);
        // Whether the score ranks the reference pose above each perturbed
        // start: the start score of the run from the reference against the
        // start score of each run on the same subject and planes.
        const fitted = /uncalibrated|right_size/.test(name);
        const reference = of(arms[(name + "_from_reference") as Arm] ?? []);
        const ranked =
          name.includes("reference") || fitted
            ? undefined
            : scored.filter((run) => {
                const at = reference.find((r) => r.subject === run.subject);
                return (
                  at?.start_score &&
                  evidence(at.start_score) > evidence(run.start_score!)
                );
              }).length;
        return [
          name,
          {
            runs: runs.length,
            start_error_mm: summarize(runs.map((run) => run.start_error_mm)),
            target_error_mm: summarize(errors),
            runs_under: P.success_mm.map(
              (limit) => errors.filter((e) => e !== null && e < limit).length,
            ),
            // Starts on one subject are not independent runs, so the same
            // thresholds are also counted over whole subjects.
            // A subject with no run in the arm is not counted.
            subjects_with_every_run_under: P.success_mm.map(
              (limit) =>
                subjects.filter((subject) => {
                  const own = runs.filter((run) => run.subject === subject);
                  return (
                    own.length > 0 &&
                    own.every(
                      (run) => run.error_mm !== null && run.error_mm < limit,
                    )
                  );
                }).length,
            ),
            in_plane_error_mm: summarize(
              flat(runs, planes, (run) => run.in_plane_mm),
            ),
            in_plane_under: P.success_mm.map(
              (limit) =>
                flat(runs, planes, (run) => run.in_plane_mm).filter(
                  (e) => e !== null && e < limit,
                ).length,
            ),
            fits_kept: fitted
              ? runs.filter((run) => run.detector_fit === "kept").length
              : undefined,
            detector_scale_abs_error: fitted
              ? summarize(
                  flat(runs, planes, (run) =>
                    run.detector_scale_error?.map((value) =>
                      value === null ? null : Math.abs(value),
                    ),
                  ),
                )
              : undefined,
            starts_scored_below_reference: ranked,
            median_mean_evidence: {
              at_start: middle(
                scored.flatMap((run) =>
                  run.start_score!.map((score) => score.mean_evidence),
                ),
              ),
              at_result: middle(
                scored.flatMap((run) =>
                  run.score!.map((score) => score.mean_evidence),
                ),
              ),
            },
            median_seconds: middle(runs.map((run) => run.seconds)),
            failures: [...new Set(runs.flatMap((run) => run.failure ?? []))],
          },
        ];
      }),
    ),
  };
}
