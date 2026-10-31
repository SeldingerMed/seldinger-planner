export type Point3 = [number, number, number];
export function point3(value: unknown): Point3 | null {
  if (!value || typeof value !== "object" || !("length" in value)) return null;
  const values = Array.from(value as ArrayLike<number>).slice(0, 3);
  return values.length === 3 && values.every(Number.isFinite)
    ? (values as Point3)
    : null;
}
export function volumeMetadata(hdr: {
  dims: ArrayLike<number>;
  pixDims: ArrayLike<number>;
  xyzt_units?: number;
}) {
  const dimensions = Array.from(hdr.dims).slice(1, 4);
  const spacing_mm = Array.from(hdr.pixDims).slice(1, 4).map(Math.abs);
  if (
    dimensions.length !== 3 ||
    dimensions.some((d) => !Number.isInteger(d) || d < 1 || d > 2048) ||
    spacing_mm.length !== 3 ||
    spacing_mm.some((d) => !Number.isFinite(d) || d <= 0 || d > 100)
  )
    throw new Error("Unsupported image geometry");
  const spatial_units: "mm" | "unknown" =
    ((hdr.xyzt_units ?? 0) & 7) === 2 ? "mm" : "unknown";
  return { dimensions, spacing_mm, spatial_units };
}
