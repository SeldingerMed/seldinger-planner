type V = [number, number, number];
export type TriangleMesh = { points: V[]; triangles: number[][] };
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: V): V => {
  const d = Math.hypot(...a);
  if (d < 1e-10) throw new Error("Degenerate mesh direction");
  return a.map((x) => x / d) as V;
};
/** Rendering thickness is deliberately separate from physical wire specifications. */
export function lineTubes(
  lines: V[][],
  displayRadiusMm = 0.035,
  sides = 5,
): TriangleMesh {
  if (
    !Number.isFinite(displayRadiusMm) ||
    displayRadiusMm <= 0 ||
    displayRadiusMm > 1 ||
    !Number.isInteger(sides) ||
    sides < 3 ||
    sides > 12 ||
    lines.length > 512
  )
    throw new Error("Invalid rendering bound");
  const count = lines.reduce((a, l) => a + l.length, 0);
  if (
    count > 100000 ||
    lines.some(
      (l) =>
        l.length < 2 ||
        l.some(
          (p) =>
            p.length !== 3 ||
            p.some((x) => !Number.isFinite(x) || Math.abs(x) > 100000),
        ),
    )
  )
    throw new Error("Invalid bounded device coordinates");
  const points: V[] = [],
    triangles: number[][] = [];
  for (const line of lines) {
    const start = points.length;
    let previous: V | null = null;
    for (let i = 0; i < line.length; i++) {
      const tangent = unit(
        sub(line[Math.min(i + 1, line.length - 1)], line[Math.max(i - 1, 0)]),
      );
      let e: V = previous
        ? sub(
            previous,
            tangent.map(
              (v) =>
                v *
                (previous![0] * tangent[0] +
                  previous![1] * tangent[1] +
                  previous![2] * tangent[2]),
            ) as V,
          )
        : cross(tangent, Math.abs(tangent[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0]);
      if (Math.hypot(...e) < 1e-8)
        e = cross(tangent, Math.abs(tangent[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0]);
      e = unit(e);
      previous = e;
      const f = unit(cross(tangent, e));
      for (let j = 0; j < sides; j++) {
        const a = (j * 2 * Math.PI) / sides;
        points.push(
          line[i].map(
            (v, k) =>
              v + displayRadiusMm * (Math.cos(a) * e[k] + Math.sin(a) * f[k]),
          ) as V,
        );
      }
      if (i)
        for (let j = 0; j < sides; j++) {
          const a = start + (i - 1) * sides + j,
            b = start + (i - 1) * sides + ((j + 1) % sides),
            c = start + i * sides + j,
            d = start + i * sides + ((j + 1) % sides);
          triangles.push([a, b, c], [b, d, c]);
        }
    }
  }
  return { points, triangles };
}
export function binarySTL(mesh: TriangleMesh): ArrayBuffer {
  if (mesh.triangles.length > 1000000)
    throw new Error("Mesh exceeds triangle cap");
  const buffer = new ArrayBuffer(84 + 50 * mesh.triangles.length),
    v = new DataView(buffer);
  v.setUint32(80, mesh.triangles.length, true);
  mesh.triangles.forEach((tri, i) => {
    if (
      tri.length !== 3 ||
      tri.some((k) => !Number.isInteger(k) || k < 0 || k >= mesh.points.length)
    )
      throw new Error("Invalid triangle");
    const p = tri.map((k) => mesh.points[k]);
    const n = cross(sub(p[1], p[0]), sub(p[2], p[0])),
      d = Math.hypot(...n);
    const values = [...n.map((x) => (d ? x / d : 0)), ...p.flat()];
    if (values.some((x) => !Number.isFinite(x)))
      throw new Error("Nonfinite mesh");
    values.forEach((x, j) => v.setFloat32(84 + 50 * i + j * 4, x, true));
  });
  return buffer;
}
