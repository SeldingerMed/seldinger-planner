import { describe, expect, it } from "vitest";
import {
  BONE_LINEUP,
  BONE_LINEUP_BIPLANE_METHOD,
  BONE_LINEUP_METHOD,
  boneSamples,
  createBoneLineupJob,
  proposeBoneLineup,
  type BoneFrameInput,
  type BoneVolume,
} from "./boneLineup";
import { camera, project, type ViewNumbers } from "./carmGeometry";

const N = 48,
  MM = 2;
const AFFINE = [
  [MM, 0, 0, (-(N - 1) * MM) / 2],
  [0, MM, 0, (-(N - 1) * MM) / 2],
  [0, 0, MM, (-(N - 1) * MM) / 2],
  [0, 0, 0, 1],
];

/** Three stacked blocks, each with a pedicle bar, a spinous bar reaching
 * back and a transverse bar reaching to one side, so no mirror or turn maps
 * the shape onto itself and every turn moves something a frame can see;
 * soft tissue around them. */
function phantom(): BoneVolume {
  const data = new Int16Array(N * N * N);
  const set = (
    x: [number, number],
    y: [number, number],
    z: [number, number],
    hu: number,
  ) => {
    for (let k = z[0]; k < z[1]; k++)
      for (let j = y[0]; j < y[1]; j++)
        for (let i = x[0]; i < x[1]; i++) data[i + N * (j + N * k)] = hu;
  };
  set([6, 42], [8, 40], [4, 44], 40);
  for (const [at, wide] of [
    [6, 9],
    [19, 8],
    [31, 10],
  ]) {
    set([24 - wide, 24 + wide], [22, 34], [at, at + 9], 700);
    set([24 - wide, 24 - wide + 4], [14, 22], [at + 2, at + 6], 900);
    set([22, 25], [9, 22], [at + 1, at + 4], 900);
    set([24 + wide, 24 + wide + 8], [25, 28], [at + 5, at + 8], 800);
  }
  return { data, shape: [N, N, N], affine: AFFINE };
}

const view = (primary_deg: number): ViewNumbers => ({
  primary_deg,
  secondary_deg: 0,
  source_detector_mm: 1140,
  source_isocenter_mm: 745,
  detector_width_mm: 306,
  detector_height_mm: 306,
});

const rad = Math.PI / 180;
/** Volume RAS to C-arm RAS: turns about z then x, then a shift. */
function rigid(z_deg: number, x_deg: number, shift: number[]): number[][] {
  const cz = Math.cos(z_deg * rad),
    sz = Math.sin(z_deg * rad),
    cx = Math.cos(x_deg * rad),
    sx = Math.sin(x_deg * rad);
  const rz = [
      [cz, -sz, 0],
      [sz, cz, 0],
      [0, 0, 1],
    ],
    rx = [
      [1, 0, 0],
      [0, cx, -sx],
      [0, sx, cx],
    ];
  const r = rx.map((row) =>
    [0, 1, 2].map(
      (j) => row[0] * rz[0][j] + row[1] * rz[1][j] + row[2] * rz[2][j],
    ),
  );
  return [...r.map((row, i) => [...row, shift[i]]), [0, 0, 0, 1]];
}
const move = (m: number[][], p: number[]) =>
  [0, 1, 2].map(
    (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3],
  );

/** A frame made apart from the engine: every voxel above air, soft tissue
 * included, dropped on the nearest pixel and weighted so that a pixel holds
 * the beam's path through the scan, then turned into what a detector
 * reads. */
function render(
  volume: BoneVolume,
  pose: number[][],
  v: ViewNumbers,
  side = 256,
): BoneFrameInput {
  const [nx, ny, nz] = volume.shape,
    cam = camera(v, [0, 0, 0]),
    sum = new Float64Array(side * side);
  // Each voxel is spread over 27 points, so the picture has no grid in it.
  const parts = [-1 / 3, 0, 1 / 3];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const hu = volume.data[i + nx * (j + ny * k)];
        if (hu <= 0) continue;
        for (const c of parts)
          for (const b of parts)
            for (const a of parts) {
              const world = move(
                pose,
                move(volume.affine, [i + a, j + b, k + c]),
              );
              const [x, y, depth] = project(cam, world);
              const px = Math.round(
                  (x / v.detector_width_mm + 0.5) * side - 0.5,
                ),
                py = Math.round((0.5 - y / v.detector_height_mm) * side - 0.5);
              if (px >= 0 && px < side && py >= 0 && py < side)
                sum[py * side + px] += (hu / 27) * (depth / 745) ** 2;
            }
      }
  const pixels = new Uint16Array(side * side);
  for (let i = 0; i < sum.length; i++) {
    pixels[i] = 60000 * Math.exp(-sum[i] / 9000);
  }
  return { view: v, isocenter: [0, 0, 0], pixels, width: side, height: side };
}

const TARGETS = [-30, 0, 30].flatMap((x) =>
  [-30, 0, 30].flatMap((y) => [-30, 0, 30].map((z) => [x, y, z])),
);
/** Mean distance between where two poses put the targets; with `beam`, only
 * the part across that direction. */
function apart(a: number[][], b: number[][], beam?: readonly number[]) {
  let sum = 0;
  for (const t of TARGETS) {
    const p = move(a, t),
      q = move(b, t),
      d = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    if (beam) {
      const along = d[0] * beam[0] + d[1] * beam[1] + d[2] * beam[2];
      for (let i = 0; i < 3; i++) d[i] -= along * beam[i];
    }
    sum += Math.hypot(...d);
  }
  return sum / TARGETS.length;
}
const IDENTITY = rigid(0, 0, [0, 0, 0]);
const TRUE = rigid(4, 3, [6, -4, 10]);

/** A scan far longer than a frame shows: 480 mm of blocks, no two alike. */
function longSpine(): BoneVolume {
  const nz = 240,
    data = new Int16Array(N * N * nz);
  const set = (x: number[], y: number[], z: number[], hu: number) => {
    for (let k = z[0]; k < z[1]; k++)
      for (let j = y[0]; j < y[1]; j++)
        for (let i = x[0]; i < x[1]; i++) data[i + N * (j + N * k)] = hu;
  };
  for (let at = 4, n = 0; at + 12 < nz; n++) {
    const wide = 7 + ((n * 5) % 4),
      tall = 8 + ((n * 3) % 4);
    set([24 - wide, 24 + wide], [22, 34], [at, at + tall], 700);
    set([24 - wide, 24 - wide + 4], [14, 22], [at + 2, at + 6], 900);
    set([22, 25], [9, 22], [at + 1, at + 4], 900);
    if (n % 2) set([24 + wide, 24 + wide + 8], [25, 28], [at + 5, at + 8], 800);
    at += tall + 3 + (n % 3);
  }
  return {
    data,
    shape: [N, N, nz],
    affine: [
      [MM, 0, 0, (-(N - 1) * MM) / 2],
      [0, MM, 0, (-(N - 1) * MM) / 2],
      [0, 0, MM, (-(nz - 1) * MM) / 2],
      [0, 0, 0, 1],
    ],
  };
}

describe("boneSamples", () => {
  it("keeps bone above the threshold, weighted by how far above, in volume RAS", () => {
    const volume = phantom(),
      samples = boneSamples(volume);
    let bone = 0;
    for (const hu of volume.data) if (hu > BONE_LINEUP.threshold_hu) bone++;
    expect(samples.weights.length).toBe(bone);
    expect(samples.points.length).toBe(3 * bone);
    expect(Math.min(...samples.weights)).toBe(700 - BONE_LINEUP.threshold_hu);
    expect(Math.max(...samples.weights)).toBe(900 - BONE_LINEUP.threshold_hu);
    // Every sample lies inside the blocks' extent, in millimeters.
    for (let i = 0; i < samples.points.length; i += 3) {
      expect(samples.points[i]).toBeGreaterThanOrEqual(-21);
      expect(samples.points[i]).toBeLessThanOrEqual(37);
      expect(samples.points[i + 1]).toBeGreaterThanOrEqual(-29);
      expect(samples.points[i + 1]).toBeLessThanOrEqual(21);
    }
  });

  it("thins a fine scan to the working grid", () => {
    const fine = phantom();
    fine.affine = AFFINE.map((row, i) => (i < 3 ? row.map((v) => v / 2) : row));
    const coarse = boneSamples(phantom()).weights.length;
    // 1 mm voxels on a 2 mm grid: an eighth of the voxels, to within the
    // blocks' odd edges.
    const kept = boneSamples(fine).weights.length;
    expect(kept).toBeGreaterThan(coarse / 12);
    expect(kept).toBeLessThan(coarse / 5);
  });

  it("leaves out bone marked as moving against the rest", () => {
    const volume = phantom(),
      moving = new Uint8Array(volume.data.length);
    let bone = 0,
      marked = 0;
    for (let i = 0; i < volume.data.length; i++) {
      if (!(volume.data[i] > BONE_LINEUP.threshold_hu)) continue;
      bone++;
      if (i % 3 === 0) {
        moving[i] = 5;
        marked++;
      }
    }
    expect(marked).toBeGreaterThan(0);
    expect(boneSamples({ ...volume, moving }).weights.length).toBe(
      bone - marked,
    );
    expect(() =>
      boneSamples({ ...volume, moving: moving.subarray(1) }),
    ).toThrow("Marked bone does not match the scan");
  });

  it("refuses a scan with no bone to line up on", () => {
    const empty = phantom();
    empty.data.fill(40);
    expect(() => boneSamples(empty)).toThrow("Too little bone in the scan");
    expect(() => boneSamples({ ...phantom(), shape: [N, N, N - 1] })).toThrow(
      "Scan does not match its shape",
    );
  });
});

describe("proposeBoneLineup", () => {
  const volume = phantom(),
    samples = boneSamples(volume);

  it("finds the pose of the bone from a front and a side frame", () => {
    const frames = [
      render(volume, TRUE, view(0)),
      render(volume, TRUE, view(90)),
    ];
    expect(apart(IDENTITY, TRUE)).toBeGreaterThan(10);
    const found = proposeBoneLineup({ samples, frames, start: IDENTITY });
    expect(found.method).toBe(BONE_LINEUP_BIPLANE_METHOD);
    expect(apart(found.matrix, TRUE)).toBeLessThan(1.5);
    expect(found.score).toBeGreaterThan(found.start_score);
    expect(found.frame_scores).toHaveLength(2);
    expect(found.point_count).toBe(samples.weights.length);
    expect(found.translation_mm).toBeGreaterThan(8);
    expect(found.rotation_deg).toBeGreaterThan(3);
    // The same input gives the same proposal.
    expect(
      proposeBoneLineup({ samples, frames, start: IDENTITY }).matrix,
    ).toEqual(found.matrix);
  }, 120_000);

  it("comes back from a start one vertebra off", () => {
    // The blocks repeat every 25 mm or so: a start that far along the spine
    // has a neighbor's edges under every block.
    const frames = [
      render(volume, TRUE, view(0)),
      render(volume, TRUE, view(90)),
    ];
    for (const along of [26, -24]) {
      const start = rigid(4, 3, [6, -4, 10 + along]);
      const found = proposeBoneLineup({ samples, frames, start });
      expect(apart(found.matrix, TRUE)).toBeLessThan(1.5);
    }
    // Farther off, nothing of the start lies in the right place: the search
    // has to look along the frame before it descends.
    const beam = camera(view(0), [0, 0, 0]).d;
    for (const along of [45, -45]) {
      const front = proposeBoneLineup({
        samples,
        frames: frames.slice(0, 1),
        start: rigid(4, 3, [6, -4, 10 + along]),
      });
      expect(apart(front.matrix, TRUE, beam)).toBeLessThan(1.5);
    }
  }, 120_000);

  it("lines up a scan much longer than the frames show", () => {
    // An abdominal CT against a 100 mm field: a fifth of the bone is in
    // the picture. What counts is the bone in the frame, not its share.
    const long = longSpine(),
      some = boneSamples(long),
      small = (primary_deg: number) => ({
        ...view(primary_deg),
        detector_width_mm: 150,
        detector_height_mm: 150,
      });
    const frames = [
      render(long, TRUE, small(0)),
      render(long, TRUE, small(90)),
    ];
    const found = proposeBoneLineup({ samples: some, frames, start: IDENTITY });
    expect(apart(found.matrix, TRUE)).toBeLessThan(1.5);
  }, 120_000);

  it("lines up on the bone that holds still when a marked bone has moved", () => {
    // A femur turns at the hip between the scan and the procedure. Marked,
    // it is left out; the rest decides the pose.
    const scan = phantom(),
      later = phantom(),
      moving = new Uint8Array(scan.data.length);
    const bar = (into: BoneVolume, y: number, z: number, mark: boolean) => {
      for (let k = z; k < z + 26; k++)
        for (let j = y; j < y + 6; j++)
          for (let i = 2; i < 7; i++) {
            const at = i + N * (j + N * k);
            expect(into.data[at]).toBeLessThan(BONE_LINEUP.threshold_hu);
            into.data[at] = 800;
            if (mark) moving[at] = 1;
          }
    };
    bar(scan, 38, 4, true);
    bar(later, 30, 14, false);
    const frames = [
      render(later, TRUE, view(0)),
      render(later, TRUE, view(90)),
    ];
    const found = proposeBoneLineup({
      samples: boneSamples({ ...scan, moving }),
      frames,
      start: IDENTITY,
    });
    expect(apart(found.matrix, TRUE)).toBeLessThan(1.5);
  }, 120_000);

  it("is not moved by a frame size its working picture does not divide", () => {
    // 180 pixels onto a 128-pixel working picture: averaging whole pixels
    // only would set the frame half a pixel off, 0.6 mm at the bone.
    const volume = phantom(),
      samples = boneSamples(volume),
      cam = camera(view(0), [0, 0, 0]);
    for (const shift of [
      [0.3, 0, 0.3],
      [-5.2, 1, 4.4],
    ]) {
      const truth = rigid(0, 0, shift);
      const found = proposeBoneLineup({
        samples,
        frames: [render(volume, truth, view(0), 180)],
        start: truth,
      });
      expect(apart(found.matrix, truth, cam.d)).toBeLessThan(0.35);
    }
  }, 120_000);

  it("searches the frame nearer the front first, whichever way they come", () => {
    const front = render(volume, TRUE, view(0)),
      side = render(volume, TRUE, view(90));
    const one = proposeBoneLineup({
        samples,
        frames: [front, side],
        start: IDENTITY,
      }),
      other = proposeBoneLineup({
        samples,
        frames: [side, front],
        start: IDENTITY,
      });
    expect(other.matrix).toEqual(one.matrix);
    expect(other.frame_scores).toEqual([
      one.frame_scores[1],
      one.frame_scores[0],
    ]);
  }, 120_000);

  it("refuses one frame from the side", () => {
    // Measured: one frame up to 37 degrees off the front places the bone; a
    // side frame alone does not. The limit is set between, at 60 degrees.
    const from = (primary_deg: number) =>
      proposeBoneLineup({
        samples,
        frames: [render(volume, TRUE, view(primary_deg), 64)],
        start: IDENTITY,
      });
    expect(() => from(90)).toThrow(
      "A frame from the side does not place the bone alone",
    );
    expect(() => from(-70)).toThrow(
      "A frame from the side does not place the bone alone",
    );
    expect(from(40).method).toBe(BONE_LINEUP_METHOD);
  }, 120_000);

  it("with one frame, places the bone across the beam", () => {
    const frames = [render(volume, TRUE, view(0))];
    const found = proposeBoneLineup({ samples, frames, start: IDENTITY });
    expect(found.method).toBe(BONE_LINEUP_METHOD);
    expect(found.frame_scores).toHaveLength(1);
    const beam = camera(view(0), [0, 0, 0]).d;
    expect(apart(found.matrix, TRUE, beam)).toBeLessThan(1.5);
  }, 120_000);

  it("runs in slices and gives the one-shot answer", () => {
    const frames = [render(volume, TRUE, view(0), 128)];
    const job = createBoneLineupJob({ samples, frames, start: IDENTITY });
    expect(() => job.result()).toThrow("Line-up is not complete");
    let slices = 0;
    while (!job.advance(() => true)) slices++;
    expect(slices).toBeGreaterThan(3);
    expect(job.result().matrix).toEqual(
      proposeBoneLineup({ samples, frames, start: IDENTITY }).matrix,
    );
  }, 120_000);

  it("refuses what it cannot line up", () => {
    const frame = render(volume, TRUE, view(0), 64);
    const input = { samples, frames: [frame], start: IDENTITY };
    expect(() => proposeBoneLineup({ ...input, frames: [] })).toThrow(
      "One or two frames are required",
    );
    expect(() =>
      proposeBoneLineup({
        ...input,
        frames: [frame, { ...frame, view: view(5) }],
      }),
    ).toThrow("The two frames are too close to parallel");
    expect(() =>
      proposeBoneLineup({
        ...input,
        frames: [{ ...frame, pixels: new Uint16Array(10) }],
      }),
    ).toThrow("Frame does not match its size");
    expect(() =>
      proposeBoneLineup({
        ...input,
        frames: [{ ...frame, pixels: new Uint16Array(64 * 64).fill(7) }],
      }),
    ).toThrow("Frame shows nothing to line up on");
    expect(() => proposeBoneLineup({ ...input, start: [[1]] })).toThrow(
      "Rigid transform must be a finite 4×4 matrix",
    );
    // Bone that starts outside the picture cannot be scored.
    expect(() =>
      proposeBoneLineup({ ...input, start: rigid(0, 0, [400, 0, 0]) }),
    ).toThrow("The bone is not in the frame at the starting pose");
  });
});

describe("bone line-up from a population of starts", () => {
  // Step D part 1, acceptance criterion 2: from starts up to 10 mm and 10
  // degrees from the true pose, at least 90 percent of proposals come back
  // within 1 mm mean target error with two frames, and within 1 mm across
  // the beam with one.
  const volume = phantom(),
    samples = boneSamples(volume),
    frames = [render(volume, TRUE, view(0)), render(volume, TRUE, view(90))],
    beam = camera(view(0), [0, 0, 0]).d;
  let state = 20261122;
  const draw = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  };
  /** A start a random direction and distance (up to `mm`) from the true
   * pose, turned about z and x by up to `deg` in all. */
  const start = (mm: number, deg: number) => {
    let d = [draw(), draw(), draw()];
    while (Math.hypot(...d) > 1) d = [draw(), draw(), draw()];
    const turn = [draw(), draw()].map((v) => (v * deg) / Math.SQRT2);
    return rigid(4 + turn[0], 3 + turn[1], [
      6 + mm * d[0],
      -4 + mm * d[1],
      10 + mm * d[2],
    ]);
  };
  const RUNS = 10;

  it("two frames: at least 90 percent within 1 mm", () => {
    const errors = Array.from({ length: RUNS }, () =>
      apart(
        proposeBoneLineup({ samples, frames, start: start(10, 10) }).matrix,
        TRUE,
      ),
    );
    expect(errors.filter((mm) => mm < 1).length).toBeGreaterThanOrEqual(
      0.9 * RUNS,
    );
  }, 300_000);

  it("one frame: at least 90 percent within 1 mm across the beam", () => {
    const errors = Array.from({ length: RUNS }, () =>
      apart(
        proposeBoneLineup({
          samples,
          frames: frames.slice(0, 1),
          start: start(10, 10),
        }).matrix,
        TRUE,
        beam,
      ),
    );
    expect(errors.filter((mm) => mm < 1).length).toBeGreaterThanOrEqual(
      0.9 * RUNS,
    );
  }, 300_000);
});
