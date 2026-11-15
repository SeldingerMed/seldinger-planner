/** The vessel-presence report as it is saved and read back.
 *
 * A report belongs to one saved registration. It carries, for every unnamed
 * segment of the vessel mask and every plane of that registration, the
 * sample counts the class follows from. It carries no pixel, coordinate or
 * cause. The parser is closed: a key it does not know, a class its counts do
 * not give, or a report that names another registration is refused. */
import type { Identity } from "./territoryWorkflow";
import {
  isBiplane,
  type PlaneLabel,
  type SavedRegistration,
} from "./projectionFrames";
import {
  classifyPresence,
  PRESENCE_CLASSES,
  VESSEL_PRESENCE_LIMITS,
  VESSEL_PRESENCE_METHOD,
  type PresenceClass,
  type VesselPresence,
} from "./vesselPresence";
import {
  VESSEL_SEGMENT_LIMITS,
  VESSEL_SEGMENT_METHOD,
  type VesselSegments,
} from "./vesselSegments";

export const PRESENCE_REPORT_VERSION = "step-c3-vessel-presence-v1";
export const PRESENCE_REPORT_LIMITS = {
  max_segments: VESSEL_SEGMENT_LIMITS.max_segments,
  max_unmatched: 2000,
  max_samples: 100_000,
} as const;

export type ReportSegment = {
  length_mm: number;
  mean_radius_mm: number;
  sample_count: number;
  run: number;
};
export type ReportEntry = {
  presence: PresenceClass;
  in_field: number;
  clear: number;
  supported: number;
};
export type ReportPlane = {
  plane: PlaneLabel;
  frame_sha256: string;
  segments: ReportEntry[];
  /** Lengths of the 2D vessel pieces with no segment near, longest first. */
  unmatched_mm: number[];
};
export type PresenceReportInputs = {
  confirmed: true;
  registration_id: string;
  registration_revision: number;
  registration_input_sha256: string;
  method: typeof VESSEL_PRESENCE_METHOD;
  segment_method: typeof VESSEL_SEGMENT_METHOD;
  pooling: number;
  unassigned_fraction: number;
  segments: ReportSegment[];
  planes: ReportPlane[];
};
export type PlaneSummary = {
  plane: PlaneLabel;
  classes: Record<PresenceClass, { count: number; length_mm: number }>;
  unmatched_count: number;
  unmatched_length_mm: number;
};
export type PresenceCurrent =
  | { status: "not_confirmed" }
  | { status: "stale"; report_id: string }
  | {
      status: "current";
      report_id: string;
      inputs: PresenceReportInputs;
    };
export type SavedPresence = {
  report_revision: number;
  current: PresenceCurrent;
};

const SHA = /^[a-f0-9]{64}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function exact(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function fail(): never {
  throw new Error("Invalid vessel presence report");
}
const integer = (value: unknown, low: number, high: number): number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= low &&
  value <= high
    ? value
    : fail();
const real = (value: unknown, low: number, high: number): number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= low &&
  value <= high
    ? value
    : fail();

/** What a report must name to belong to a registration, or null when the
 * registration is not current. */
export function reportBinding(registration: SavedRegistration) {
  const current = registration.current;
  if (current.status !== "current") return null;
  return {
    registration_id: current.registration_id,
    registration_revision: registration.registration_revision,
    registration_input_sha256: current.input_sha256,
    planes: (isBiplane(current.inputs)
      ? current.inputs.planes
      : [current.inputs]
    ).map((entry) => ({
      plane: entry.plane as PlaneLabel,
      frame_sha256: entry.frame_sha256,
    })),
  };
}

/** Counts and lengths by class in each plane, as the server derives them. */
export function summarizeReport(inputs: PresenceReportInputs): PlaneSummary[] {
  return inputs.planes.map((plane) => {
    const classes = Object.fromEntries(
      PRESENCE_CLASSES.map((name) => [name, { count: 0, length_mm: 0 }]),
    ) as PlaneSummary["classes"];
    plane.segments.forEach((entry, index) => {
      classes[entry.presence].count++;
      classes[entry.presence].length_mm += inputs.segments[index].length_mm;
    });
    return {
      plane: plane.plane,
      classes,
      unmatched_count: plane.unmatched_mm.length,
      unmatched_length_mm: plane.unmatched_mm.reduce(
        (sum, length) => sum + length,
        0,
      ),
    };
  });
}

function parseInputs(value: unknown): PresenceReportInputs {
  const L = PRESENCE_REPORT_LIMITS;
  if (
    !exact(value, [
      "confirmed",
      "registration_id",
      "registration_revision",
      "registration_input_sha256",
      "method",
      "segment_method",
      "pooling",
      "unassigned_fraction",
      "segments",
      "planes",
    ]) ||
    value.confirmed !== true ||
    typeof value.registration_id !== "string" ||
    typeof value.registration_input_sha256 !== "string" ||
    !SHA.test(value.registration_input_sha256) ||
    value.method !== VESSEL_PRESENCE_METHOD ||
    value.segment_method !== VESSEL_SEGMENT_METHOD ||
    !Array.isArray(value.segments) ||
    value.segments.length < 1 ||
    value.segments.length > L.max_segments ||
    !Array.isArray(value.planes) ||
    value.planes.length < 1 ||
    value.planes.length > 2
  )
    fail();
  const segments = (value.segments as unknown[]).map(
    (entry, index, all): ReportSegment => {
      if (!exact(entry, ["length_mm", "mean_radius_mm", "sample_count", "run"]))
        fail();
      const run = integer(entry.run, 0, L.max_segments - 1),
        before = index ? (all[index - 1] as { run: number }).run : 0;
      // Runs are numbered from zero in the order their segments are listed.
      if (index ? run !== before && run !== before + 1 : run !== 0) fail();
      const length_mm = real(entry.length_mm, 0, 10_000),
        mean_radius_mm = real(entry.mean_radius_mm, 0, 100);
      if (!(length_mm > 0) || !(mean_radius_mm > 0)) fail();
      return {
        length_mm,
        mean_radius_mm,
        sample_count: integer(entry.sample_count, 0, L.max_samples),
        run,
      };
    },
  );
  const planes = (value.planes as unknown[]).map((plane): ReportPlane => {
    if (
      !exact(plane, ["plane", "frame_sha256", "segments", "unmatched_mm"]) ||
      !["single", "a", "b"].includes(plane.plane as string) ||
      typeof plane.frame_sha256 !== "string" ||
      !SHA.test(plane.frame_sha256) ||
      !Array.isArray(plane.segments) ||
      plane.segments.length !== segments.length ||
      !Array.isArray(plane.unmatched_mm) ||
      plane.unmatched_mm.length > L.max_unmatched
    )
      fail();
    const unmatched = (plane.unmatched_mm as unknown[]).map((length) =>
      real(length, VESSEL_PRESENCE_LIMITS.min_piece_mm, 10_000),
    );
    if (unmatched.some((length, k) => k > 0 && length > unmatched[k - 1]))
      fail();
    return {
      plane: plane.plane as PlaneLabel,
      frame_sha256: plane.frame_sha256,
      segments: (plane.segments as unknown[]).map((entry, index) => {
        if (!exact(entry, ["presence", "in_field", "clear", "supported"]))
          fail();
        const in_field = integer(
            entry.in_field,
            0,
            segments[index].sample_count,
          ),
          clear = integer(entry.clear, 0, in_field),
          supported = integer(entry.supported, 0, clear);
        // The class is the one the counts give. Nothing else is accepted.
        if (
          entry.presence !==
          classifyPresence(
            segments[index].sample_count,
            in_field,
            clear,
            supported,
          )
        )
          fail();
        return {
          presence: entry.presence as PresenceClass,
          in_field,
          clear,
          supported,
        };
      }),
      unmatched_mm: unmatched,
    };
  });
  const names = planes.map((plane) => plane.plane).join(",");
  if (!["single", "a", "b", "a,b"].includes(names)) fail();
  return {
    confirmed: true,
    registration_id: value.registration_id as string,
    registration_revision: integer(value.registration_revision, 1, 1e9),
    registration_input_sha256: value.registration_input_sha256 as string,
    method: VESSEL_PRESENCE_METHOD,
    segment_method: VESSEL_SEGMENT_METHOD,
    pooling: integer(value.pooling, 1, 8),
    unassigned_fraction: real(value.unassigned_fraction, 0, 1),
    segments,
    planes,
  };
}

const bound = (
  inputs: PresenceReportInputs,
  binding: NonNullable<ReturnType<typeof reportBinding>>,
) =>
  inputs.registration_id === binding.registration_id &&
  inputs.registration_revision === binding.registration_revision &&
  inputs.registration_input_sha256 === binding.registration_input_sha256 &&
  inputs.planes.length === binding.planes.length &&
  inputs.planes.every(
    (plane, k) =>
      plane.plane === binding.planes[k].plane &&
      plane.frame_sha256 === binding.planes[k].frame_sha256,
  );

/** Reads the server's answer for the report of one registration. A report
 * the server calls current must name that registration and agree with the
 * server's own summary of it. */
export function parseSavedPresence(
  value: unknown,
  identity: Identity,
  registration: SavedRegistration,
): SavedPresence {
  const keys = Object.keys(identity) as (keyof Identity)[];
  if (
    !exact(value, [
      ...keys,
      "registration_revision",
      "report_revision",
      "current",
    ]) ||
    !isObject(value.current)
  )
    fail();
  if (
    keys.some((key) => value[key] !== identity[key]) ||
    value.registration_revision !== registration.registration_revision
  )
    throw new Error("Report belongs to another case or registration revision");
  const current = value.current as Record<string, unknown>,
    revision = integer(value.report_revision, 0, 1e9);
  if (current.status === "not_confirmed") {
    if (revision !== 0 || !exact(current, ["status"])) fail();
    return { report_revision: 0, current: { status: "not_confirmed" } };
  }
  if (
    revision < 1 ||
    typeof current.report_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(current.report_id)
  )
    fail();
  const report_id = current.report_id as string;
  if (current.status === "stale") {
    if (
      !exact(current, ["status", "report_id", "inputs", "result"]) ||
      current.inputs !== null ||
      current.result !== null
    )
      fail();
    return {
      report_revision: revision,
      current: { status: "stale", report_id },
    };
  }
  const binding = reportBinding(registration),
    dependencies = current.dependencies,
    result = current.result;
  if (
    current.status !== "current" ||
    !binding ||
    !exact(current, [
      "status",
      "report_id",
      "dependencies",
      "input_sha256",
      "inputs",
      "result",
    ]) ||
    typeof current.input_sha256 !== "string" ||
    !SHA.test(current.input_sha256) ||
    !exact(dependencies, [
      ...keys,
      "version",
      "registration_id",
      "registration_revision",
      "registration_input_sha256",
    ]) ||
    keys.some((key) => dependencies[key] !== identity[key]) ||
    dependencies.version !== PRESENCE_REPORT_VERSION ||
    dependencies.registration_id !== binding.registration_id ||
    dependencies.registration_revision !== binding.registration_revision ||
    dependencies.registration_input_sha256 !== binding.registration_input_sha256
  )
    fail();
  const inputs = parseInputs(current.inputs);
  if (!bound(inputs, binding)) fail();
  const summary = summarizeReport(inputs),
    // The server rounds lengths to a thousandth of a millimeter.
    near = (reported: unknown, expected: number) =>
      typeof reported === "number" && Math.abs(reported - expected) <= 0.001;
  if (
    !exact(result, [
      "version",
      "method",
      "segment_method",
      "status",
      "validated",
      "cause",
      "counts_source",
      "segment_count",
      "segment_length_mm",
      "unassigned_fraction",
      "planes",
    ]) ||
    result.version !== PRESENCE_REPORT_VERSION ||
    result.method !== VESSEL_PRESENCE_METHOD ||
    result.segment_method !== VESSEL_SEGMENT_METHOD ||
    result.status !== "operator_confirmed_report" ||
    result.validated !== false ||
    result.cause !== "not_asserted" ||
    result.counts_source !== "browser_reported_not_recomputed" ||
    result.segment_count !== inputs.segments.length ||
    !near(
      result.segment_length_mm,
      inputs.segments.reduce((sum, segment) => sum + segment.length_mm, 0),
    ) ||
    result.unassigned_fraction !== inputs.unassigned_fraction ||
    !Array.isArray(result.planes) ||
    result.planes.length !== summary.length ||
    !result.planes.every(
      (plane, k) =>
        exact(plane, [
          "plane",
          "classes",
          "unmatched_count",
          "unmatched_length_mm",
        ]) &&
        plane.plane === summary[k].plane &&
        plane.unmatched_count === summary[k].unmatched_count &&
        near(plane.unmatched_length_mm, summary[k].unmatched_length_mm) &&
        exact(plane.classes, PRESENCE_CLASSES) &&
        PRESENCE_CLASSES.every((name) => {
          const entry = (plane.classes as Record<string, unknown>)[name];
          return (
            exact(entry, ["count", "length_mm"]) &&
            entry.count === summary[k].classes[name].count &&
            near(entry.length_mm, summary[k].classes[name].length_mm)
          );
        }),
    )
  )
    fail();
  return {
    report_revision: revision,
    current: { status: "current", report_id, inputs },
  };
}

/** The report to save, from what the browser computed for a registration. */
export function reportInputs(
  registration: SavedRegistration,
  segments: VesselSegments,
  presence: VesselPresence,
): PresenceReportInputs {
  const binding = reportBinding(registration);
  if (
    !binding ||
    presence.planes.length !== binding.planes.length ||
    segments.segments.length > PRESENCE_REPORT_LIMITS.max_segments
  )
    throw new Error("The report does not belong to this registration");
  return {
    confirmed: true,
    registration_id: binding.registration_id,
    registration_revision: binding.registration_revision,
    registration_input_sha256: binding.registration_input_sha256,
    method: VESSEL_PRESENCE_METHOD,
    segment_method: VESSEL_SEGMENT_METHOD,
    pooling: segments.pooling,
    unassigned_fraction: segments.unassigned_fraction,
    segments: segments.segments.map((segment) => ({
      length_mm: segment.length_mm,
      mean_radius_mm: segment.mean_radius_mm,
      sample_count: segment.sample_count,
      run: segment.run,
    })),
    planes: presence.planes.map((plane, k) => {
      if (
        plane.segments.length !== segments.segments.length ||
        plane.unmatched.length > PRESENCE_REPORT_LIMITS.max_unmatched
      )
        throw new Error("The report is too large to save");
      return {
        ...binding.planes[k],
        segments: plane.segments.map((entry) => ({
          presence: entry.class,
          in_field: entry.in_field,
          clear: entry.clear,
          supported: entry.supported,
        })),
        unmatched_mm: plane.unmatched.map((piece) => piece.length_mm),
      };
    }),
  };
}

/** How a recomputed report differs from the saved one, in words, or null
 * when the two agree. Counts and classes are compared exactly; lengths and
 * radii to a part in a million, since they pass through arithmetic that
 * may round differently in another browser. */
export function reportDifference(
  saved: PresenceReportInputs,
  computed: PresenceReportInputs,
): string | null {
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  if (
    saved.registration_id !== computed.registration_id ||
    saved.registration_revision !== computed.registration_revision ||
    saved.registration_input_sha256 !== computed.registration_input_sha256 ||
    saved.planes.length !== computed.planes.length ||
    saved.planes.some(
      (plane, k) =>
        plane.plane !== computed.planes[k].plane ||
        plane.frame_sha256 !== computed.planes[k].frame_sha256,
    )
  )
    return "it was computed for another registration";
  if (
    saved.segments.length !== computed.segments.length ||
    saved.pooling !== computed.pooling ||
    !close(saved.unassigned_fraction, computed.unassigned_fraction) ||
    saved.segments.some((segment, k) => {
      const other = computed.segments[k];
      return (
        segment.run !== other.run ||
        segment.sample_count !== other.sample_count ||
        !close(segment.length_mm, other.length_mm) ||
        !close(segment.mean_radius_mm, other.mean_radius_mm)
      );
    })
  )
    return "the vessel mask gives other segments";
  for (const [k, plane] of saved.planes.entries()) {
    const other = computed.planes[k],
      changed = plane.segments.filter(
        (entry, index) =>
          entry.presence !== other.segments[index].presence ||
          entry.in_field !== other.segments[index].in_field ||
          entry.clear !== other.segments[index].clear ||
          entry.supported !== other.segments[index].supported,
      ).length;
    if (changed)
      return `${changed} of ${plane.segments.length} segments have other counts in plane ${plane.plane}`;
    if (
      plane.unmatched_mm.length !== other.unmatched_mm.length ||
      plane.unmatched_mm.some(
        (length, index) => !close(length, other.unmatched_mm[index]),
      )
    )
      return `the 2D vessel pieces with no segment near differ in plane ${plane.plane}`;
  }
  return null;
}
