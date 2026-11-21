/** The vessel evidence search run from several starts, keeping the result
 * with the most vessel evidence under the projected points. The first start
 * is the volume's own position; the others are views proposed for the
 * frames (poseInitializer.ts). Each run is the unchanged search of
 * evidenceRegistration.ts. */
import {
  createEvidenceRegistrationJob,
  EVIDENCE_BEST_START_BIPLANE_METHOD,
  EVIDENCE_BEST_START_METHOD,
  EVIDENCE_NO_POSE,
  EVIDENCE_REGISTRATION_LIMITS,
  EVIDENCE_SIZE_SEARCH_BIPLANE_METHOD,
  EVIDENCE_SIZE_SEARCH_METHOD,
  type EvidenceRegistrationInput,
  type EvidenceRegistrationProposal,
} from "./evidenceRegistration";
import { centroid } from "./maskPoints";
import { sizeSearchSteps } from "./sizeSearch";

export type BestStartResult = {
  proposal: EvidenceRegistrationProposal;
  /** How many starts were run, those that failed and were passed over
   * included. */
  searched: number;
  /** Position of the start the kept result was found from: 0 is the
   * volume's own position. */
  kept: number;
};

/** Mean over the planes of the mean evidence under the projected points. */
export function meanEvidence(proposal: EvidenceRegistrationProposal): number {
  let sum = 0;
  for (const plane of proposal.planes) sum += plane.score.mean_evidence;
  return sum / proposal.planes.length;
}

const at = (m: number[][], x: readonly number[]) =>
  [0, 1, 2].map(
    (i) => m[i][0] * x[0] + m[i][1] * x[1] + m[i][2] * x[2] + m[i][3],
  );

/** Runs the search from `input.start` and then from each of `others`,
 * yielding between slices of work as the single search does. A start from
 * which no pose keeps the points in every frame is passed over; when that
 * is so for every start, the first start's failure is thrown. Any other
 * error stops the run.
 *
 * Whichever start is kept, the result is described against `input.start`:
 * the start scores are those there, and the distance moved and the angle
 * turned are measured from it. */
export function* bestStartSteps(
  input: EvidenceRegistrationInput,
  others: readonly number[][][],
  clock: { expired: () => boolean },
): Generator<void, BestStartResult> {
  const starts = [input.start as number[][], ...others];
  let best: { proposal: EvidenceRegistrationProposal; k: number } | null = null,
    own: EvidenceRegistrationProposal | null = null,
    failure: unknown = null;
  for (let k = 0; k < starts.length; k++) {
    let found: EvidenceRegistrationProposal;
    try {
      const job = createEvidenceRegistrationJob({ ...input, start: starts[k] });
      while (!job.advance(() => clock.expired())) yield;
      found = job.result();
    } catch (error) {
      // Only the search's own failure is passed over. A fault in the input,
      // a start that is not a rigid pose among them, stops the run.
      if (!(error instanceof Error) || error.message !== EVIDENCE_NO_POSE)
        throw error;
      failure ??= error;
      continue;
    }
    if (k === 0) own = found;
    // A later start has to be better to be kept, not merely as good.
    if (!best || meanEvidence(found) > meanEvidence(best.proposal))
      best = { proposal: found, k };
  }
  if (!best) throw failure;
  // A requested fit of the field size is then searched from several
  // entered sizes, from the kept start.
  if (input.planes.some((plane) => plane.fit_detector_scale))
    best = {
      k: best.k,
      proposal: yield* sizeSearchSteps(
        { ...input, start: starts[best.k] },
        clock,
        { entered: best.proposal },
      ),
    };
  const method =
      best.proposal.method === EVIDENCE_SIZE_SEARCH_METHOD ||
      best.proposal.method === EVIDENCE_SIZE_SEARCH_BIPLANE_METHOD
        ? best.proposal.method
        : input.planes.length === 2
          ? EVIDENCE_BEST_START_BIPLANE_METHOD
          : EVIDENCE_BEST_START_METHOD,
    ends = { searched: starts.length, kept: best.k };
  if (best.k === 0) return { proposal: { ...best.proposal, method }, ...ends };
  // The first start's scores are reported when its search found a pose and
  // enough of the points are inside every frame there. Its search may find
  // a pose even when they are not.
  const scored =
      own &&
      own.planes.every(
        (plane) =>
          plane.start_score.in_field_fraction >=
          EVIDENCE_REGISTRATION_LIMITS.min_in_field,
      )
        ? own
        : null,
    from = starts[0],
    to = best.proposal.matrix,
    pivot = centroid(input.points),
    a = at(from, pivot),
    b = at(to, pivot);
  let trace = 0;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) trace += from[i][j] * to[i][j];
  return {
    proposal: {
      ...best.proposal,
      method,
      planes: best.proposal.planes.map((plane, i) => ({
        ...plane,
        // Where the first start could be scored, its score is the start
        // score, as it is for a search that began there.
        start_score: scored ? scored.planes[i].start_score : plane.start_score,
      })),
      translation_mm: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
      rotation_deg:
        (Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180) / Math.PI,
    },
    ...ends,
  };
}
