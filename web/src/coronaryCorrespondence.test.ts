import { describe, expect, it, vi } from "vitest";
import { cardiacPeriod } from "./cardiacPeriod";
import {
  CORRESPONDENCE,
  CORRESPONDENCE_METHOD,
  createCorrespondenceJob,
  proposeCorrespondence,
  type CorrespondenceInput,
  type CorrespondenceProposal,
} from "./coronaryCorrespondence";
import {
  CT_CINE,
  ctTree,
  otherPatientTree,
  renderCtCine,
  type CineOptions,
  type CtBranch,
} from "./__fixtures__/coronaryCtCine";

const TREE_SHA = "a".repeat(64),
  CINE_SHA = "b".repeat(64),
  BUNDLE_SHA = "c".repeat(64);

function input(
  options: CineOptions = {},
  change: Partial<CorrespondenceInput> = {},
  tree: CtBranch[] = ctTree(),
): CorrespondenceInput {
  const { frames } = renderCtCine(options);
  return {
    tree: {
      tree_sha256: TREE_SHA,
      ct_phase_percent: CT_CINE.ct_phase_percent,
      branches: tree,
    },
    cine: {
      source_sha256: CINE_SHA,
      bundle_sha256: BUNDLE_SHA,
      frames,
      timing: "frame_time_vector",
      view: { ...CT_CINE.view },
      geometry: "fixed",
    },
    pair: {
      record_id: "pair-1",
      tree_sha256: TREE_SHA,
      cine_source_sha256: CINE_SHA,
    },
    ...change,
  };
}

/** Mean distance from each proposed point to the true place of the CT
 * point it stands for. Truth is read here, after the run, never before. */
function errorAt(
  proposal: CorrespondenceProposal,
  truth: Record<string, number[][]>[],
  frame: number,
  id: string,
  points: number[][],
): number {
  const branch = proposal.branches.find((b) => b.id === id)!;
  const d = points.map((p, k) => {
    const t = truth[frame][id][branch.ct_index[k]];
    return Math.hypot(p[0] - t[0], p[1] - t[1]);
  });
  return d.reduce((a, b) => a + b, 0) / d.length;
}

// A proposal searches the pose three times (the tree and its two mirror
// images); on a loaded runner one takes several seconds.
vi.setConfig({ testTimeout: 120_000 });

describe("CT coronary tree to the same patient's cine", () => {
  const cine = renderCtCine();
  const run = proposeCorrespondence(input());

  it("matches every branch at the CT's phase and follows it over the beats", () => {
    expect(run.method).toBe(CORRESPONDENCE_METHOD);
    if (run.status !== "proposed") throw new Error(JSON.stringify(run));
    // The phase frames sit in diastole, where the CT was reconstructed.
    for (const k of run.phase.quiet_frames) {
      expect(cine.phases[k]).toBeGreaterThan(0.5);
      expect(cine.phases[k]).toBeLessThan(0.92);
    }
    expect(run.phase.quiet_frames).toContain(run.phase.frame);
    // Every branch named and found in its own place.
    expect(run.branches.map((b) => [b.id, b.status])).toEqual(
      ctTree().map((b) => [b.id, "matched"]),
    );
    for (const b of run.branches) {
      const e = errorAt(run, cine.truth, run.phase.frame, b.id, b.points_px);
      expect(e, b.id).toBeLessThan(2.5);
    }
    // Followed over the cine, closer to the truth than a still overlay.
    let moving = 0,
      still = 0,
      n = 0;
    run.motion.frames.forEach((f, k) => {
      if (f.status === "refused") return;
      for (const b of f.branches) {
        moving += errorAt(run, cine.truth, k, b.id, b.points_px);
        const fixed = run.branches.find((x) => x.id === b.id)!.points_px;
        still += errorAt(run, cine.truth, k, b.id, fixed);
        n++;
      }
    });
    expect(n).toBeGreaterThan(0.8 * CT_CINE.frames * ctTree().length);
    expect(moving / n).toBeLessThan(0.5 * (still / n));
    expect(moving / n).toBeLessThan(2.5);
  });

  it("states that it is a proposal bound to the pair it was made for", () => {
    if (run.status !== "proposed") throw new Error(run.reason);
    expect(run.tree_sha256).toBe(TREE_SHA);
    expect(run.cine_source_sha256).toBe(CINE_SHA);
    expect(run.bundle_sha256).toBe(BUNDLE_SHA);
    expect(run.pair_record_id).toBe("pair-1");
    expect(run.operator_confirmation_required).toBe(true);
    expect(run.clinical_validation).toBe(false);
    // A rigid CT-to-C-arm pose.
    const m = run.fit.ct_to_carm_ras;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += m[k][i] * m[k][j];
        expect(s).toBeCloseTo(i === j ? 1 : 0, 6);
      }
    expect(m[3]).toEqual([0, 0, 0, 1]);
    // The tree fits its own cine clearly better than its mirror images.
    expect(run.fit.mirror_score).toBeGreaterThan(0);
    expect(run.fit.score - run.fit.mirror_score).toBeGreaterThanOrEqual(
      CORRESPONDENCE.min_mirror_margin,
    );
  });

  it("matches by place, never by the branches' names", () => {
    const renamed = ctTree().map((b, i, all) => ({
      ...b,
      label: all[(i + 1) % all.length].label,
    }));
    const again = proposeCorrespondence(input({}, {}, renamed));
    if (again.status !== "proposed" || run.status !== "proposed")
      throw new Error("refused");
    again.branches.forEach((b, i) => {
      expect(b.points_px).toEqual(run.branches[i].points_px);
      expect(b.label).toBe(renamed[i].label);
    });
  });
});

describe("refusals", () => {
  const cases: [string, Partial<CorrespondenceInput> | (() => CorrespondenceInput), string][] = [
    ["no pair", { pair: null }, "not_paired"],
    [
      "a pair made for another tree",
      { pair: { record_id: "p", tree_sha256: "d".repeat(64), cine_source_sha256: CINE_SHA } },
      "pair_mismatch",
    ],
    [
      "a pair made for another cine",
      { pair: { record_id: "p", tree_sha256: TREE_SHA, cine_source_sha256: "d".repeat(64) } },
      "pair_mismatch",
    ],
  ];
  for (const [name, change, reason] of cases)
    it(`refuses ${name}`, () => {
      const found = proposeCorrespondence(
        typeof change === "function" ? change() : input({ frames: 24 }, change),
      );
      expect(found.status === "refused" && found.reason).toBe(reason);
    });

  it("refuses times that are only a display rate, or none", () => {
    const base = input({ frames: 24 });
    for (const timing of ["cine_rate", null] as const) {
      const found = proposeCorrespondence({
        ...base,
        cine: { ...base.cine, timing },
      });
      expect(found.status === "refused" && found.reason).toBe("no_frame_times");
    }
  });

  it("refuses a cine without its C-arm geometry, or taken while the C-arm moved", () => {
    const base = input({ frames: 24 });
    const none = proposeCorrespondence({ ...base, cine: { ...base.cine, view: null } });
    expect(none.status === "refused" && none.reason).toBe("no_geometry");
    const moving = proposeCorrespondence({
      ...base,
      cine: { ...base.cine, geometry: "moving" },
    });
    expect(moving.status === "refused" && moving.reason).toBe("moving_geometry");
    // A file that does not say whether the C-arm stood still is not taken
    // as standing still.
    const unsaid = proposeCorrespondence({
      ...base,
      cine: { ...base.cine, geometry: "unknown" },
    });
    expect(unsaid.status === "refused" && unsaid.reason).toBe("geometry_not_declared");
  });

  it("refuses a tree with no CT phase, and a phase only ECG could find", () => {
    const base = input({ frames: 24 });
    const none = proposeCorrespondence({
      ...base,
      tree: { ...base.tree, ct_phase_percent: null },
    });
    expect(none.status === "refused" && none.reason).toBe("ct_phase_missing");
    const systole = proposeCorrespondence({
      ...base,
      tree: { ...base.tree, ct_phase_percent: 40 },
    });
    expect(systole.status === "refused" && systole.reason).toBe(
      "ct_phase_needs_ecg",
    );
  });

  it("refuses where the cine's period cannot be read", () => {
    const found = proposeCorrespondence(input({ still: true }));
    expect(found.status === "refused" && found.reason).toBe("period_not_read");
  });

  it("refuses, rather than fails, when the frames at the CT's phase show no vessels", () => {
    // Before contrast: the heart's shadow beats, a soft dark disc that
    // moves with each beat, so the period reads; no vessel is filled.
    const empty = renderCtCine({ omit: ctTree().map((b) => b.id) }).frames;
    const frames = empty.map((f) => {
      const turn = (2 * Math.PI * f.time_ms) / 860,
        cx = 128 + 10 * Math.sin(turn),
        cy = 128 + 6 * Math.cos(turn);
      return {
        ...f,
        pixels: Uint8Array.from(f.pixels, (v, i) => {
          const d = Math.hypot((i % f.width) - cx, Math.floor(i / f.width) - cy) - 60;
          return Math.max(0, Math.round(v - 40 / (1 + Math.exp(d / 3))));
        }),
      };
    });
    expect(cardiacPeriod(frames).status).toBe("read");
    const base = input();
    const found = proposeCorrespondence({ ...base, cine: { ...base.cine, frames } });
    expect(found.status === "refused" && found.reason).toBe("no_vessels_at_phase");
  });

  it("reads a long cine's heart period in slices, not in one", () => {
    // 600 still frames: the period read covers every frame and every pair
    // of frames before it can refuse. Each slice here is one step.
    const { frames } = renderCtCine({ still: true, frames: 600 });
    const job = createCorrespondenceJob({
      ...input({ frames: 2 }),
      cine: { ...input({ frames: 2 }).cine, frames },
    });
    let slices = 0;
    while (!job.advance(() => true)) slices++;
    expect(job.result().status === "refused" && job.result()).toMatchObject({
      reason: "period_not_read",
    });
    expect(slices).toBeGreaterThanOrEqual(600);
  });

  it("settles two branches contesting one vessel in slices", () => {
    // Settling a contest refits the pose without either branch. The search
    // takes the same number of slices whatever the tree, so a tree with a
    // contest must take more: its refits are sliced too.
    const tree = ctTree();
    const lad = tree.find((b) => b.id === "lad")!;
    const side = (dx: number) => lad.path_ras.map(([x, y, z]) => [x + dx, y, z]);
    const contested = tree.map((b) => (b.id === "lad" ? { ...b, path_ras: side(3) } : b));
    contested.push({ id: "twin", label: "second branch", parent: "lm", path_ras: side(-3) });
    const slices = (given: CtBranch[]) => {
      const job = createCorrespondenceJob(input({}, {}, given));
      let n = 0;
      while (!job.advance(() => true)) n++;
      return { n, result: job.result() };
    };
    const plain = slices(tree),
      contest = slices(contested);
    expect(plain.result.status).toBe("proposed");
    expect(contest.result.status === "proposed" && contest.result.branches.map((b) => b.status)).toContain(
      "conflict",
    );
    expect(contest.n).toBeGreaterThan(plain.n);
  });

  it("refuses another patient's tree", () => {
    // A tree of the same kind, laid out otherwise.
    const other: CtBranch[] = ctTree().map((b) => ({
      ...b,
      path_ras: b.path_ras.map(([x, y, z]) => [-0.8 * z - 20, 0.7 * x + 15, 1.1 * y + 5]),
    }));
    const found = proposeCorrespondence(input({}, {}, other));
    expect(found.status === "refused" && found.reason).toBe("tree_not_found");
  });

  it("refuses another patient's tree that the frame holds no better than its mirror image", () => {
    // Another synthetic patient: its tree lies along enough of this
    // cine's vessels to pass the fit alone (0.66 against 0.5), but its
    // own mirror images fit the frame as well, so the frame does not
    // pin its shape.
    const foreign = proposeCorrespondence(input({}, {}, otherPatientTree()));
    if (foreign.status !== "refused") throw new Error("proposed a foreign tree");
    expect(foreign.reason).toBe("tree_not_distinct");
    expect(foreign.fit_score).toBeGreaterThanOrEqual(CORRESPONDENCE.min_fit);
    expect(foreign.fit_score! - foreign.mirror_score!).toBeLessThan(
      CORRESPONDENCE.min_mirror_margin,
    );
    // And the other way round: this tree on the other patient's cine.
    const back = proposeCorrespondence(input({ tree: otherPatientTree() }));
    expect(back.status === "refused" && back.reason).toMatch(/^tree_not_(distinct|found)$/);
    // The other patient's own tree on its own cine is still proposed.
    const own = proposeCorrespondence(input({ tree: otherPatientTree() }, {}, otherPatientTree()));
    if (own.status !== "proposed") throw new Error(own.reason);
    expect(own.fit.score - own.fit.mirror_score).toBeGreaterThanOrEqual(
      CORRESPONDENCE.min_mirror_margin,
    );
  });

  it("takes no truth or other extra input", () => {
    const base = input({ frames: 24 }) as CorrespondenceInput & { truth?: unknown };
    expect(() => proposeCorrespondence({ ...base, truth: [] } as CorrespondenceInput)).toThrow(
      /Unexpected input/,
    );
  });
});

describe("branch faults are named, not forced", () => {
  it("names a CT branch missing from the cine as not found", () => {
    const found = proposeCorrespondence(input({ omit: ["om1"] }));
    if (found.status !== "proposed") throw new Error(found.reason);
    const status = Object.fromEntries(found.branches.map((b) => [b.id, b.status]));
    expect(status.om1).toBe("not_found");
    expect(status.lad).toBe("matched");
    expect(status.lcx).toBe("matched");
    // A branch not found is not followed.
    for (const f of found.motion.frames)
      if (f.status !== "refused")
        expect(f.branches.map((b) => b.id)).not.toContain("om1");
  });

  it("names a branch with two equally good courses as ambiguous", () => {
    const found = proposeCorrespondence(
      input({ decoys: [{ like: "d1", offset_px: [8, 7] }] }),
    );
    if (found.status !== "proposed") throw new Error(found.reason);
    const d1 = found.branches.find((b) => b.id === "d1")!;
    expect(d1.status).toBe("ambiguous");
    expect(d1.runner_up).not.toBeNull();
    expect(found.branches.find((b) => b.id === "lad")!.status).toBe("matched");
  });

  it("names two branches drawn to one vessel as in conflict", () => {
    // The tree holds two branches, 3 mm either side of the one vessel the
    // cine shows: neither is nearer, so neither may take it.
    const tree = ctTree();
    const lad = tree.find((b) => b.id === "lad")!;
    const side = (dx: number) => lad.path_ras.map(([x, y, z]) => [x + dx, y, z]);
    const given = tree.map((b) => (b.id === "lad" ? { ...b, path_ras: side(3) } : b));
    given.push({ id: "twin", label: "second branch", parent: "lm", path_ras: side(-3) });
    const found = proposeCorrespondence(input({}, {}, given));
    if (found.status !== "proposed") throw new Error(found.reason);
    const status = Object.fromEntries(found.branches.map((b) => [b.id, b.status]));
    expect(status.twin).toBe("conflict");
    expect(status.lad).toBe("conflict");
    expect(status.lcx).toBe("matched");
    // A branch in conflict is not followed.
    for (const f of found.motion.frames)
      if (f.status !== "refused")
        expect(f.branches.map((b) => b.id).sort()).toEqual(
          found.branches.filter((b) => b.status === "matched").map((b) => b.id).sort(),
        );
  });

  it("gives a vessel to the branch the pose put on it, not to a neighbour", () => {
    // Only the CT's own branch lies on the vessel; a second branch 6 mm
    // off, not in the cine, is not drawn onto it.
    const tree = ctTree();
    const lad = tree.find((b) => b.id === "lad")!;
    const twin: CtBranch = {
      id: "twin",
      label: "second branch",
      parent: "lm",
      path_ras: lad.path_ras.map(([x, y, z]) => [x - 6, y, z]),
    };
    const found = proposeCorrespondence(input({}, {}, [...tree, twin]));
    if (found.status !== "proposed") throw new Error(found.reason);
    const status = Object.fromEntries(found.branches.map((b) => [b.id, b.status]));
    expect(status.lad).toBe("matched");
    expect(status.twin).toBe("not_found");
  });

  it("keeps its limits stated", () => {
    expect(CORRESPONDENCE.diastolic_ct_phase_percent).toEqual([60, 85]);
    // The same as the confirmed record's on the server.
    expect(CORRESPONDENCE.max_branches).toBe(32);
    expect(CORRESPONDENCE.max_path_points).toBe(2000);
    expect(CORRESPONDENCE.min_mirror_margin).toBe(0.25);
  });
});
