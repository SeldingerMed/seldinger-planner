/** Bounded native-volume CPR and parallel-transport frame tests (phase4 contract). */
import { expect, test } from "vitest";
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { buildPathFrames, pointAlongPath, sampleCPR } from "./curvedPlanar";

// Analytic ramp: voxel value = x + 2y + 4z; world = diag(2,3,4) * voxel + (10,-5,7).
function volume() {
  const nx = 4,
    ny = 5,
    nz = 6;
  const img = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        img[x + nx * (y + ny * z)] = x + 2 * y + 4 * z;
  return {
    img,
    hdr: {
      dims: [3, nx, ny, nz, 1, 1, 1, 1],
      xyzt_units: 2,
      datatypeCode: 16,
      scl_slope: 1,
      scl_inter: 0,
    },
    getAffine: () => [
      [2, 0, 0, 10],
      [0, 3, 0, -5],
      [0, 0, 4, 7],
      [0, 0, 0, 1],
    ],
  } as unknown as NVImage;
}
/** Expected ramp intensity at a world point (trilinear interpolant of the ramp). */
function intensityAt(p: Vec3): number {
  const vx = (p[0] - 10) / 2,
    vy = (p[1] + 5) / 3,
    vz = (p[2] - 7) / 4;
  return vx + 2 * vy + 4 * vz;
}
const near = (a: Vec3 | number[], b: Vec3 | number[], tol = 1e-9) => {
  expect(a.length).toBe(3);
  a.forEach((c, i) => expect(c).toBeCloseTo(b[i], tol < 1e-7 ? 9 : undefined));
};
const unit = (a: Vec3) =>
  Math.hypot(a[0], a[1], a[2]) === 0 ||
  expect(Math.hypot(a[0], a[1], a[2])).toBeCloseTo(1, 9);

const straight: Vec3[] = [
  [10, -4, 7],
  [16, -4, 7],
];
const kinked: Vec3[] = [
  [10, -5, 7],
  [13, -5, 7],
  [13, -2, 7],
];

test("straight path frames: exact length, constant tangent, initial transverse frame, linear s_mm", () => {
  const { frames, length_mm } = buildPathFrames(straight, 4);
  expect(length_mm).toBeCloseTo(6, 9);
  expect(frames.length).toBe(4);
  frames.forEach((f, i) => {
    expect(f.s_mm).toBeCloseTo(((i + 0.5) / 4) * 6, 9);
    near(f.point, [10 + f.s_mm, -4, 7]);
    near(f.tangent, [1, 0, 0]);
    near(f.u, [0, 1, 0]);
    near(f.v, [0, 0, 1]);
    [f.tangent, f.u, f.v].forEach(unit);
    const cross = [
      f.u[1] * f.v[2] - f.u[2] * f.v[1],
      f.u[2] * f.v[0] - f.u[0] * f.v[2],
      f.u[0] * f.v[1] - f.u[1] * f.v[0],
    ];
    near(cross, f.tangent); // right-handed
  });
});

test("polygonal arc-length interpolation without spline overshoot", () => {
  const f = pointAlongPath(kinked, 4.5);
  expect(f.s_mm).toBeCloseTo(4.5, 9);
  near(f.point, [13, -3.5, 7]);
  near(f.tangent, [0, 1, 0]);
  const start = pointAlongPath(kinked, 0);
  near(start.point, [10, -5, 7]);
  near(start.tangent, [1, 0, 0]);
  near(start.u, [0, 1, 0]);
  near(start.v, [0, 0, 1]);
  expect(pointAlongPath(kinked, 6).s_mm).toBeCloseTo(6, 9);
});

test("roll rotates the transverse frame about the tangent deterministically", () => {
  const f = pointAlongPath(straight, 3, 90);
  near(f.u, [0, 0, 1]);
  near(f.v, [0, -1, 0]);
  [f.tangent, f.u, f.v].forEach(unit);
  expect(pointAlongPath(straight, 3, -180).u[1]).toBeCloseTo(-1, 9);
});

test("frames stay orthonormal and continuous along a curved 3D path", () => {
  const pts: Vec3[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    pts.push([10 + 6 * Math.cos(a), -5, 7 + 6 * Math.sin(a)]);
  }
  const { frames, length_mm } = buildPathFrames(pts, 64);
  expect(length_mm).toBeGreaterThan(9);
  expect(length_mm).toBeLessThan(6.2833 * 1.5);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    [f.tangent, f.u, f.v].forEach(unit);
    const dott = (a: Vec3) =>
      a[0] * f.tangent[0] + a[1] * f.tangent[1] + a[2] * f.tangent[2];
    expect(dott(f.u)).toBeCloseTo(0, 9);
    expect(dott(f.v)).toBeCloseTo(0, 9);
    if (i > 0) {
      const prev = frames[i - 1];
      const dotUV =
        prev.u[0] * f.u[0] + prev.u[1] * f.u[1] + prev.u[2] * f.u[2];
      expect(dotUV).toBeGreaterThan(Math.cos((Math.PI / 180) * 10));
      expect(Math.abs(f.s_mm - prev.s_mm)).toBeGreaterThan(1e-8);
    }
  }
});

test("actual unresolved tangent reversal is rejected", () => {
  expect(() =>
    buildPathFrames(
      [
        [10, -5, 7],
        [13, -5, 7],
        [10, -5, 7],
      ],
      8,
    ),
  ).toThrow();
});

test("buildPathFrames validation rejects malformed input", () => {
  expect(() => buildPathFrames([[10, -5, 7]], 8)).toThrow();
  const far: Vec3[] = [];
  for (let i = 0; i < 128; i++) far.push([10 + i * 79, -5, 7]);
  expect(() => buildPathFrames(far, 8)).toThrow(); // length > 10000mm
  far.pop();
  expect(() => buildPathFrames(far, 257)).toThrow();
  expect(() => buildPathFrames(far, 1)).toThrow();
  expect(() => buildPathFrames(far, 8.5)).toThrow();
  expect(() =>
    buildPathFrames(
      [
        [10, -5, 7],
        [10, -5, 7],
      ],
      8,
    ),
  ).toThrow();
  expect(() =>
    buildPathFrames(
      [
        [10, -5, 7],
        [NaN, -5, 7],
      ],
      8,
    ),
  ).toThrow();
  expect(() => pointAlongPath(straight, 3, 181)).toThrow();
  expect(() => pointAlongPath(straight, 3, Infinity)).toThrow();
});

const opts = {
  mode: "straightened" as const,
  width_px: 4,
  height_px: 2,
  span_mm: 2,
  roll_degrees: 0,
  window: [0, 10] as [number, number],
};

test("sampleCPR straightened reproduces exact analytic ramp values; outside is transparent", () => {
  const out = sampleCPR(volume(), straight, opts);
  expect(out.width).toBe(4);
  expect(out.height).toBe(2);
  expect(out.length_mm).toBeCloseTo(6, 9);
  expect(out.rgba.length).toBe(4 * 4 * 2);
  for (let j = 0; j < 2; j++) {
    const off = ((j + 0.5) / 2 - 0.5) * 2; // -0.5 / +0.5 along transported u=[0,1,0]
    for (let i = 0; i < 4; i++) {
      const s = ((i + 0.5) / 4) * 6;
      const p: Vec3 = [10 + s, -4 + off, 7];
      const g = Math.max(0, Math.min(1, intensityAt(p) / 10)) * 255;
      const k = (j * 4 + i) * 4;
      // RGBA is a Uint8ClampedArray: expect the quantized byte, not the float.
      const gByte = new Uint8ClampedArray([g])[0];
      expect(Math.abs(out.rgba[k] - gByte)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.rgba[k + 1] - gByte)).toBeLessThanOrEqual(1);
      expect(Math.abs(out.rgba[k + 2] - gByte)).toBeLessThanOrEqual(1);
      expect(out.rgba[k + 3]).toBe(255);
    }
  }
  // Wide span sends the lower rows outside the native extent -> transparent.
  const wide = sampleCPR(volume(), straight, { ...opts, span_mm: 12 });
  let transparent = 0;
  for (let j = 0; j < 2; j++) {
    const off = ((j + 0.5) / 2 - 0.5) * 12;
    if (-5 + off < -5) {
      for (let i = 0; i < 4; i++) {
        const k = (j * 4 + i) * 4;
        expect(wide.rgba[k + 3]).toBe(0);
        transparent++;
      }
    }
  }
  expect(transparent).toBe(4);
});

test("stretched mode uses the fixed initial transverse direction, distinct from transported u", () => {
  const stretchedOpts = { ...opts, mode: "stretched" as const };
  const out = sampleCPR(volume(), kinked, stretchedOpts);
  const straightened = sampleCPR(volume(), kinked, opts);
  expect(Array.from(out.rgba)).not.toEqual(Array.from(straightened.rgba));
  // Second half of the kinked path: tangent +y, transported u = [-1,0,0], fixed u0 = [0,1,0].
  const L = 6;
  for (let i = 0; i < 4; i++) {
    const s = ((i + 0.5) / 4) * L;
    if (s <= 3) continue;
    const off = ((0 + 0.5) / 2 - 0.5) * 2; // j=0 -> -0.5
    const base = -5 + (s - 3); // second-segment vertex is (13,-5,7)
    const fixedP: Vec3 = [13, base + off, 7];
    const g = Math.max(0, Math.min(1, intensityAt(fixedP) / 10)) * 255;
    const k = i * 4;
    expect(Math.abs(out.rgba[k] - g)).toBeLessThanOrEqual(1);
    expect(out.rgba[k + 3]).toBe(255);
  }
});

test("frames and world sampling are gauge-consistent under a rigid rotation", () => {
  // The transverse frame gauge (initialU) is anchored to world axes, so it is
  // NOT equivariant under rotating the path: the transported u of a rotated
  // path lives in a rotated gauge. Tangents, however, are gauge-independent.
  // We assert: (a) tangent equivariance, (b) orthonormal right-handed frames
  // with roll consistency in both gauges, (c) exact world affine/point sampler
  // checks per configuration rather than a cross-gauge image equality.
  const a = [1, 2, -1];
  const c = Math.cos(0.7),
    s = Math.sin(0.7);
  const R = [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
  const rotVec = (w: Vec3): Vec3 => [
    R[0][0] * w[0] + R[0][1] * w[1] + R[0][2] * w[2],
    R[1][0] * w[0] + R[1][1] * w[1] + R[1][2] * w[2],
    R[2][0] * w[0] + R[2][1] * w[1] + R[2][2] * w[2],
  ];
  const linearVolume = (affine: number[][]) => {
    const nx = 4,
      ny = 5,
      nz = 6;
    const img = new Float32Array(nx * ny * nz);
    const world = (x: number, y: number, z: number) =>
      a[0] *
        (affine[0][0] * x +
          affine[0][1] * y +
          affine[0][2] * z +
          affine[0][3]) +
      a[1] *
        (affine[1][0] * x +
          affine[1][1] * y +
          affine[1][2] * z +
          affine[1][3]) +
      a[2] *
        (affine[2][0] * x + affine[2][1] * y + affine[2][2] * z + affine[2][3]);
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++)
          img[x + nx * (y + ny * z)] = world(x, y, z);
    return {
      img,
      hdr: {
        dims: [3, nx, ny, nz, 1, 1, 1, 1],
        xyzt_units: 2,
        datatypeCode: 16,
        scl_slope: 1,
        scl_inter: 0,
      },
      getAffine: () => affine,
    } as unknown as NVImage;
  };
  const baseAffine = [
    [2, 0, 0, 10],
    [0, 3, 0, -5],
    [0, 0, 4, 7],
    [0, 0, 0, 1],
  ];
  const rotAffine = [
    [2 * R[0][0], 3 * R[0][1], 4 * R[0][2], 10],
    [2 * R[1][0], 3 * R[1][1], 4 * R[1][2], -5],
    [2 * R[2][0], 3 * R[2][1], 4 * R[2][2], 7],
    [0, 0, 0, 1],
  ];
  // Path chosen so the linear field values sit mid-window in BOTH gauges.
  const pts: Vec3[] = [];
  for (let i = 0; i <= 6; i++)
    pts.push([11 + 0.6 * i, 1 + 0.3 * i, 8 + 0.5 * i]);
  const rot: Vec3[] = pts.map((p) => [
    10 + R[0][0] * (p[0] - 10) + R[0][1] * (p[1] + 5) + R[0][2] * (p[2] - 7),
    -5 + R[1][0] * (p[0] - 10) + R[1][1] * (p[1] + 5) + R[1][2] * (p[2] - 7),
    7 + R[2][0] * (p[0] - 10) + R[2][1] * (p[1] + 5) + R[2][2] * (p[2] - 7),
  ]);
  const fa = buildPathFrames(pts, 8).frames;
  const fb = buildPathFrames(rot, 8).frames;
  expect(fa.length).toBe(fb.length);
  fa.forEach((f, i) => {
    near(fb[i].tangent, rotVec(f.tangent)); // gauge-equivariant tangents
    // Both gauges: orthonormal, tangent-orthogonal, right-handed frames.
    for (const fr of [fa[i], fb[i]]) {
      [fr.tangent, fr.u, fr.v].forEach(unit);
      const dott = (x: Vec3) => dot3(x, fr.tangent);
      expect(dott(fr.u)).toBeCloseTo(0, 9);
      expect(dott(fr.v)).toBeCloseTo(0, 9);
      near(cross3(fr.u, fr.v), fr.tangent);
    }
  });
  // Roll consistency within each gauge: +90 degrees maps u onto v.
  const fa90 = buildPathFrames(pts, 8, 90).frames;
  const fb90 = buildPathFrames(rot, 8, 90).frames;
  fa.forEach((f, i) => {
    near(fa90[i].u, f.v, 1e-9);
    near(fb90[i].u, fb[i].v, 1e-9);
  });
  // Same transported geometry, so lengths agree across gauges.
  expect(buildPathFrames(rot, 8).length_mm).toBeCloseTo(
    buildPathFrames(pts, 8).length_mm,
    9,
  );
  // World sampler affine/point check: every pixel is the exact linear-field
  // value at the world point implied by that configuration's own frames.
  const opts2 = { ...opts, width_px: 8, height_px: 4 };
  for (const [affine, pth] of [
    [baseAffine, pts],
    [rotAffine, rot],
  ] as const) {
    const out = sampleCPR(linearVolume(affine), pth, opts2);
    const frames = buildPathFrames(pth, 8).frames;
    expect(out.outside).toBe(0);
    expect(out.length_mm).toBeCloseTo(buildPathFrames(pth, 8).length_mm, 9);
    for (let j = 0; j < 4; j++) {
      const off = ((j + 0.5) / 4 - 0.5) * 2;
      for (let i = 0; i < 8; i++) {
        const f = frames[i];
        const w: Vec3 = [
          f.point[0] + off * f.u[0],
          f.point[1] + off * f.u[1],
          f.point[2] + off * f.u[2],
        ];
        const val = a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
        const g = Math.max(0, Math.min(255, ((val - 0) / 10) * 255));
        const gByte = new Uint8ClampedArray([g])[0];
        const k = (j * 8 + i) * 4;
        expect(Math.abs(out.rgba[k] - gByte)).toBeLessThanOrEqual(1);
        expect(Math.abs(out.rgba[k + 1] - gByte)).toBeLessThanOrEqual(1);
        expect(Math.abs(out.rgba[k + 2] - gByte)).toBeLessThanOrEqual(1);
        expect(out.rgba[k + 3]).toBe(255);
      }
    }
  }
});

const dot3 = (x: Vec3, y: Vec3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
const cross3 = (x: Vec3, y: Vec3): Vec3 => [
  x[1] * y[2] - x[2] * y[1],
  x[2] * y[0] - x[0] * y[2],
  x[0] * y[1] - x[1] * y[0],
];

test("nonzero constant roll stays constant along a straight path (no accumulated spin)", () => {
  for (const roll of [30, 90, -120, 180]) {
    const { frames } = buildPathFrames(straight, 8, roll);
    const u0 = frames[0].u;
    frames.forEach((f) => {
      near(f.u, u0, 1e-9);
      near(f.point, [10 + f.s_mm, -4, 7], 1e-9);
    });
    // pointAlongPath must reproduce the build frame at the same arc length.
    const p = pointAlongPath(straight, frames[3].s_mm, roll);
    near(p.u, u0, 1e-9);
    near(p.point, frames[3].point, 1e-9);
    near(p.tangent, frames[3].tangent, 1e-9);
  }
});

test("pointAlongPath transports across every segment and matches build frames on a kinked path", () => {
  const { frames } = buildPathFrames(kinked, 6, 25);
  frames.forEach((f) => {
    const p = pointAlongPath(kinked, f.s_mm, 25);
    expect(p.s_mm).toBeCloseTo(f.s_mm, 9);
    near(p.point, f.point, 1e-9);
    near(p.tangent, f.tangent, 1e-9);
    near(p.u, f.u, 1e-9);
    near(p.v, f.v, 1e-9);
  });
  // Transport history is honored at any arc length, not reset per segment:
  // on the second (y-direction) segment the transported u is [-1,0,0].
  const late = pointAlongPath(kinked, 4.5, 0);
  near(late.u, [-1, 0, 0], 1e-9);
});

test("reversal hidden between coarse stations is still rejected", () => {
  // The 0.1mm back-step sits between station arc lengths for stations=2.
  const hidden: Vec3[] = [
    [10, -5, 7],
    [13, -5, 7],
    [12.9, -5, 7],
    [12.9, -2, 7],
  ];
  expect(() => buildPathFrames(hidden, 2)).toThrow();
  expect(() => buildPathFrames(hidden, 8)).toThrow();
  expect(() => pointAlongPath(hidden, 3.05)).toThrow();
});

test("window lower/upper bounds map to black/white; options are validated", () => {
  // First pixel: s=0.75, j=0 offset -0.5 along u=[0,1,0] from the straight path.
  const p0: Vec3 = [10.75, -4.5, 7];
  const half = sampleCPR(volume(), straight, {
    ...opts,
    window: [0, 2 * intensityAt(p0)],
  });
  // Uint8ClampedArray stores integers: 127.5 rounds to 128.
  expect(half.rgba[0]).toBe(128);
  const black = sampleCPR(volume(), straight, { ...opts, window: [100, 200] });
  expect(black.rgba[0]).toBe(0);
  const white = sampleCPR(volume(), straight, { ...opts, window: [-10, 0] });
  expect(white.rgba[0]).toBe(255);
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, width_px: 1 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, width_px: 257 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, height_px: 129 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, span_mm: 0 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, span_mm: 200.1 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, window: [5, 5] }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, window: [2, 1] }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, roll_degrees: 180.1 }),
  ).toThrow();
  expect(() =>
    sampleCPR(volume(), straight, { ...opts, mode: "bogus" as never }),
  ).toThrow();
});
