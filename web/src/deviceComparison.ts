/** A planned device that lies along a vessel, against where the deployed
 * device's two ends were marked.
 *
 * The planned device covers a stretch of its planning path. Each marked end
 * is a point of the 3D volume (a mark in a frame carried to the vessel
 * axis). It is dropped onto the path, and the deployed device is read as
 * the stretch of path between the two. */
import type { Vec3 } from "./obliqueSlice";

export const DEVICE_COMPARISON_METHOD = "ends_on_planned_path_v1";

export type PlannedSpan = {
  /** The planning path, in the RAS millimeters of the volume. */
  path: readonly (readonly number[])[];
  /** Where the device starts along the path, and how long it is. */
  offset: number;
  length: number;
};
export type DeviceEnd = {
  /** How far along the path the marked end lies from the planned end;
   * positive is toward the path's end. */
  shift_mm: number;
  /** Distance of the marked end from the path. */
  off_path_mm: number;
};
export type DeviceComparison = {
  planned_length_mm: number;
  /** Along the path, between the two marked ends. */
  deployed_length_mm: number;
  /** The end nearer the path's start, then the other. */
  ends: [DeviceEnd, DeviceEnd];
};

const finite = (p: unknown) =>
  Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

/** Arc length along the path at each of its points, or null for a device
 * that does not lie on its path. */
function lengths({ path, offset, length }: PlannedSpan): number[] | null {
  if (!Array.isArray(path) || path.length < 2 || !path.every(finite))
    return null;
  const cum = [0];
  for (let i = 1; i < path.length; i++)
    cum.push(
      cum[i - 1] +
        Math.hypot(
          path[i][0] - path[i - 1][0],
          path[i][1] - path[i - 1][1],
          path[i][2] - path[i - 1][2],
        ),
    );
  return Number.isFinite(offset) &&
    Number.isFinite(length) &&
    offset >= 0 &&
    length > 0 &&
    offset + length <= cum[cum.length - 1] + 1e-6
    ? cum
    : null;
}

/** Whether a planned device lies on its path from end to end. */
export const liesOnPath = (planned: PlannedSpan) => lengths(planned) !== null;

export function compareDevice(
  planned: PlannedSpan,
  marked: readonly [Vec3, Vec3],
): DeviceComparison {
  const { path, offset, length } = planned,
    cum = lengths(planned);
  if (!cum) throw new Error("Invalid planned device");
  if (!Array.isArray(marked) || marked.length !== 2 || !marked.every(finite))
    throw new Error("Two marked ends are required");
  /** The nearest place of the path to a point: how far along, how far off. */
  const onto = (p: Vec3) => {
    let best = { along: 0, off: Infinity };
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1],
        ab = [0, 1, 2].map((j) => path[i][j] - a[j]),
        ap = [0, 1, 2].map((j) => p[j] - a[j]),
        span = cum[i] - cum[i - 1];
      if (!(span > 0)) continue;
      const t = Math.max(
          0,
          Math.min(
            1,
            (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / span ** 2,
          ),
        ),
        off = Math.hypot(
          ap[0] - t * ab[0],
          ap[1] - t * ab[1],
          ap[2] - t * ab[2],
        );
      if (off < best.off) best = { along: cum[i - 1] + t * span, off };
    }
    return best;
  };
  const [first, second] = marked.map(onto).sort((a, b) => a.along - b.along);
  return {
    planned_length_mm: length,
    deployed_length_mm: second.along - first.along,
    ends: [
      { shift_mm: first.along - offset, off_path_mm: first.off },
      { shift_mm: second.along - (offset + length), off_path_mm: second.off },
    ],
  };
}
