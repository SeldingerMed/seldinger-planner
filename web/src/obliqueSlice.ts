/** Display-only native CTA reslicing. Native buffer + native affine, never matRAS.
 * NiiVue's matRAS indexes reoriented voxels, whereas img retains native storage.
 * No segmentation, measurement definition, or clinical validity is implied.
 */
import type { NVImage } from "@niivue/niivue";
export type Vec3 = [number, number, number];
export type PlaneBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
export type ObliqueSlice = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  outside: number;
};

const finite = (n: number) => Number.isFinite(n);
export function planeBasis(normal: Vec3): [Vec3, Vec3] {
  if (normal.length !== 3 || !normal.every(finite))
    throw new Error("Invalid plane normal");
  const len = Math.hypot(...normal);
  if (!finite(len) || len <= 0) throw new Error("Invalid plane normal");
  const n = normal.map((v) => v / len) as Vec3;
  const ref: Vec3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: Vec3 = [
    ref[1] * n[2] - ref[2] * n[1],
    ref[2] * n[0] - ref[0] * n[2],
    ref[0] * n[1] - ref[1] * n[0],
  ];
  const ul = Math.hypot(...u);
  u = u.map((v) => v / ul) as Vec3;
  return [
    u,
    [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0],
    ],
  ];
}

function inverseNative(m: number[][]) {
  if (
    m.length !== 4 ||
    m.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(finite)) ||
    m[3].some((v, i) => v !== [0, 0, 0, 1][i])
  )
    throw new Error("Invalid native affine");
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!finite(det) || Math.abs(det) < 1e-12)
    throw new Error("Singular native affine");
  const inverse = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  if (!inverse.every((r) => r.every(finite)))
    throw new Error("Invalid native affine inverse");
  return (v: Vec3): Vec3 =>
    inverse.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) as Vec3;
}

export function sampleObliqueSlice(
  volume: NVImage,
  origin: Vec3,
  normal: Vec3,
  bounds: PlaneBounds,
  window: [number, number],
  resolution = 128,
): ObliqueSlice {
  const hdr = volume.hdr;
  const raw = volume.img;
  if (!hdr || (hdr.xyzt_units & 7) !== 2)
    throw new Error("Confirmed mm units required");
  if (![2, 4, 8, 16, 64, 256, 512, 768].includes(hdr.datatypeCode))
    throw new Error("Unsupported scalar datatype");
  const dims = hdr.dims;
  if (
    dims[0] !== 3 ||
    dims.slice(4).some((n) => n > 1) ||
    dims.slice(1, 4).some((n) => !Number.isInteger(n) || n < 1 || n > 2048)
  )
    throw new Error("Only native 3D scalar volumes supported");
  const [nx, ny, nz] = dims.slice(1, 4);
  const count = nx * ny * nz;
  if (!finite(count) || count > 8_000_000)
    throw new Error("Native source exceeds voxel cap");
  if (
    !(
      raw instanceof Uint8Array ||
      raw instanceof Int8Array ||
      raw instanceof Int16Array ||
      raw instanceof Uint16Array ||
      raw instanceof Int32Array ||
      raw instanceof Uint32Array ||
      raw instanceof Float32Array ||
      raw instanceof Float64Array
    ) ||
    raw.length !== count
  )
    throw new Error("Invalid native scalar buffer");
  const inverse = inverseNative(volume.getAffine());
  const affine = volume.getAffine();
  const slope = hdr.scl_slope === 0 ? 1 : hdr.scl_slope;
  const inter = hdr.scl_inter;
  if (!finite(slope) || !finite(inter))
    throw new Error("Invalid intensity scaling");
  if (origin.length !== 3 || !origin.every(finite))
    throw new Error("Invalid plane origin");
  const [u, v] = planeBasis(normal);
  const extentX = bounds.maxX - bounds.minX,
    extentY = bounds.maxY - bounds.minY;
  if (
    ![
      bounds.minX,
      bounds.maxX,
      bounds.minY,
      bounds.maxY,
      extentX,
      extentY,
    ].every(finite) ||
    extentX <= 0 ||
    extentY <= 0 ||
    extentX > 200 ||
    extentY > 200
  )
    throw new Error("Invalid plane extent");
  const span = window[1] - window[0];
  if (!window.every(finite) || !finite(span) || span <= 0)
    throw new Error("Invalid intensity window");
  if (!finite(resolution) || resolution < 1)
    throw new Error("Invalid slice resolution");
  const size = Math.min(256, Math.floor(resolution));
  const world = origin.map(
    (o, i) =>
      o +
      u[i] * (bounds.minX + extentX / (2 * size)) +
      v[i] * (bounds.minY + extentY / (2 * size)) -
      affine[i][3],
  ) as Vec3;
  const start = inverse(world);
  const dx = inverse(u.map((n) => (n * extentX) / size) as Vec3);
  const dy = inverse(v.map((n) => (n * extentY) / size) as Vec3);
  if (![...start, ...dx, ...dy].every(finite))
    throw new Error("Invalid transformed plane");
  const rgba = new Uint8ClampedArray(size * size * 4);
  let outside = 0;
  const at = (x: number, y: number, z: number) => raw[x + nx * (y + ny * z)];
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      const voxel = start.map((s, i) => s + row * dy[i] + col * dx[i]);
      const o = 4 * (row * size + col);
      if (voxel.some((x, i) => x < -1e-7 || x > [nx, ny, nz][i] - 1 + 1e-7)) {
        outside++;
        continue;
      }
      const [x, y, z] = voxel.map((n, i) =>
        Math.max(0, Math.min([nx, ny, nz][i] - 1, n)),
      );
      const x0 = Math.floor(x),
        y0 = Math.floor(y),
        z0 = Math.floor(z);
      const x1 = Math.min(x0 + 1, nx - 1),
        y1 = Math.min(y0 + 1, ny - 1),
        z1 = Math.min(z0 + 1, nz - 1);
      const fx = x - x0,
        fy = y - y0,
        fz = z - z0;
      const value =
        at(x0, y0, z0) * (1 - fx) * (1 - fy) * (1 - fz) +
        at(x1, y0, z0) * fx * (1 - fy) * (1 - fz) +
        at(x0, y1, z0) * (1 - fx) * fy * (1 - fz) +
        at(x1, y1, z0) * fx * fy * (1 - fz) +
        at(x0, y0, z1) * (1 - fx) * (1 - fy) * fz +
        at(x1, y0, z1) * fx * (1 - fy) * fz +
        at(x0, y1, z1) * (1 - fx) * fy * fz +
        at(x1, y1, z1) * fx * fy * fz;
      const hu = value * slope + inter;
      if (!finite(hu))
        throw new Error("Nonfinite source sample; refusing slice");
      const gray = Math.max(0, Math.min(255, ((hu - window[0]) / span) * 255));
      rgba[o] = gray;
      rgba[o + 1] = gray;
      rgba[o + 2] = gray;
      rgba[o + 3] = 255;
    }
  return { width: size, height: size, rgba, outside };
}
