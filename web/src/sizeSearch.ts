/** The vessel evidence search with a requested fit of the field size, run
 * from several entered sizes. The fit of evidenceRegistration.ts starts
 * from the entered size and follows the cost downhill, so an entered size
 * that is far off can leave it at a wrong size. Here the unchanged search
 * is first run on each fitted plane alone at a ladder of sizes around the
 * entered one, then with its fit from the best of them, and the result
 * with the lowest cost is kept. */
import { VIEW_LIMITS } from "./carmGeometry";
import {
  createEvidenceRegistrationJob,
  EVIDENCE_NO_POSE,
  EVIDENCE_REGISTRATION_LIMITS as L,
  EVIDENCE_SIZE_SEARCH_BIPLANE_METHOD,
  EVIDENCE_SIZE_SEARCH_METHOD,
  type EvidencePlaneInput,
  type EvidenceRegistrationInput,
  type EvidenceRegistrationProposal,
} from "./evidenceRegistration";

export const SIZE_SEARCH_LIMITS = {
  /** Sizes tried for each fitted plane, as the natural logarithm of the
   * multiple of the entered size. */
  ladder_log: [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3],
  /** How many of a plane's sizes, best first, the fitted search is run
   * from. */
  kept_per_plane: 2,
} as const;

/** The cost the search lowers, read from a result's scores. */
export function evidenceCost(proposal: EvidenceRegistrationProposal): number {
  let sum = 0;
  for (const { score } of proposal.planes)
    sum +=
      1 - score.mean_evidence + L.coverage_weight * score.uncovered_fraction;
  return sum / proposal.planes.length;
}

const resized = (
  plane: EvidencePlaneInput,
  log: number,
  fit: boolean,
): EvidencePlaneInput => ({
  ...plane,
  view: {
    ...plane.view,
    detector_width_mm: plane.view.detector_width_mm * Math.exp(log),
    detector_height_mm: plane.view.detector_height_mm * Math.exp(log),
  },
  fit_detector_scale: fit,
});

/** Whether a plane's detector at this multiple of the entered size is one
 * the view model and the record accept. */
function accepted(plane: EvidencePlaneInput, scale: number) {
  const sides = [
      plane.view.detector_width_mm * scale,
      plane.view.detector_height_mm * scale,
    ],
    limits = [VIEW_LIMITS.detector_width_mm, VIEW_LIMITS.detector_height_mm];
  return (
    scale >= L.detector_scale[0] &&
    scale <= L.detector_scale[1] &&
    sides.every((side, i) => side >= limits[i][0] && side <= limits[i][1])
  );
}

/** Runs the search of `input`, whose planes say which sizes are fitted,
 * and the same search from other entered sizes, yielding between slices of
 * work. The result is described against the entered sizes: each plane's
 * `detector_scale` is its size as a multiple of the entered one, and the
 * start scores are those at the entered sizes. `fit_gain` is the cost at
 * the entered sizes less the cost of the result. */
export function* sizeSearchSteps(
  input: EvidenceRegistrationInput,
  clock: { expired: () => boolean },
  known: {
    /** The result of the search of `input` itself where it has been run:
     * null when it found no pose. */
    entered?: EvidenceRegistrationProposal | null;
    /** The search that is run. */
    job?: typeof createEvidenceRegistrationJob;
  } = {},
): Generator<void, EvidenceRegistrationProposal> {
  if (!input.planes.some((plane) => plane.fit_detector_scale))
    throw new Error("No field size is to be fitted");
  const create = known.job ?? createEvidenceRegistrationJob;
  let evaluations = known.entered?.evaluations ?? 0;
  function* search(
    planes: EvidencePlaneInput[],
  ): Generator<void, EvidenceRegistrationProposal | null> {
    try {
      const job = create({ ...input, planes });
      while (!job.advance(() => clock.expired())) yield;
      const found = job.result();
      evaluations += found.evaluations;
      return found;
    } catch (error) {
      // Only the search's own failure is passed over.
      if (!(error instanceof Error) || error.message !== EVIDENCE_NO_POSE)
        throw error;
      return null;
    }
  }
  const method =
    input.planes.length === 2
      ? EVIDENCE_SIZE_SEARCH_BIPLANE_METHOD
      : EVIDENCE_SIZE_SEARCH_METHOD;
  // The fitted search from the entered sizes: the result when no other
  // size does better, and the source of the start scores.
  const entered =
    known.entered === undefined ? yield* search(input.planes) : known.entered;
  // What the search at the entered sizes cost with no size free.
  const enteredCost = !entered
    ? null
    : entered.detector_fit === "kept"
      ? entered.fit_gain === null
        ? null
        : evidenceCost(entered) + entered.fit_gain
      : evidenceCost(entered);
  // Each fitted plane alone, its size held at each rung of the ladder.
  const rungs: number[][] = [];
  for (const plane of input.planes) {
    if (!plane.fit_detector_scale) {
      rungs.push([0]);
      continue;
    }
    const tried: { log: number; cost: number }[] = [];
    for (const log of SIZE_SEARCH_LIMITS.ladder_log) {
      if (!accepted(plane, Math.exp(log))) continue;
      const found = yield* search([resized(plane, log, false)]);
      if (found) tried.push({ log, cost: evidenceCost(found) });
    }
    // A stable sort: of two rungs with one cost, the smaller size is first.
    tried.sort((a, b) => a.cost - b.cost);
    // A plane whose searches alone found no pose stays at its entered size,
    // so the other plane's sizes are still searched.
    rungs.push(
      tried.length
        ? tried
            .slice(0, SIZE_SEARCH_LIMITS.kept_per_plane)
            .map((rung) => rung.log)
        : [0],
    );
  }
  let best: { found: EvidenceRegistrationProposal; scales: number[] } | null =
    null;
  const combinations =
    input.planes.length === 1
      ? rungs[0].map((log) => [log])
      : rungs[0].flatMap((a) => rungs[1].map((b) => [a, b]));
  for (const logs of combinations) {
    // The fitted search from the entered sizes has been run.
    if (logs.every((log) => log === 0)) continue;
    const found = yield* search(
      input.planes.map((plane, k) =>
        resized(plane, logs[k], plane.fit_detector_scale),
      ),
    );
    if (!found) continue;
    const scales = found.planes.map(
      (plane, k) => Math.exp(logs[k]) * plane.detector_scale,
    );
    if (!scales.every((scale, k) => accepted(input.planes[k], scale))) continue;
    if (!best || evidenceCost(found) < evidenceCost(best.found))
      best = { found, scales };
  }
  // Another size has to earn its place against the entered one, as the
  // fit itself has to.
  const kept =
    best &&
    (!entered || evidenceCost(best.found) < evidenceCost(entered)) &&
    (enteredCost === null ||
      enteredCost - evidenceCost(best.found) >= L.min_fit_gain)
      ? best
      : null;
  if (!kept) {
    if (!entered) throw new Error(EVIDENCE_NO_POSE);
    return { ...entered, method, evaluations };
  }
  return {
    ...kept.found,
    method,
    planes: kept.found.planes.map((plane, k) => ({
      ...plane,
      detector_scale: kept.scales[k],
      start_score: entered ? entered.planes[k].start_score : plane.start_score,
    })),
    detector_fit: "kept",
    fit_gain:
      enteredCost === null ? null : enteredCost - evidenceCost(kept.found),
    evaluations,
  };
}
