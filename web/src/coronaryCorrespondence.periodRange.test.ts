import { describe, expect, it, vi } from "vitest";
import { CT_CINE, ctTree, renderCtCine } from "./__fixtures__/coronaryCtCine";
import { proposeCorrespondence } from "./coronaryCorrespondence";

// The period read is replaced by one the method could give at the edge of
// its range: a peak refined half a lag past either end.
const edge = vi.hoisted(() => ({ period_ms: 0 }));
vi.mock("./cardiacPeriod", async (original) => {
  const actual = await original<typeof import("./cardiacPeriod")>();
  return {
    ...actual,
    *cardiacPeriodSteps(...args: Parameters<typeof actual.cardiacPeriodSteps>) {
      const read = yield* actual.cardiacPeriodSteps(...args);
      return read.status === "read" ? { ...read, period_ms: edge.period_ms } : read;
    },
  };
});

describe("a heart period read outside the range the record admits", () => {
  const { frames } = renderCtCine();
  const run = () =>
    proposeCorrespondence({
      tree: { tree_sha256: "a".repeat(64), ct_phase_percent: CT_CINE.ct_phase_percent, branches: ctTree() },
      cine: {
        source_sha256: "b".repeat(64),
        bundle_sha256: "c".repeat(64),
        frames,
        timing: "frame_time_vector",
        view: { ...CT_CINE.view },
        geometry: "fixed",
      },
      pair: { record_id: "pair-1", tree_sha256: "a".repeat(64), cine_source_sha256: "b".repeat(64) },
    });

  it.each([1525, 330])("is refused, not proposed for a record that cannot hold it (%d ms)", (ms) => {
    edge.period_ms = ms;
    const found = run();
    expect(found.status === "refused" && found.reason).toBe("period_out_of_range");
  }, 120_000);

  it("is proposed at the ends of the range", () => {
    edge.period_ms = 1500;
    expect(run().status).toBe("proposed");
  }, 120_000);
});
