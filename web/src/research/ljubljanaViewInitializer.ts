/** The Ljubljana evaluation of the learned view initializer, over a
 * directory of prepared subjects (see scripts/research/prepare_ljubljana.py).
 * For every frame it asks the network which way the frame looks, compares
 * the proposed views with the stored one, and runs the vessel evidence
 * registrations from a proposed view and from the studio's default views.
 * Research only: nothing here is reachable from the application. */
import { readFileSync } from "node:fs";
import { viewFrame } from "../carmGeometry";
import {
  proposeEvidenceRegistration,
  type EvidencePlaneInput,
} from "../evidenceRegistration";
import { centroid, medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import {
  networkInput,
  proposeViews,
  runViewNetwork,
  turnedFrame,
  viewOfAxes,
  viewSeparationDeg,
  type ViewNetwork,
} from "../poseInitializer";
import { vesselEvidence } from "../vesselEvidence2d";
import { f32, inPlaneError, u16 } from "./ljubljanaEvaluation";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
  type ReferenceGeometry,
  type ReferencePlane,
} from "./ljubljanaGeometry";
import {
  LJUBLJANA_PROTOCOL as P,
  quantile,
  summarize,
} from "./ljubljanaProtocol";

type TurnedView = {
  primary_deg: number;
  secondary_deg: number;
  turn_deg: number;
};

/** The written protocol is docs/research/ljubljana-view-initializer-protocol.md;
 * a change here after its run is a new protocol, not a correction. */
export const VIEW_PROTOCOL = {
  id: "ljubljana-view-initializer-v1",
  development: [1, 2, 3, 4, 5],
  held_back: [6, 7, 8, 9, 10],
  /** A proposal this close to the stored view counts as near it. */
  within_deg: 15,
  /** What the studio starts from when nobody has entered a view: a frontal
   * plane at 0/0 and a second plane at 90/0. The second plane is also tried
   * from the patient's other side, since nothing in a frame without
   * geometry tags says which side its detector was on. */
  default_views: {
    frontal: { primary_deg: 0, secondary_deg: 0, turn_deg: 0 },
    lateral: { primary_deg: 90, secondary_deg: 0, turn_deg: 0 },
    lateral_other_side: { primary_deg: -90, secondary_deg: 0, turn_deg: 0 },
  },
} as const;

export const VIEW_ARMS = [
  "frontal_default",
  "frontal_first",
  "frontal_best",
  "lateral_default",
  "lateral_default_other_side",
  "lateral_first",
  "lateral_best",
  "biplane_default",
  "biplane_first",
  "biplane_best",
] as const;
export type ViewArm = (typeof VIEW_ARMS)[number];
const PLANE_NAMES = ["frontal", "lateral"] as const;

/** Columns are image right, image up and viewing direction. */
const columns = (frame: { u: Vec3; v: Vec3; d: Vec3 }) =>
  [0, 1, 2].map((i) => [frame.u[i], frame.v[i], frame.d[i]]);

/** The stored view of one plane as the network should answer it: viewing
 * direction and image-up of the plane, taken back into volume RAS. */
export function storedView(g: ReferenceGeometry, plane: number): TurnedView {
  const { view } = g.planes[plane],
    { v, d } = viewFrame(view.primary_deg, view.secondary_deg),
    back = (x: Vec3) =>
      [0, 1, 2].map(
        (j) =>
          g.matrix[0][j] * x[0] + g.matrix[1][j] * x[1] + g.matrix[2][j] * x[2],
      ) as Vec3;
  return viewOfAxes(back(d), back(v));
}

/** The rigid volume-RAS to C-arm-RAS start that makes `plane` see the
 * volume as `view` says, with `pivot` (volume RAS) on the plane's central
 * ray at its isocenter. This is what entering `view` in the studio does,
 * written in the frame the reference geometry uses. */
export function startFromView(
  plane: ReferencePlane,
  view: TurnedView,
  pivot: Vec3,
): number[][] {
  const here = columns(
      viewFrame(plane.view.primary_deg, plane.view.secondary_deg),
    ),
    there = columns(turnedFrame(view)),
    turn = [0, 1, 2].map((i) =>
      [0, 1, 2].map(
        (j) =>
          here[i][0] * there[j][0] +
          here[i][1] * there[j][1] +
          here[i][2] * there[j][2],
      ),
    );
  return [
    ...turn.map((row, i) => [
      ...row,
      plane.isocenter[i] -
        (row[0] * pivot[0] + row[1] * pivot[1] + row[2] * pivot[2]),
    ]),
    [0, 0, 0, 1],
  ];
}

/** Angle of the turn between the rotations of two rigid matrices. */
export function turnBetweenDeg(a: number[][], b: number[][]): number {
  let trace = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) trace += a[i][j] * b[i][j];
  return (
    (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI
  );
}

export type ViewFrameResult = {
  subject: number;
  plane: (typeof PLANE_NAMES)[number];
  stored: TurnedView;
  /** Best first, each with its angle from the stored viewing direction and
   * the error of its in-plane turn. */
  proposals: (TurnedView & {
    share: number;
    apart_deg: number;
    turn_error_deg: number;
  })[];
  first_deg: number;
  best_deg: number;
  /** Position of the proposal nearest the stored view, from 0. */
  best_rank: number;
  /** Angle of the studio's default view for this plane from the stored
   * view; for the lateral plane, from the nearer side. */
  default_deg: number;
  failure?: string;
};
export type ViewRun = {
  subject: number;
  start_view: TurnedView;
  /** Angle between the start and the reference rotation. */
  start_turn_deg: number;
  start_error_mm: number;
  error_mm: number | null;
  in_plane_mm?: number[];
  seconds: number;
  failure?: string;
};

/** Proposes views for both frames of every subject and runs every arm. */
export function evaluateViews(
  prepared: string,
  subjects: readonly number[],
  network: ViewNetwork,
  progress: (message: string) => void = () => {},
) {
  const frames: ViewFrameResult[] = [],
    arms = Object.fromEntries(
      VIEW_ARMS.map((arm) => [arm, []]),
    ) as unknown as Record<ViewArm, ViewRun[]>,
    D = VIEW_PROTOCOL.default_views;
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
    const planes = g.planes.map((plane, k): EvidencePlaneInput => {
      const name = PLANE_NAMES[k];
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
    const seen = planes.map((plane, k): ViewFrameResult => {
      const truth = storedView(g, k),
        proposals = proposeViews(
          runViewNetwork(network, networkInput(network, plane.evidence)),
        ).map((proposal) => ({
          ...proposal,
          apart_deg: viewSeparationDeg(proposal, truth),
          turn_error_deg: Math.abs(proposal.turn_deg - truth.turn_deg),
        })),
        apart = proposals.map((proposal) => proposal.apart_deg),
        defaults = k ? [D.lateral, D.lateral_other_side] : [D.frontal];
      return {
        subject,
        plane: PLANE_NAMES[k],
        stored: truth,
        proposals,
        first_deg: apart[0],
        best_deg: Math.min(...apart),
        best_rank: apart.indexOf(Math.min(...apart)),
        default_deg: Math.min(
          ...defaults.map((view) => viewSeparationDeg(view, truth)),
        ),
      };
    });
    frames.push(...seen);
    const run = (arm: ViewArm, which: number[], view: TurnedView) => {
      // The start comes from the first of the planes that are registered.
      const from = startFromView(g.planes[which[0]], view, pivot),
        began = performance.now();
      let outcome: Partial<ViewRun> & { error_mm: number | null };
      try {
        const p = proposeEvidenceRegistration({
          points,
          planes: which.map((k) => planes[k]),
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
        };
      } catch (error) {
        outcome = { error_mm: null, failure: String((error as Error).message) };
      }
      arms[arm].push({
        subject,
        start_view: view,
        start_turn_deg: turnBetweenDeg(from, g.matrix),
        start_error_mm: meanTargetError(fiducials, from, g.matrix),
        ...outcome,
        seconds: (performance.now() - began) / 1000,
      });
    };
    const pick = (k: number, rank: number): TurnedView => {
      const { primary_deg, secondary_deg, turn_deg } = seen[k].proposals[rank];
      return { primary_deg, secondary_deg, turn_deg };
    };
    run("frontal_default", [0], D.frontal);
    run("frontal_first", [0], pick(0, 0));
    run("frontal_best", [0], pick(0, seen[0].best_rank));
    run("lateral_default", [1], D.lateral);
    run("lateral_default_other_side", [1], D.lateral_other_side);
    run("lateral_first", [1], pick(1, 0));
    run("lateral_best", [1], pick(1, seen[1].best_rank));
    run("biplane_default", [0, 1], D.frontal);
    run("biplane_first", [0, 1], pick(0, 0));
    run("biplane_best", [0, 1], pick(0, seen[0].best_rank));
    progress(`subject ${subject} done`);
  }
  return { frames, arms, summary: summarizeViews(frames, arms, subjects) };
}

const rounded = (value: number | null) =>
  value === null ? null : Math.round(value * 100) / 100;
const median = (values: number[]) =>
  rounded(
    quantile(
      [...values].sort((a, b) => a - b),
      0.5,
    ),
  );

/** The reported numbers for a set of subjects. */
export function summarizeViews(
  frames: ViewFrameResult[],
  arms: Record<ViewArm, ViewRun[]>,
  subjects: readonly number[],
) {
  const inSet = <T extends { subject: number }>(rows: T[]) =>
      rows.filter((row) => subjects.includes(row.subject)),
    within = VIEW_PROTOCOL.within_deg;
  const views = Object.fromEntries(
    ([...PLANE_NAMES, "both"] as const).map((name) => {
      const rows = inSet(frames).filter(
        (row) => name === "both" || row.plane === name,
      );
      return [
        name,
        {
          frames: rows.length,
          first_within: rows.filter((row) => row.first_deg <= within).length,
          best_within: rows.filter((row) => row.best_deg <= within).length,
          default_within: rows.filter((row) => row.default_deg <= within)
            .length,
          first_median_deg: median(rows.map((row) => row.first_deg)),
          best_median_deg: median(rows.map((row) => row.best_deg)),
          default_median_deg: median(rows.map((row) => row.default_deg)),
          first_max_deg: rounded(Math.max(...rows.map((row) => row.first_deg))),
          best_rank: rows.map((row) => row.best_rank),
        },
      ];
    }),
  );
  const registrations = Object.fromEntries(
    VIEW_ARMS.map((arm) => {
      const runs = inSet(arms[arm]);
      return [
        arm,
        {
          runs: runs.length,
          start_turn_deg: {
            median: median(runs.map((run) => run.start_turn_deg)),
            max: rounded(Math.max(...runs.map((run) => run.start_turn_deg))),
          },
          start_error_mm: summarize(runs.map((run) => run.start_error_mm)),
          target_error_mm: summarize(runs.map((run) => run.error_mm)),
          in_plane_error_mm: summarize(
            runs.flatMap((run) => run.in_plane_mm ?? [null]),
          ),
          median_seconds: median(runs.map((run) => run.seconds)),
          failures: runs.flatMap((run) => (run.failure ? [run.failure] : [])),
        },
      ];
    }),
  );
  return {
    protocol: VIEW_PROTOCOL.id,
    subjects: [...subjects],
    within_deg: within,
    success_mm: [...P.success_mm],
    views,
    registrations,
  };
}
