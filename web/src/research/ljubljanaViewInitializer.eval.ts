// @vitest-environment node
/** Runs the learned view initializer on prepared Ljubljana subjects. Not
 * part of the test suite:
 *   LJUBLJANA_PREPARED=<dir> VIEW_NETWORK=<view-network.bin> \
 *   VIEW_RESULTS=<dir> LJUBLJANA_SUBJECTS=<set> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaViewInitializer.eval.ts
 * LJUBLJANA_SUBJECTS is `development` (subjects 01 to 05) or `protocol`
 * (all ten, once, as written in
 * docs/research/ljubljana-view-initializer-protocol.md). Every path must
 * lie outside this repository; per-frame detail is written only to
 * VIEW_RESULTS. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { parseViewNetwork } from "../poseInitializer";
import {
  evaluateViews,
  summarizeViews,
  VIEW_PROTOCOL,
} from "./ljubljanaViewInitializer";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  NETWORK = process.env.VIEW_NETWORK,
  RESULTS = process.env.VIEW_RESULTS,
  SET = process.env.LJUBLJANA_SUBJECTS;

it.skipIf(!PREPARED || !NETWORK || !RESULTS || !SET)(
  "runs the view initializer",
  () => {
    if (SET !== "development" && SET !== "protocol")
      throw new Error("LJUBLJANA_SUBJECTS must be development or protocol");
    const prepared = outsideRepository(PREPARED!),
      results = outsideRepository(RESULTS!),
      file = new Uint8Array(readFileSync(outsideRepository(NETWORK!))),
      network = parseViewNetwork(file);
    mkdirSync(results, { recursive: true });
    const development = [...VIEW_PROTOCOL.development],
      held = [...VIEW_PROTOCOL.held_back],
      subjects = SET === "protocol" ? [...development, ...held] : development;
    const { frames, arms } = evaluateViews(
      prepared,
      subjects,
      network,
      console.log,
    );
    const summary = {
      protocol: VIEW_PROTOCOL.id,
      set: SET,
      network_sha256: createHash("sha256").update(file).digest("hex"),
      network_bytes: file.length,
      network_record: network.record,
      development: summarizeViews(frames, arms, development),
      held_back:
        SET === "protocol" ? summarizeViews(frames, arms, held) : undefined,
      all:
        SET === "protocol" ? summarizeViews(frames, arms, subjects) : undefined,
    };
    writeFileSync(
      `${results}/detail.json`,
      JSON.stringify({ frames, arms }) + "\n",
    );
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(summary, null, 2) + "\n",
    );
  },
  60 * 60 * 1000,
);
