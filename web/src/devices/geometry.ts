/**
 * Procedural device geometry kernel.
 *
 * Pure, deterministic, bounded TypeScript. Produces visual overlays in
 * physical RAS millimetres. This is a KINEMATIC GEOMETRY APPROXIMATION ONLY:
 * it models device shapes for display, never wall apposition, pressure,
 * mechanical forces, or clinical suitability. Source-specific numeric specs
 * (real device dimensions) are supplied by the caller.
 */

export type Vec3 = [number, number, number];

export interface DeviceGeometry {
  /** Wire / marker polylines in RAS mm. */
  lines: Vec3[][];
  /** Optional triangulated surface shell in RAS mm. */
  surface?: { points: Vec3[]; triangles: number[][] };
  /** Axis-aligned bounding box of everything above, in RAS mm. */
  bounds: { min: Vec3; max: Vec3 };
  /** Honest description of what this geometry approximates (and does not). */
  approximation: string;
}

export interface FlowDiverterParams {
  path: Vec3[];
  diameterMm: number;
  lengthMm: number;
  wireCount: number;
  turns: number;
  startMm?: number;
}

export interface IntrasaccularParams {
  center: Vec3;
  axis: Vec3;
  diameterMm: number;
  heightMm: number;
  shape: "web-sl" | "web-sls" | "contour";
  wireCount: number;
}

export interface CoilPackParams {
  center: Vec3;
  axis: Vec3;
  sacDiameterMm: number;
  primaryDiameterMm: number;
  lengthMm: number;
}

// ---------------------------------------------------------------------------
// Bounds / caps
// ---------------------------------------------------------------------------

const MAX_VERTICES = 120000;
const MAX_LINES = 2000;

class GeometryError extends Error {}

function isFiniteVec3(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    (v as unknown[]).every((c) => typeof c === "number" && Number.isFinite(c))
  );
}

function assertFinite(
  name: string,
  value: number,
  min = -Infinity,
  max = Infinity,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GeometryError(`${name} must be a finite number`);
  }
  if (value < min || value > max) {
    throw new GeometryError(`${name}=${value} out of range [${min}, ${max}]`);
  }
  return value;
}

function assertPositive(name: string, value: number): number {
  return assertFinite(name, value, Number.EPSILON, 1e5);
}

class Bounds {
  min: Vec3 = [Infinity, Infinity, Infinity];
  max: Vec3 = [-Infinity, -Infinity, -Infinity];
  vertexCount = 0;
  add(p: Vec3): void {
    this.vertexCount++;
    if (this.vertexCount > MAX_VERTICES) {
      throw new GeometryError(`geometry exceeds vertex cap (${MAX_VERTICES})`);
    }
    for (let a = 0; a < 3; a++) {
      if (p[a] < this.min[a]) this.min[a] = p[a];
      if (p[a] > this.max[a]) this.max[a] = p[a];
    }
  }
  addLine(line: Vec3[]): void {
    for (const p of line) this.add(p);
  }
}

// ---------------------------------------------------------------------------
// Vector helpers (local, no external deps)
// ---------------------------------------------------------------------------

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n < 1e-12) throw new GeometryError("cannot normalize zero vector");
  return scale(a, 1 / n);
}

/** Deterministic orthonormal basis {tangent, normal, binormal} with tangent first. */
function frameFromTangent(t: Vec3): [Vec3, Vec3, Vec3] {
  const tangent = normalize(t);
  const helper: Vec3 = Math.abs(tangent[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const normal = normalize(cross(tangent, helper));
  const binormal = cross(tangent, normal);
  return [tangent, normal, binormal];
}

/** Local frame for an axis direction (used by intrasaccular / coil). */
function axisFrame(axis: Vec3): [Vec3, Vec3, Vec3] {
  if (!isFiniteVec3(axis))
    throw new GeometryError("axis must be a finite Vec3");
  if (norm(axis) < 1e-9) throw new GeometryError("axis must be non-zero");
  return frameFromTangent(axis);
}

function toWorld(
  origin: Vec3,
  basis: [Vec3, Vec3, Vec3],
  u: number,
  v: number,
  w: number,
): Vec3 {
  const [e0, e1, e2] = basis;
  return add(add(add(origin, scale(e0, u)), scale(e1, v)), scale(e2, w));
}

// ---------------------------------------------------------------------------
// Resampled arclength path with parallel-transport frames (flow diverter)
// ---------------------------------------------------------------------------

interface PathSample {
  p: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

/**
 * Resample a polyline by arclength and compute stable parallel-transport
 * frames (no sudden normal flips through curves).
 */
function resamplePath(
  path: Vec3[],
  stepMm: number,
): { samples: PathSample[]; totalLength: number } {
  if (!Array.isArray(path) || path.length < 2) {
    throw new GeometryError("path must contain at least 2 points");
  }
  for (const p of path) {
    if (!isFiniteVec3(p))
      throw new GeometryError("path contains non-finite points");
  }
  for (let i = 1; i < path.length; i++) {
    if (norm(sub(path[i], path[i - 1])) < 1e-9) {
      throw new GeometryError(
        `path has repeated/degenerate segment at index ${i}`,
      );
    }
  }
  // Cumulative arclength.
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + norm(sub(path[i], path[i - 1])));
  }
  const totalLength = cum[cum.length - 1];
  if (path.length > 512 || totalLength > 1000)
    throw new GeometryError("path exceeds bounded sampling extent");
  const nSamples = Math.max(2, Math.ceil(totalLength / stepMm) + 1);
  const samples: PathSample[] = [];

  const pointAt = (s: number): Vec3 => {
    // binary search
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    const t = segLen < 1e-12 ? 0 : (s - cum[lo]) / segLen;
    return add(path[lo], scale(sub(path[hi], path[lo]), t));
  };

  // First sample: parallel transport seeding.
  let [t0, n0, b0] = frameFromTangent(sub(path[1], path[0]));
  for (let i = 0; i < nSamples; i++) {
    const s = Math.min((i / (nSamples - 1)) * totalLength, totalLength);
    const p = pointAt(s);
    const sNext = Math.min(s + 1e-4, totalLength);
    const tangent = normalize(
      sub(pointAt(sNext), pointAt(Math.max(s - 1e-4, 0))),
    );
    if (i === 0) {
      samples.push({ p, tangent: t0, normal: n0, binormal: b0 });
      continue;
    }
    // Parallel transport previous normal onto new tangent (rotation-minimizing).
    const [tPrev, nPrev] = [samples[i - 1].tangent, samples[i - 1].normal];
    const dot = Math.max(
      -1,
      Math.min(
        1,
        tPrev[0] * tangent[0] + tPrev[1] * tangent[1] + tPrev[2] * tangent[2],
      ),
    );
    const axisv = cross(tPrev, tangent);
    const sinHalf = norm(axisv);
    let normal: Vec3;
    if (sinHalf < 1e-9) {
      normal = dot > 0 ? nPrev : scale(nPrev, -1);
    } else {
      // Rodrigues rotation of nPrev by angle between tPrev and tangent.
      normal = add(
        scale(nPrev, dot),
        add(
          cross(axisv, nPrev),
          scale(
            axisv,
            ((1 - dot) / (sinHalf * sinHalf)) *
              (axisv[0] * nPrev[0] + axisv[1] * nPrev[1] + axisv[2] * nPrev[2]),
          ),
        ),
      );
      normal = normalize(normal);
    }
    const binormal = cross(tangent, normal);
    samples.push({ p, tangent, normal, binormal });
  }
  return { samples, totalLength };
}

// ---------------------------------------------------------------------------
// flowDiverter
// ---------------------------------------------------------------------------

export function flowDiverter(params: FlowDiverterParams): DeviceGeometry {
  const { path } = params;
  const diameterMm = assertPositive("diameterMm", params.diameterMm);
  const lengthMm = assertPositive("lengthMm", params.lengthMm);
  const wireCount = assertFinite("wireCount", params.wireCount, 2, 512);
  if (!Number.isInteger(wireCount) || wireCount % 2)
    throw new GeometryError("wireCount must be an even TOTAL wire count");
  const turns = assertFinite("turns", params.turns, 0, 50);
  // Validate the complete path before trimming; do not extrapolate beyond it.
  const validated = resamplePath(path, 0.25);
  const start = assertFinite("startMm", params.startMm ?? 0, 0, 1000),
    end = start + lengthMm;
  if (end > validated.totalLength * (1 + 1e-9))
    throw new GeometryError(
      "requested lengthMm and offset exceed path arclength",
    );
  const trimmed: Vec3[] = [];
  let traversed = 0;
  for (let j = 1; j < path.length && traversed < end - 1e-9; j++) {
    const delta = sub(path[j], path[j - 1]),
      distance = norm(delta),
      next = traversed + distance;
    if (next > start + 1e-9) {
      if (trimmed.length === 0)
        trimmed.push(
          add(
            path[j - 1],
            scale(delta, Math.max(0, start - traversed) / distance),
          ),
        );
      trimmed.push(
        add(
          path[j - 1],
          scale(delta, Math.min(distance, end - traversed) / distance),
        ),
      );
    }
    traversed = next;
  }
  const { samples } = resamplePath(
    trimmed,
    Math.min(0.25, lengthMm / Math.max(32, turns * 24)),
  );
  if (samples.length * wireCount > MAX_VERTICES)
    throw new GeometryError("braid exceeds vertex cap");
  const bounds = new Bounds();
  const lines: Vec3[][] = [];
  const radius = diameterMm / 2;
  for (let w = 0; w < wireCount; w++) {
    const dir = w < wireCount / 2 ? 1 : -1;
    const phase =
      ((w % (wireCount / 2)) / (wireCount / 2) +
        (dir < 0 ? 1 / wireCount : 0)) *
      2 *
      Math.PI;
    const line: Vec3[] = [];
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const angle =
        (dir * 2 * Math.PI * turns * i) / (samples.length - 1) + phase;
      const offset = add(
        scale(sample.normal, radius * Math.cos(angle)),
        scale(sample.binormal, radius * Math.sin(angle)),
      );
      const pt = add(sample.p, offset);
      line.push(pt);
      bounds.add(pt);
    }
    lines.push(line);
  }
  if (lines.length > MAX_LINES)
    throw new GeometryError("geometry exceeds line cap");

  return {
    lines,
    bounds: { min: bounds.min, max: bounds.max },
    approximation:
      "Kinematic visual approximation: helical counterbraid laid on the input centerline arclength with parallel-transport frames. Display geometry only — no device-tissue interaction, hemodynamics, or clinical validation is represented.",
  };
}

// ---------------------------------------------------------------------------
// intrasaccular (WEB SL / SLS, Contour)
// ---------------------------------------------------------------------------

const SURF_RINGS = 24;
const SURF_SEGS = 32;

/** Profile radius r(v), v in [0,1] from distal (-w) to proximal (+w) end. */
function profileRadius(
  shape: IntrasaccularParams["shape"],
  v: number,
  radius: number,
): number {
  const t = v * 2 - 1; // -1 distal .. +1 proximal
  if (shape === "contour") {
    // Flared shallow cup: dome at distal end, opening to full radius proximally.
    return radius * Math.sqrt(Math.max(0, (t + 1) / 2));
  }
  // SL has straighter barrel sides; SLS is the single-layer spherical variant.
  const p = shape === "web-sl" ? 3.5 : 2;
  const u = Math.abs(t);
  return radius * Math.pow(1 - Math.pow(u, p), 1 / p);
}

export function intrasaccular(params: IntrasaccularParams): DeviceGeometry {
  const center = params.center;
  if (!isFiniteVec3(center))
    throw new GeometryError("center must be a finite Vec3");
  const basis = axisFrame(params.axis);
  const diameterMm = assertPositive("diameterMm", params.diameterMm);
  const heightMm = assertPositive("heightMm", params.heightMm);
  const wireCount = assertFinite("wireCount", params.wireCount, 3, 256);
  if (!Number.isInteger(wireCount))
    throw new GeometryError("wireCount must be an integer");
  const shape = params.shape;
  if (shape !== "web-sl" && shape !== "web-sls" && shape !== "contour") {
    throw new GeometryError(`unknown shape '${shape}'`);
  }

  const radius = diameterMm / 2;
  const halfH = heightMm / 2;
  const bounds = new Bounds();
  const lines: Vec3[][] = [];

  // Surface of revolution around the local w (axis) coordinate.
  // Surface of revolution around the local tangent (axis) coordinate.
  const points: Vec3[] = [];
  for (let ring = 0; ring <= SURF_RINGS; ring++) {
    const v = ring / SURF_RINGS;
    const w = -halfH + v * heightMm;
    const r = profileRadius(shape, v, radius);
    for (let seg = 0; seg < SURF_SEGS; seg++) {
      const a = (seg / SURF_SEGS) * 2 * Math.PI;
      // local: v-axis = e1 (u), binormal = e2; axis height along e0? —
      // axisFrame returns [tangent, normal, binormal]; use tangent as axis.
      const pt = toWorld(
        center,
        [basis[0], basis[1], basis[2]],
        w, // along axis (tangent)
        r * Math.cos(a), // radial u
        r * Math.sin(a), // radial v
      );
      points.push(pt);
      bounds.add(pt);
    }
  }
  const triangles: number[][] = [];
  const idx = (ring: number, seg: number): number =>
    ring * SURF_SEGS + (seg % SURF_SEGS);
  for (let ring = 0; ring < SURF_RINGS; ring++) {
    for (let seg = 0; seg < SURF_SEGS; seg++) {
      const a = idx(ring, seg);
      const b = idx(ring, seg + 1);
      const c = idx(ring + 1, seg);
      const d = idx(ring + 1, seg + 1);
      triangles.push([a, b, c], [b, d, c]);
    }
  }

  // Distinct counter-woven wires. Winding pitch is a visual approximation,
  // not a measured manufacturer braid parameter.
  for (let m = 0; m < wireCount; m++) {
    const line: Vec3[] = [];
    for (let j = 0; j <= 96; j++) {
      const v = j / 96,
        direction = m % 2 ? 1 : -1;
      const a =
        (m * 2 * Math.PI) / wireCount + direction * 2 * Math.PI * 1.75 * v;
      const r = profileRadius(shape, v, radius);
      line.push(
        toWorld(
          center,
          basis,
          -halfH + v * heightMm,
          r * Math.cos(a),
          r * Math.sin(a),
        ),
      );
    }
    lines.push(line);
    bounds.addLine(line);
  }

  // Central proximal/distal markers: short axial segments.
  const markerLen = Math.min(0.8, heightMm * 0.2);
  for (const end of [-1, 1]) {
    const from = end * (halfH - markerLen);
    const to = end * halfH;
    const line: Vec3[] = [
      toWorld(center, basis, from, 0, 0),
      toWorld(center, basis, to, 0, 0),
    ];
    lines.push(line);
    bounds.addLine(line);
  }

  // Contour: proximal stem (not a ball) — an axial stem on the +axis side.
  if (shape === "contour") {
    const stemLen = Math.min(2, heightMm * 0.6);
    const stemR = Math.min(0.35, radius * 0.1);
    for (let k = 0; k < 2; k++) {
      const a = (k / 2) * 2 * Math.PI;
      const line: Vec3[] = [];
      for (let i = 0; i <= 6; i++) {
        const w = halfH + (i / 6) * stemLen;
        const rr = (i / 6) * stemR;
        line.push(
          toWorld(center, basis, w, rr * Math.cos(a), rr * Math.sin(a)),
        );
      }
      lines.push(line);
      bounds.addLine(line);
    }
  }

  if (lines.length > MAX_LINES)
    throw new GeometryError("geometry exceeds line cap");

  return {
    lines,
    surface: { points, triangles },
    bounds: { min: bounds.min, max: bounds.max },
    approximation:
      "Kinematic visual approximation: idealized parametric cage profile (barrel/rounder/cup) with central markers. Display geometry only — no device-tissue interaction, detachment mechanics, or clinical validation is represented.",
  };
}

// ---------------------------------------------------------------------------
// coilPack
// ---------------------------------------------------------------------------

const COIL_LOOP_SEGS = 24;

/**
 * Deterministic bounded coil: nested circular loops stacked along the axis,
 * filling the sac sphere inward. Centerline length is computed exactly from
 * the loop set; a final partial loop trims to the requested length. If the
 * fully packed sac still cannot reach the requested length, an error is
 * thrown rather than inventing packing geometry.
 */
export function coilPack(params: CoilPackParams): DeviceGeometry {
  const center = params.center;
  if (!isFiniteVec3(center))
    throw new GeometryError("center must be a finite Vec3");
  const basis = axisFrame(params.axis);
  const sacDiameterMm = assertPositive("sacDiameterMm", params.sacDiameterMm);
  const primaryDiameterMm = assertPositive(
    "primaryDiameterMm",
    params.primaryDiameterMm,
  );
  const lengthMm = assertPositive("lengthMm", params.lengthMm);
  if (primaryDiameterMm >= sacDiameterMm) {
    throw new GeometryError(
      "primaryDiameterMm must be smaller than sacDiameterMm",
    );
  }

  const sacR = sacDiameterMm / 2;
  const wireR = primaryDiameterMm / 2;
  const pitch = primaryDiameterMm; // loops stacked one wire apart

  // Loop j: axial height from +top going down by j*pitch; radius limited by sphere.
  type Loop = { w: number; r: number };
  const loops: Loop[] = [];
  let fullLength = 0;
  for (let j = 0; ; j++) {
    const w = sacR - wireR - j * pitch;
    if (w < -sacR + wireR) break;
    const maxR = Math.sqrt(Math.max(0, sacR * sacR - w * w)) - wireR;
    if (maxR < wireR) continue; // too tight for a full wire loop at this height
    loops.push({ w, r: maxR });
    fullLength += 2 * Math.PI * maxR;
    if (loops.length > 20000) throw new GeometryError("coil exceeds loop cap");
  }
  if (fullLength < lengthMm * (1 - 1e-9)) {
    throw new GeometryError(
      `cannot honor lengthMm=${lengthMm}: this nested-loop illustration for a ${sacDiameterMm} mm envelope and ${primaryDiameterMm} mm display spacing represents at most ${fullLength.toFixed(2)} mm. This is a display-model limit, not a physical packing limit; no requested length is silently shortened`,
    );
  }

  const bounds = new Bounds();
  const line: Vec3[] = [];
  let remaining = lengthMm;
  let first = true;
  for (const loop of loops) {
    if (remaining <= 1e-9) break;
    const circumference = 2 * Math.PI * loop.r;
    const frac = Math.min(1, remaining / circumference);
    const segs = Math.max(2, Math.ceil(frac * COIL_LOOP_SEGS));
    for (let i = 0; i <= segs; i++) {
      if (first && i === 0) {
        first = false;
      }
      const a = (i / segs) * frac * 2 * Math.PI;
      const pt = toWorld(
        center,
        basis,
        loop.w,
        loop.r * Math.cos(a),
        loop.r * Math.sin(a),
      );
      line.push(pt);
      bounds.add(pt);
    }
    remaining -= frac * circumference;
  }
  if (line.length < 2) throw new GeometryError("coil produced degenerate path");

  return {
    lines: [line],
    bounds: { min: bounds.min, max: bounds.max },
    approximation:
      "Kinematic visual approximation: deterministic nested-loop coil skeleton sized to the requested centerline length. Display geometry only — no packing mechanics, device-tissue interaction, hemodynamics, or clinical validation is represented.",
  };
}
