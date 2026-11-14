/** The Ljubljana known-pose evaluation over a directory of prepared
 * subjects (see scripts/research/prepare_ljubljana.py), as written in
 * docs/research/ljubljana-known-pose-protocol.md. Research only: nothing
 * here is reachable from the application. */
import { readFileSync } from "node:fs";
import {
  BIPLANE_REGISTRATION_METHOD,
  proposeBiplaneRegistration,
  type BiplanePlaneInput,
} from "../biplaneRegistration";
import { camera, project, type ViewNumbers } from "../carmGeometry";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import {
  PROJECTION_REGISTRATION_METHOD,
  proposeProjectionRegistration,
  type RegistrationScore,
} from "../projectionRegistration";
import { vesselTarget } from "../vesselness2d";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
  type ReferencePlane,
} from "./ljubljanaGeometry";
import {
  LJUBLJANA_PROTOCOL as P,
  perturbed,
  protocolStarts,
  summarize,
  type Perturbation,
} from "./ljubljanaProtocol";

const u16 = (path: string) => {
  const bytes = readFileSync(path);
  return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
};
const f32 = (path: string) => {
  const bytes = readFileSync(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};
const applied = (m: number[][], x: ArrayLike<number>, k: number): Vec3 =>
  [0, 1, 2].map(
    (i) => m[i][0] * x[k] + m[i][1] * x[k + 1] + m[i][2] * x[k + 2] + m[i][3],
  ) as Vec3;

/** Mean distance between where two poses put the stored points on one
 * plane's detector, in millimeters at that plane's isocenter. `view` is the
 * view the estimate was scored in, which differs from the reference view
 * when a detector scale was fitted. */
function inPlaneError(
  points: Float32Array,
  plane: ReferencePlane,
  reference: number[][],
  estimate: number[][],
  view: ViewNumbers,
): number {
  const truth = camera(plane.view, plane.isocenter),
    found = camera(view, plane.isocenter),
    toIsocenter =
      plane.view.source_isocenter_mm / plane.view.source_detector_mm,
    // A fitted view shows the same pixels as a wider or narrower detector.
    rescale = plane.view.detector_width_mm / view.detector_width_mm;
  let sum = 0;
  for (let k = 0; k < points.length; k += 3) {
    const a = project(truth, applied(reference, points, k)),
      b = project(found, applied(estimate, points, k));
    sum +=
      Math.hypot(a[0] - b[0] * rescale, a[1] - b[1] * rescale) * toIsocenter;
  }
  return sum / (points.length / 3);
}

export type Run = {
  subject: number;
  start: number | "reference";
  start_error_mm: number;
  error_mm: number | null;
  in_plane_mm?: (number | null)[];
  detector_scale_error?: (number | null)[];
  score?: RegistrationScore[];
  start_score?: RegistrationScore[];
  evaluations?: number;
  seconds: number;
  failure?: string;
};

export const ARMS = [
  "biplane",
  "biplane_from_reference",
  "biplane_uncalibrated",
  "frontal",
  "lateral",
  "frontal_from_reference",
  "lateral_from_reference",
  "frontal_uncalibrated",
  "lateral_uncalibrated",
] as const;
export type Arm = (typeof ARMS)[number];

/** Runs every arm on every prepared subject. `starts` holds one list of
 * perturbations per subject and defaults to the protocol's. */
export function evaluatePrepared(
  prepared: string,
  starts: Perturbation[][] = protocolStarts(),
  progress: (message: string) => void = () => {},
) {
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, []]),
  ) as unknown as Record<Arm, Run[]>;
  const inputs = {
    points: [] as number[],
    residual_px: 0,
    frames: [] as string[],
  };
  for (let n = 0; n < starts.length; n++) {
    const dir = `${prepared}/subject${String(n + 1).padStart(2, "0")}`,
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
    const planes = g.planes.map((plane, k): BiplanePlaneInput => {
      const name = k ? "lateral" : "frontal",
        gray = windowGray(
          u16(`${dir}/${name}.u16`),
          stored.views[name],
          plane.window,
        );
      return {
        view: plane.view,
        isocenter: plane.isocenter,
        frame: plane.frame,
        target: vesselTarget(
          gray,
          plane.frame.width,
          plane.frame.height,
          P.polarity,
        ),
        fit_detector_scale: false,
      };
    });
    inputs.points.push(points.length / 3);
    inputs.frames.push(
      ...g.planes.map((p) => `${p.frame.width}x${p.frame.height}`),
    );
    for (const plane of g.planes)
      inputs.residual_px = Math.max(
        inputs.residual_px,
        ...plane.window.residual_px.map(Math.abs),
      );
    // The pivot of every perturbation: the vessel points' centroid at the
    // reference pose.
    const pivot: Vec3 = [0, 0, 0];
    for (let k = 0; k < points.length; k += 3) {
      const x = applied(g.matrix, points, k);
      for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
    }
    const entered = (k: number): BiplanePlaneInput => ({
      ...planes[k],
      view: {
        ...planes[k].view,
        detector_width_mm:
          planes[k].view.detector_width_mm * P.entered_detector_factor[k],
        detector_height_mm:
          planes[k].view.detector_height_mm * P.entered_detector_factor[k],
      },
      fit_detector_scale: true,
    });

    const attempt = (
      arm: Arm,
      start: Run["start"],
      from: number[][],
      solve: () => Omit<
        Run,
        "subject" | "start" | "start_error_mm" | "seconds"
      >,
    ) => {
      const began = performance.now();
      let outcome: ReturnType<typeof solve>;
      try {
        outcome = solve();
      } catch (error) {
        outcome = { error_mm: null, failure: String((error as Error).message) };
      }
      arms[arm].push({
        subject: n + 1,
        start,
        start_error_mm: meanTargetError(fiducials, from, g.matrix),
        ...outcome,
        seconds: (performance.now() - began) / 1000,
      });
    };
    const biplane = (
      arm: Arm,
      start: Run["start"],
      from: number[][],
      fit: boolean,
    ) =>
      attempt(arm, start, from, () => {
        const used = fit ? [entered(0), entered(1)] : planes;
        const p = proposeBiplaneRegistration({
          points,
          planes: [used[0], used[1]],
          start: from,
        });
        return {
          error_mm: meanTargetError(fiducials, p.matrix, g.matrix),
          in_plane_mm: p.planes.map((plane, k) =>
            inPlaneError(
              fiducials,
              g.planes[k],
              g.matrix,
              p.matrix,
              plane.view,
            ),
          ),
          detector_scale_error: fit
            ? p.planes.map(
                (plane, k) =>
                  plane.detector_scale * P.entered_detector_factor[k] - 1,
              )
            : undefined,
          score: p.planes.map((plane) => plane.score),
          start_score: p.planes.map((plane) => plane.start_score),
          evaluations: p.evaluations,
        };
      });
    const single = (
      arm: Arm,
      k: number,
      start: Run["start"],
      from: number[][],
      fit: boolean,
    ) =>
      attempt(arm, start, from, () => {
        const used = fit ? entered(k) : planes[k];
        const p = proposeProjectionRegistration({
          points,
          view: used.view,
          isocenter: used.isocenter,
          frame: used.frame,
          target: used.target,
          start: from,
          fit_detector_scale: fit,
        });
        return {
          error_mm: meanTargetError(fiducials, p.matrix, g.matrix),
          in_plane_mm: [
            inPlaneError(fiducials, g.planes[k], g.matrix, p.matrix, p.view),
          ],
          detector_scale_error: fit
            ? [p.detector_scale * P.entered_detector_factor[k] - 1]
            : undefined,
          score: [p.score],
          start_score: [p.start_score],
          evaluations: p.evaluations,
        };
      });

    biplane("biplane_from_reference", "reference", g.matrix, false);
    single("frontal_from_reference", 0, "reference", g.matrix, false);
    single("lateral_from_reference", 1, "reference", g.matrix, false);
    starts[n].forEach((by, j) => {
      const from = perturbed(g.matrix, pivot, by);
      biplane("biplane", j, from, false);
      biplane("biplane_uncalibrated", j, from, true);
      single("frontal", 0, j, from, false);
      single("lateral", 1, j, from, false);
      single("frontal_uncalibrated", 0, j, from, true);
      single("lateral_uncalibrated", 1, j, from, true);
    });
    progress(`subject ${n + 1} of ${starts.length} done`);
  }

  // One value per plane per run; a run with no proposal counts once per plane.
  const flat = (
    runs: Run[],
    planes: number,
    pick: (run: Run) => (number | null)[] | undefined,
  ) => runs.flatMap((run) => pick(run) ?? Array<null>(planes).fill(null));
  const middle = (values: number[]) => summarize(values).median;
  const summary = {
    protocol: P.id,
    methods: [PROJECTION_REGISTRATION_METHOD, BIPLANE_REGISTRATION_METHOD],
    subjects: starts.length,
    vessel_points_per_subject: {
      least: Math.min(...inputs.points),
      most: Math.max(...inputs.points),
    },
    frame_sizes: [...new Set(inputs.frames)].sort(),
    largest_window_residual_px: Math.round(inputs.residual_px * 1000) / 1000,
    arms: Object.fromEntries(
      Object.entries(arms).map(([name, runs]) => {
        const scored = runs.filter((run) => run.score),
          planes = name.startsWith("biplane") ? 2 : 1;
        return [
          name,
          {
            start_error_mm: summarize(runs.map((run) => run.start_error_mm)),
            target_error_mm: summarize(runs.map((run) => run.error_mm)),
            // Starts on one subject are not independent runs, so the same
            // thresholds are also counted over whole subjects.
            subjects_with_every_run_under: P.success_mm.map(
              (limit) =>
                starts.filter((_, n) =>
                  runs
                    .filter((run) => run.subject === n + 1)
                    .every(
                      (run) => run.error_mm !== null && run.error_mm < limit,
                    ),
                ).length,
            ),
            in_plane_error_mm: summarize(
              flat(runs, planes, (run) => run.in_plane_mm),
            ),
            detector_scale_abs_error: name.endsWith("uncalibrated")
              ? summarize(
                  flat(runs, planes, (run) =>
                    run.detector_scale_error?.map((value) =>
                      value === null ? null : Math.abs(value),
                    ),
                  ),
                )
              : undefined,
            median_mean_distance_mm: {
              at_start: middle(
                scored.flatMap((run) =>
                  run.start_score!.map((score) => score.mean_distance_mm),
                ),
              ),
              at_result: middle(
                scored.flatMap((run) =>
                  run.score!.map((score) => score.mean_distance_mm),
                ),
              ),
            },
            median_matched_fraction: {
              at_start: middle(
                scored.flatMap((run) =>
                  run.start_score!.map((score) => score.matched_fraction),
                ),
              ),
              at_result: middle(
                scored.flatMap((run) =>
                  run.score!.map((score) => score.matched_fraction),
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
  return { arms, summary };
}
