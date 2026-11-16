// @vitest-environment node
/** Runs the vessel evidence methods on prepared Ljubljana subjects. Not
 * part of the test suite:
 *   LJUBLJANA_PREPARED=<dir> LJUBLJANA_RESULTS=<dir> LJUBLJANA_SUBJECTS=<set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaEvidence.eval.ts
 * LJUBLJANA_SUBJECTS is `development` (subjects 01 to 05, used while the
 * method is being built) or `protocol` (all ten, once, as written in
 * docs/research/ljubljana-evidence-protocol.md). Both directories must lie
 * outside this repository; per-run detail is written only to
 * LJUBLJANA_RESULTS. */
import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  EVIDENCE_PROTOCOL,
  evaluateEvidence,
  summarizeEvidence,
} from "./ljubljanaEvidenceEvaluation";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  RESULTS = process.env.LJUBLJANA_RESULTS,
  SET = process.env.LJUBLJANA_SUBJECTS;

it.skipIf(!PREPARED || !RESULTS || !SET)(
  "runs the vessel evidence methods",
  () => {
    if (SET !== "development" && SET !== "protocol")
      throw new Error("LJUBLJANA_SUBJECTS must be development or protocol");
    const prepared = outsideRepository(PREPARED!),
      results = outsideRepository(RESULTS!);
    mkdirSync(results, { recursive: true });
    const development = [...EVIDENCE_PROTOCOL.development],
      held = [...EVIDENCE_PROTOCOL.held_back],
      subjects = SET === "protocol" ? [...development, ...held] : development;
    const { arms } = evaluateEvidence(
      prepared,
      subjects,
      undefined,
      console.log,
    );
    const summary = {
      protocol: EVIDENCE_PROTOCOL.id,
      set: SET,
      development: summarizeEvidence(arms, development),
      held_back: SET === "protocol" ? summarizeEvidence(arms, held) : undefined,
      all: SET === "protocol" ? summarizeEvidence(arms, subjects) : undefined,
    };
    writeFileSync(`${results}/runs.json`, JSON.stringify(arms) + "\n");
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(summary, null, 2) + "\n",
    );
  },
  6 * 60 * 60 * 1000,
);
