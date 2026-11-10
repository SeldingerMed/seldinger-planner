/** Validated native-buffer RAS sampling shared by planar, curved and fused views. */
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
const finite = (v: number) => Number.isFinite(v);
export function invertNativeAffine(m: number[][]): (point: Vec3) => Vec3 {
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
  const inv = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  if (!inv.every((r) => r.every(finite)))
    throw new Error("Invalid native affine inverse");
  const translation = m.slice(0, 3).map((r) => r[3]);
  return (p) =>
    inv.map((row) =>
      row.reduce((sum, x, j) => sum + x * (p[j] - translation[j]), 0),
    ) as Vec3;
}
export function createNativeSampler(volume: NVImage) {
  const hdr = volume.hdr,
    raw = volume.img;
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
  const [nx, ny, nz] = dims.slice(1, 4),
    count = nx * ny * nz;
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
  const inverse = invertNativeAffine(volume.getAffine());
  const slope = hdr.scl_slope === 0 ? 1 : hdr.scl_slope,
    inter = hdr.scl_slope === 0 ? 0 : hdr.scl_inter;
  if (!finite(slope) || !finite(inter))
    throw new Error("Invalid intensity scaling");
  const at = (x: number, y: number, z: number) => raw[x + nx * (y + ny * z)];
  return {
    shape: [nx, ny, nz] as Vec3,
    /** Validated buffer access for tight projection loops. Read-only use. */
    raw,
    slope,
    inter,
    toVoxel: inverse,
    sample(point: Vec3): number | null {
      if (point.length !== 3 || !point.every(finite))
        throw new Error("Invalid physical sample point");
      const voxel = inverse(point),
        shape = [nx, ny, nz];
      if (!voxel.every(finite))
        throw new Error("Invalid transformed sample point");
      if (voxel.some((v, i) => v < -1e-7 || v > shape[i] - 1 + 1e-7))
        return null;
      const [x, y, z] = voxel.map((v, i) =>
        Math.max(0, Math.min(shape[i] - 1, v)),
      );
      const x0 = Math.floor(x),
        y0 = Math.floor(y),
        z0 = Math.floor(z),
        x1 = Math.min(x0 + 1, nx - 1),
        y1 = Math.min(y0 + 1, ny - 1),
        z1 = Math.min(z0 + 1, nz - 1),
        fx = x - x0,
        fy = y - y0,
        fz = z - z0;
      const value =
        (at(x0, y0, z0) * (1 - fx) * (1 - fy) * (1 - fz) +
          at(x1, y0, z0) * fx * (1 - fy) * (1 - fz) +
          at(x0, y1, z0) * (1 - fx) * fy * (1 - fz) +
          at(x1, y1, z0) * fx * fy * (1 - fz) +
          at(x0, y0, z1) * (1 - fx) * (1 - fy) * fz +
          at(x1, y0, z1) * fx * (1 - fy) * fz +
          at(x0, y1, z1) * (1 - fx) * fy * fz +
          at(x1, y1, z1) * fx * fy * fz) *
          slope +
        inter;
      if (!finite(value))
        throw new Error("Nonfinite source sample; refusing view");
      return value;
    },
  };
}
