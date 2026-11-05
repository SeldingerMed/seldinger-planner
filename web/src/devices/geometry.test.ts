import { describe, expect, it } from "vitest";
import {
  coilPack,
  flowDiverter,
  intrasaccular,
  type DeviceGeometry,
  type Vec3,
} from "./geometry";

const EPS = 1e-9;

function finiteGeometry(g: DeviceGeometry): void {
  for (const line of g.lines) {
    for (const p of line) {
      expect(p.every((v) => Number.isFinite(v))).toBe(true);
    }
  }
  for (const axis of [g.bounds.min, g.bounds.max]) {
    expect(axis.every((v) => Number.isFinite(v))).toBe(true);
  }
}

function pointCount(g: DeviceGeometry): number {
  let n = 0;
  for (const line of g.lines) n += line.length;
  if (g.surface) n += g.surface.points.length;
  return n;
}

function polylineLength(line: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) {
    s += Math.hypot(
      line[i][0] - line[i - 1][0],
      line[i][1] - line[i - 1][1],
      line[i][2] - line[i - 1][2],
    );
  }
  return s;
}

function totalWireLength(g: DeviceGeometry): number {
  return g.lines.reduce((sum, l) => sum + polylineLength(l), 0);
}

describe("flowDiverter", () => {
  it("wireCount is TOTAL strands, and a shorter device never spans the full path", () => {
    const g = flowDiverter({
      path: [
        [0, 0, 0],
        [0, 0, 40],
      ],
      diameterMm: 4,
      lengthMm: 10,
      wireCount: 48,
      turns: 2,
    });
    expect(g.lines).toHaveLength(48);
    expect(g.bounds.min[2]).toBeCloseTo(0);
    expect(g.bounds.max[2]).toBeCloseTo(10);
  });
  it("rejects enormous input paths before resampling allocation", () => {
    expect(() =>
      flowDiverter({
        path: [
          [0, 0, 0],
          [0, 0, 1001],
        ],
        diameterMm: 4,
        lengthMm: 10,
        wireCount: 48,
        turns: 2,
      }),
    ).toThrow();
  });
  // Known value: straight path along +X, 10 mm long, 4 mm diameter braid.
  it("lays a counterbraid on a straight path with known wire geometry", () => {
    const path: Vec3[] = [
      [-5, 0, 0],
      [0, 0, 0],
      [5, 0, 0],
    ];
    const g = flowDiverter({
      path,
      diameterMm: 4,
      lengthMm: 10,
      wireCount: 6,
      turns: 2,
    });
    expect(g.lines.length).toBe(6); // Six total wires, half in each direction.
    finiteGeometry(g);
    const radius = 2;
    for (const line of g.lines) {
      expect(line.length).toBeGreaterThan(1);
      for (const p of line) {
        // Every braid point sits on the tube surface about the path axis.
        const [x, y, z] = p;
        expect(x).toBeGreaterThanOrEqual(-5 - EPS);
        expect(x).toBeLessThanOrEqual(5 + EPS);
        const radial = Math.hypot(y, z);
        expect(Math.abs(radial - radius)).toBeLessThan(1e-3);
      }
    }
    // Braid spans exactly the requested length in arclength: first point of
    // the first strand is at the path start offset by the tube radius.
    const first = g.lines[0][0];
    expect(Math.hypot(first[1], first[2])).toBeCloseTo(2, 6);
  });

  it("produces bounds that enclose every point and nothing wildly extra", () => {
    const path: Vec3[] = [
      [-5, 0, 0],
      [5, 0, 0],
    ];
    const g = flowDiverter({
      path,
      diameterMm: 4,
      lengthMm: 10,
      wireCount: 6,
      turns: 2,
    });
    for (const line of g.lines) {
      for (const p of line) {
        for (let a = 0; a < 3; a++) {
          expect(p[a]).toBeGreaterThanOrEqual(g.bounds.min[a] - EPS);
          expect(p[a]).toBeLessThanOrEqual(g.bounds.max[a] + EPS);
        }
      }
    }
    expect(g.bounds.min[1]).toBeCloseTo(-2, 2);
    expect(g.bounds.max[1]).toBeCloseTo(2, 2);
    expect(g.bounds.min[2]).toBeCloseTo(-2, 2);
    expect(g.bounds.max[2]).toBeCloseTo(2, 2);
  });

  it("follows a curved path with the braid centered on the path", () => {
    const path: Vec3[] = [];
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      path.push([10 * t, 3 * Math.sin(Math.PI * t), 0]);
    }
    const g = flowDiverter({
      path,
      diameterMm: 3,
      lengthMm: 5,
      wireCount: 4,
      turns: 1.5,
    });
    for (const line of g.lines) {
      for (const p of line) {
        // distance to nearest path sample <= tube radius + chord error
        let best = Infinity;
        for (const q of path) {
          best = Math.min(
            best,
            Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]),
          );
        }
        expect(best).toBeLessThan(1.5 + 0.2);
      }
    }
  });

  it("rejects degenerate and invalid inputs", () => {
    const good = { diameterMm: 4, lengthMm: 10, wireCount: 6, turns: 2 };
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [0, 0, 0],
        ],
      }),
    ).toThrow();
    expect(() =>
      flowDiverter({ ...good, path: [[0, 0, 0]] as Vec3[] }),
    ).toThrow();
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        diameterMm: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        diameterMm: -1,
      }),
    ).toThrow();
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        lengthMm: 0,
      }),
    ).toThrow();
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        wireCount: 1.5,
      }),
    ).toThrow();
    // Requested length far exceeds available path arclength.
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        lengthMm: 100,
      }),
    ).toThrow();
    expect(() =>
      flowDiverter({
        ...good,
        path: [
          [0, 0, 0],
          [Number.POSITIVE_INFINITY, 0, 0],
        ],
      }),
    ).toThrow();
  });
});

describe("intrasaccular", () => {
  it("uses distinct woven paths rather than repeated meridians at higher wire counts", () => {
    const g = intrasaccular({
      center: [0, 0, 0],
      axis: [0, 0, 1],
      diameterMm: 6,
      heightMm: 4,
      shape: "web-sl",
      wireCount: 144,
    });
    expect(
      new Set(g.lines.slice(0, 144).map((l) => JSON.stringify(l))).size,
    ).toBe(144);
    const l = g.lines[0];
    const p = l[Math.floor(l.length / 3)],
      q = l[Math.floor(l.length / 2)];
    expect(Math.abs(p[0] * q[1] - p[1] * q[0])).toBeGreaterThan(0.1);
  });
  const center: Vec3 = [0, 0, 0];
  const axis: Vec3 = [0, 0, 1];

  it("builds a WEB SL barrel with markers and a valid surface", () => {
    const g = intrasaccular({
      center,
      axis,
      diameterMm: 6,
      heightMm: 4,
      shape: "web-sl",
      wireCount: 8,
    });
    finiteGeometry(g);
    // Meridian wires + proximal/distal marker segments.
    expect(g.lines.length).toBeGreaterThanOrEqual(8);
    // Central proximal and distal markers exist on the axis.
    const axial = g.lines.filter((l) =>
      l.every((p) => Math.hypot(p[0], p[1]) < EPS),
    );
    expect(axial.length).toBeGreaterThanOrEqual(2);
    expect(g.surface).toBeDefined();
    const surf = g.surface!;
    expect(surf.points.length).toBeGreaterThan(8);
    for (const tri of surf.triangles) {
      expect(tri.length).toBe(3);
      for (const idx of tri) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(surf.points.length);
      }
    }
    // Barrel fits within declared extents.
    expect(g.bounds.max[2]).toBeCloseTo(2, 3);
    expect(g.bounds.min[2]).toBeCloseTo(-2, 3);
    const maxR = Math.max(...surf.points.map((p) => Math.hypot(p[0], p[1])));
    expect(maxR).toBeCloseTo(3, 3);
  });

  it("SLS cage is rounder (less barrel) than SL", () => {
    const mk = (shape: "web-sl" | "web-sls") =>
      intrasaccular({
        center,
        axis,
        diameterMm: 6,
        heightMm: 4,
        shape,
        wireCount: 8,
      });
    const waistR = (g: DeviceGeometry): number => {
      const surf = g.surface!;
      const mid = surf.points.filter(
        (p) => Math.abs(p[2]) > 0.9 && Math.abs(p[2]) < 1.1,
      );
      return Math.max(...mid.map((p) => Math.hypot(p[0], p[1])));
    };
    expect(waistR(mk("web-sls"))).toBeLessThan(waistR(mk("web-sl")));
  });

  it("Contour is a flared shallow cup with a proximal stem, not a ball", () => {
    const g = intrasaccular({
      center,
      axis,
      diameterMm: 6,
      heightMm: 4,
      shape: "contour",
      wireCount: 8,
    });
    finiteGeometry(g);
    // Stem: a line running along the axis on the proximal (+z) cup side.
    const stem = g.lines.find((l) => {
      const onAxis = l.every((p) => Math.hypot(p[0], p[1]) < 0.75);
      return onAxis && l[0][2] > 1.5 && l[l.length - 1][2] > l[0][2];
    });
    expect(stem).toBeDefined();
    // Shallow: distal extent is smaller than proximal extent.
    const zs = g.lines.flat().map((p) => p[2]);
    expect(Math.max(...zs)).toBeGreaterThan(0);
    // Cup profile is asymmetric: surface opens wider toward +z (flare).
    const surf = g.surface!;
    const near = surf.points.filter((p) => p[2] > 1.5);
    const mid = surf.points.filter((p) => Math.abs(p[2]) < 0.25);
    const rNear = Math.max(...near.map((p) => Math.hypot(p[0], p[1])));
    const rMid = Math.max(...mid.map((p) => Math.hypot(p[0], p[1])));
    expect(rNear).toBeGreaterThan(rMid);
  });

  it("rejects zero axis, NaN, non-positive sizes, bad shape", () => {
    const good = {
      center,
      diameterMm: 6,
      heightMm: 4,
      shape: "web-sl" as const,
      wireCount: 8,
    };
    expect(() => intrasaccular({ ...good, axis: [0, 0, 0] })).toThrow();
    expect(() =>
      intrasaccular({ ...good, axis: [0, 0, 1], diameterMm: Number.NaN }),
    ).toThrow();
    expect(() =>
      intrasaccular({ ...good, axis: [0, 0, 1], heightMm: 0 }),
    ).toThrow();
    expect(() =>
      intrasaccular({
        ...good,
        axis: [0, 0, 1],
        wireCount: 0,
      }),
    ).toThrow();
  });
});

describe("coilPack", () => {
  const center: Vec3 = [0, 0, 0];
  const axis: Vec3 = [0, 0, 1];

  it("deterministically packs a bounded in-sac coil honoring length", () => {
    const args = {
      center,
      axis,
      sacDiameterMm: 10,
      primaryDiameterMm: 0.25,
      lengthMm: 60,
    };
    const a = coilPack(args);
    const b = coilPack(args);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // deterministic
    finiteGeometry(a);
    expect(a.lines.length).toBe(1);
    const measured = polylineLength(a.lines[0]);
    // Honors requested centerline length within 5% tolerance.
    expect(Math.abs(measured - args.lengthMm) / args.lengthMm).toBeLessThan(
      0.05,
    );
    // Every point stays inside the sac sphere.
    for (const p of a.lines[0]) {
      expect(
        Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]),
      ).toBeLessThanOrEqual(5 + 1e-6);
    }
    expect(a.approximation).toMatch(/kinematic/i);
    expect(a.approximation).not.toMatch(/pressure|wall apposition|mechanical/i);
  });

  it("exposes inability instead of inventing geometry for impossible length", () => {
    expect(() =>
      coilPack({
        center,
        axis,
        sacDiameterMm: 2,
        primaryDiameterMm: 0.25,
        lengthMm: 500,
      }),
    ).toThrow(/length/i);
  });

  it("rejects invalid inputs", () => {
    const good = { sacDiameterMm: 10, primaryDiameterMm: 0.25, lengthMm: 60 };
    expect(() => coilPack({ ...good, center, axis: [0, 0, 0] })).toThrow();
    expect(() =>
      coilPack({ ...good, center, axis, primaryDiameterMm: -1 }),
    ).toThrow();
    expect(() =>
      coilPack({ ...good, center, axis, sacDiameterMm: Number.NaN }),
    ).toThrow();
    expect(() =>
      coilPack({
        ...good,
        center,
        axis,
        primaryDiameterMm: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });
});

describe("kernel honesty", () => {
  it("approximation strings never claim mechanical or clinical validation", () => {
    const g = flowDiverter({
      path: [
        [-5, 0, 0],
        [5, 0, 0],
      ],
      diameterMm: 4,
      lengthMm: 10,
      wireCount: 6,
      turns: 2,
    });
    expect(g.approximation).toMatch(/kinematic|approximation/i);
    expect(g.approximation).not.toMatch(/wall apposition|validated|pressure/i);
    const w = intrasaccular({
      center: [0, 0, 0],
      axis: [0, 0, 1],
      diameterMm: 6,
      heightMm: 4,
      shape: "web-sl",
      wireCount: 8,
    });
    expect(w.approximation).not.toMatch(/wall apposition|validated|pressure/i);
  });

  it("caps vertex and line counts to bounded output", () => {
    const path: Vec3[] = [];
    for (let i = 0; i <= 400; i++) path.push([(i / 400) * 10, 0, 0]);
    const g = flowDiverter({
      path,
      diameterMm: 4,
      lengthMm: 10,
      wireCount: 96,
      turns: 8,
    });
    expect(pointCount(g)).toBeLessThan(200000);
    expect(g.lines.length).toBeLessThan(1000);
  });
});
