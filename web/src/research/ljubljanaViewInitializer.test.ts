// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import fixture from "../__fixtures__/view-network-forward.json";
import { parseViewNetwork, viewSeparationDeg } from "../poseInitializer";
import { writeSubject } from "./__fixtures__/preparedPhantom";
import { referenceGeometry } from "./ljubljanaGeometry";
import {
  evaluateViews,
  startFromView,
  storedView,
  summarizeViews,
  turnBetweenDeg,
  VIEW_ARMS,
  VIEW_PROTOCOL,
} from "./ljubljanaViewInitializer";

// The registrations are bounded searches; under a loaded machine one can
// outlast the default limit.
vi.setConfig({ testTimeout: 60_000 });

const network = () =>
  parseViewNetwork(new Uint8Array(Buffer.from(fixture.file, "base64")));

describe("view initializer evaluation on a phantom stored the same way", () => {
  const root = mkdtempSync(join(tmpdir(), "ljubljana-views-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["subject01", "subject02"]) {
    mkdirSync(join(root, name));
    writeSubject(join(root, name));
  }
  const geometry = () => {
    const stored = JSON.parse(
      readFileSync(join(root, "subject01", "subject.json"), "utf8"),
    );
    return referenceGeometry(
      stored.volume_shape,
      stored.volume_affine,
      stored.views.frontal,
      stored.views.lateral,
    );
  };

  it("reads the stored view of each plane in patient axes", () => {
    const g = geometry(),
      [frontal, lateral] = [0, 1].map((k) => storedView(g, k, "patient"));
    // The phantom is stored in patient axes and turned a few degrees in the
    // C-arm frame, so its frontal plane looks close to straight on and its
    // lateral from the patient's left.
    expect(
      viewSeparationDeg(frontal, VIEW_PROTOCOL.default_views.frontal),
    ).toBeLessThan(15);
    expect(
      viewSeparationDeg(lateral, VIEW_PROTOCOL.default_views.lateral),
    ).toBeLessThan(15);
  });

  it("reads a volume stored half round about the vertical from the other side", () => {
    const g = geometry();
    for (const k of [0, 1]) {
      const plain = storedView(g, k, "patient"),
        turned = storedView(g, k, "half_turn_about_vertical"),
        apart = Math.abs(turned.primary_deg - plain.primary_deg);
      // Front and back change places, and so do left and right; up stays.
      expect(Math.min(apart, 360 - apart)).toBeCloseTo(180, 6);
      expect(turned.secondary_deg).toBeCloseTo(plain.secondary_deg, 6);
      expect(turned.turn_deg).toBeCloseTo(plain.turn_deg, 6);
    }
    // The set under evaluation is stored that way.
    expect(VIEW_PROTOCOL.volume_axes).toBe("half_turn_about_vertical");
  });

  it("starts at the reference rotation when given the stored view", () => {
    const g = geometry(),
      pivot: [number, number, number] = [3, -4, 5];
    for (const [k, axes] of [
      [0, "patient"],
      [1, "patient"],
      [0, "half_turn_about_vertical"],
      [1, "half_turn_about_vertical"],
    ] as const) {
      const start = startFromView(
        g.planes[k],
        storedView(g, k, axes),
        pivot,
        axes,
      );
      expect(turnBetweenDeg(start, g.matrix)).toBeLessThan(1e-5);
      // The pivot lands on the isocenter of the plane.
      const moved = [0, 1, 2].map(
        (i) =>
          start[i][0] * pivot[0] +
          start[i][1] * pivot[1] +
          start[i][2] * pivot[2] +
          start[i][3],
      );
      moved.forEach((value, i) =>
        expect(value).toBeCloseTo(g.planes[k].isocenter[i], 9),
      );
      expect(start[3]).toEqual([0, 0, 0, 1]);
    }
  });

  it("starts as far from the reference as the view is from the stored one", () => {
    const g = geometry(),
      truth = storedView(g, 0, "patient");
    const off = startFromView(
      g.planes[0],
      { ...truth, turn_deg: truth.turn_deg + 20 },
      [0, 0, 0],
      "patient",
    );
    expect(turnBetweenDeg(off, g.matrix)).toBeCloseTo(20, 6);
    const away = { ...truth, secondary_deg: truth.secondary_deg + 30 };
    expect(
      turnBetweenDeg(
        startFromView(g.planes[0], away, [0, 0, 0], "patient"),
        g.matrix,
      ),
    ).toBeGreaterThan(25);
    // The same view read against the wrong axes starts half a turn away.
    expect(
      turnBetweenDeg(
        startFromView(
          g.planes[0],
          truth,
          [0, 0, 0],
          "half_turn_about_vertical",
        ),
        g.matrix,
      ),
    ).toBeGreaterThan(150);
  });

  it("measures the turn between two rotations", () => {
    const g = geometry();
    expect(turnBetweenDeg(g.matrix, g.matrix)).toBeLessThan(1e-5);
    const flipped = g.matrix.map((row, i) =>
      i < 2 ? row.map((x, j) => (j < 3 ? -x : x)) : row,
    );
    expect(turnBetweenDeg(flipped, g.matrix)).toBeCloseTo(180, 6);
  });

  it("proposes views for every frame and runs every arm from them", () => {
    const seen: string[] = [];
    const { frames, arms, summary } = evaluateViews(
      root,
      [1, 2],
      network(),
      (m) => seen.push(m),
      "patient",
    );
    expect(seen).toEqual(["subject 1 done", "subject 2 done"]);
    expect(frames.map((f) => [f.subject, f.plane])).toEqual([
      [1, "frontal"],
      [1, "lateral"],
      [2, "frontal"],
      [2, "lateral"],
    ]);
    for (const f of frames) {
      expect(f.proposals).toHaveLength(5);
      expect(f.first_deg).toBe(f.proposals[0].apart_deg);
      expect(f.best_deg).toBe(f.proposals[f.best_rank].apart_deg);
      expect(f.best_deg).toBeLessThanOrEqual(f.first_deg);
      expect(f.default_deg).toBeLessThan(15);
    }
    expect(Object.keys(arms)).toEqual([...VIEW_ARMS]);
    for (const arm of VIEW_ARMS) {
      expect(arms[arm]).toHaveLength(2);
      for (const run of arms[arm]) {
        expect(Number.isFinite(run.start_turn_deg)).toBe(true);
        expect(run.start_error_mm).toBeGreaterThan(0);
        expect(
          run.error_mm === null ? run.failure : run.in_plane_mm,
        ).toBeTruthy();
      }
    }
    // The arms start where their views say: the first proposal of the
    // frontal frame is the start of both the frontal and the biplane arm.
    expect(arms.frontal_first[0].start_view).toEqual(
      arms.biplane_first[0].start_view,
    );
    expect(arms.frontal_first[0].start_turn_deg).toBeCloseTo(
      arms.biplane_first[0].start_turn_deg,
      9,
    );
    const first = frames[0].proposals[0];
    expect(arms.frontal_first[0].start_view).toEqual({
      primary_deg: first.primary_deg,
      secondary_deg: first.secondary_deg,
      turn_deg: first.turn_deg,
    });
    // From the default views, a few degrees off, the phantom registers.
    expect(arms.biplane_default[0].start_turn_deg).toBeLessThan(15);
    expect(arms.biplane_default[0].error_mm).toBeLessThan(1);
    expect(arms.lateral_default[0].start_turn_deg).toBeLessThan(15);
    expect(summary.volume_axes).toBe("patient");

    expect(summary.protocol).toBe("ljubljana-view-initializer-v1");
    expect(summary.subjects).toEqual([1, 2]);
    expect(summary.views.both.frames).toBe(4);
    expect(summary.views.frontal.frames).toBe(2);
    expect(summary.views.both.default_within).toBe(4);
    expect(summary.views.both.best_within).toBeGreaterThanOrEqual(
      summary.views.both.first_within,
    );
    expect(summary.views.both.best_rank).toEqual(
      frames.map((f) => f.best_rank),
    );
    expect(summary.registrations.biplane_default.runs).toBe(2);
    expect(
      summary.registrations.biplane_default.target_error_mm.success,
    ).toEqual([1, 1, 1]);
    expect(summary.registrations.biplane_default.in_plane_error_mm.runs).toBe(
      4,
    );
    expect(summary.registrations.frontal_default.in_plane_error_mm.runs).toBe(
      2,
    );
    // A subset is summarized from the same rows.
    const one = summarizeViews(frames, arms, [2]);
    expect(one.views.both.frames).toBe(2);
    expect(one.registrations.lateral_first.runs).toBe(1);
  });
});
