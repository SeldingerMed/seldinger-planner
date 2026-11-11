/** Exact Euclidean distance transforms (Felzenszwalb and Huttenlocher) for
 * the projection-registration target and the vessel-mask medial points. */

const FAR = 1e20;

/** One lower-envelope pass along a line of `n` samples spaced `spacing`
 * apart. `f` holds squared distances so far; `d` receives the result.
 * `v` needs `n` entries and `z` needs `n + 1`. */
export function edt1d(
  f: Float64Array,
  n: number,
  spacing: number,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    const xq = q * spacing;
    let s = 0;
    for (;;) {
      const xp = v[k] * spacing;
      s = (f[q] + xq * xq - (f[v[k]] + xp * xp)) / (2 * (xq - xp));
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    const xq = q * spacing;
    while (z[k + 1] < xq) k++;
    const delta = xq - v[k] * spacing;
    d[q] = delta * delta + f[v[k]];
  }
}

/** Distance in pixels from every pixel to the nearest nonzero seed pixel,
 * capped at `cap`. With no seed every pixel reads `cap`. */
export function distanceToSeeds(
  seeds: Uint8Array,
  width: number,
  height: number,
  cap: number,
): Float32Array {
  if (seeds.length !== width * height) throw new Error("Invalid seed grid");
  const n = Math.max(width, height);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    v = new Int32Array(n),
    z = new Float64Array(n + 1);
  const squared = new Float64Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = seeds[y * width + x] ? 0 : FAR;
    edt1d(f, height, 1, d, v, z);
    for (let y = 0; y < height; y++) squared[y * width + x] = d[y];
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = squared[y * width + x];
    edt1d(f, width, 1, d, v, z);
    for (let x = 0; x < width; x++)
      out[y * width + x] = Math.min(cap, Math.sqrt(d[x]));
  }
  return out;
}

/** In place: squared millimeter distance from every voxel of a box to the
 * nearest voxel whose entry is 0. Entries that are not 0 must start at
 * `FAR_SQUARED`. Yields between the three axis passes. */
export const FAR_SQUARED = FAR;
export function* squaredDistanceInBox(
  field: Float32Array,
  shape: readonly [number, number, number],
  spacing: readonly [number, number, number],
): Generator<void, void> {
  const [nx, ny, nz] = shape;
  if (field.length !== nx * ny * nz) throw new Error("Invalid distance box");
  const n = Math.max(nx, ny, nz);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    v = new Int32Array(n),
    z = new Float64Array(n + 1);
  const strides = [1, nx, nx * ny];
  for (let axis = 0; axis < 3; axis++) {
    const len = shape[axis],
      stride = strides[axis],
      a = (axis + 1) % 3,
      b = (axis + 2) % 3;
    for (let j = 0; j < shape[b]; j++) {
      for (let i = 0; i < shape[a]; i++) {
        const base = i * strides[a] + j * strides[b];
        for (let q = 0; q < len; q++) f[q] = field[base + q * stride];
        edt1d(f, len, spacing[axis], d, v, z);
        for (let q = 0; q < len; q++) field[base + q * stride] = d[q];
      }
      if ((j & 15) === 15) yield;
    }
    yield;
  }
}
