// @vitest-environment node
/** Runs the Ljubljana known-pose evaluation as written in
 * docs/research/ljubljana-known-pose-protocol.md. Not part of the test
 * suite: run it with
 *   LJUBLJANA_PREPARED=<dir> LJUBLJANA_RESULTS=<dir> \
 *     npx vitest run --config vitest.research.config.ts
 * Both directories must lie outside this repository. Per-run detail is
 * written only to LJUBLJANA_RESULTS; the summary is also printed. */
import { mkdirSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { evaluatePrepared } from "./ljubljanaEvaluation";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  RESULTS = process.env.LJUBLJANA_RESULTS;

it.skipIf(!PREPARED || !RESULTS)(
  "runs the committed protocol",
  () => {
    // Both are checked before anything is created.
    const prepared = outsideRepository(PREPARED!),
      results = outsideRepository(RESULTS!);
    mkdirSync(results, { recursive: true });
    const { arms, summary } = evaluatePrepared(prepared, undefined, (message) =>
      console.log(message),
    );
    writeFileSync(
      `${results}/detail.json`,
      JSON.stringify(arms, null, 1) + "\n",
    );
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(summary, null, 1) + "\n",
    );
    console.log(JSON.stringify(summary, null, 1));
  },
  6 * 60 * 60 * 1000,
);
