/** The vessel axis of a saved 2D-to-3D proposal over the frames of a
 * recording. The saved pose is kept. A frame taken at other C-arm angles
 * or another field size than the saved frame, by the recording's frame
 * table, is given the saved view turned and sized by that change, so the
 * axis turns with the C-arm. */
import { VIEW_LIMITS, type ViewNumbers } from "./carmGeometry";
import type { Vec3 } from "./obliqueSlice";
import { projectRegistered } from "./projectionRegistration";
import type { RecordingSidecar } from "./recordingSidecar";

export const REPLAY_OVERLAY_METHOD = "saved_pose_at_frame_angles_v1";
export const REPLAY_LIMITS = {
  /** Views whose placed axis is kept. */
  kept_views: 32,
  /** Least likeness of the recording's frame to the saved frame. */
  like: 0.9,
} as const;

export type ReplayPlane = {
  /** The view of the saved proposal's plane. */
  view: ViewNumbers;
  isocenter: Vec3;
  matrix: number[][];
  /** Vessel axis points in volume millimeters, three numbers each. */
  points: Float32Array;
  /** Of the admitted frame. */
  size: { width: number; height: number };
  /** The saved frame's number in its recording. */
  frame_index: number;
};

const within = (value: number, [low, high]: readonly [number, number]) =>
  value >= low && value <= high;

/** The view frame `frame` was taken in, given that frame `confirmed` was
 * taken in the saved view. Null where the angles or the field would be
 * beyond what a view can have. Where the table has no reading the saved
 * view stands. */
export function frameView(
  saved: ViewNumbers,
  sidecar: RecordingSidecar,
  confirmed: number,
  frame: number,
): ViewNumbers | null {
  for (const k of [confirmed, frame])
    if (!Number.isInteger(k) || k < 0 || k >= sidecar.frames)
      throw new Error("The frame is not in the recording");
  const change = (values: Float32Array) => {
      const by = values[frame] - values[confirmed];
      return Number.isNaN(by) ? 0 : by;
    },
    turned = change(sidecar.primary_deg),
    tilted = change(sidecar.secondary_deg),
    field = sidecar.field_cm[frame] / sidecar.field_cm[confirmed],
    wider = Number.isNaN(field) ? 1 : field;
  if (!turned && !tilted && wider === 1) return saved;
  let primary = saved.primary_deg + turned;
  while (primary > 180) primary -= 360;
  while (primary < -180) primary += 360;
  const view = {
    ...saved,
    primary_deg: primary,
    secondary_deg: saved.secondary_deg + tilted,
    detector_width_mm: saved.detector_width_mm * wider,
    detector_height_mm: saved.detector_height_mm * wider,
  };
  return within(view.secondary_deg, VIEW_LIMITS.secondary_deg) &&
    within(view.detector_width_mm, VIEW_LIMITS.detector_width_mm) &&
    within(view.detector_height_mm, VIEW_LIMITS.detector_height_mm)
    ? view
    : null;
}

export type ReplayOverlay = {
  /** The frame's view, or null. */
  view(frame: number): ViewNumbers | null;
  /** Frame pixel coordinates of the axis points (NaN for a point that is
   * not projected), or null where the frame has no view. The same array is
   * given again for the same view; it is not to be written. */
  pixels(frame: number): Float32Array | null;
};

export function createReplayOverlay(
  plane: ReplayPlane,
  sidecar: RecordingSidecar,
): ReplayOverlay {
  if (
    !Number.isInteger(plane.frame_index) ||
    plane.frame_index < 0 ||
    plane.frame_index >= sidecar.frames
  )
    throw new Error("The saved frame is not in the recording");
  const kept = new Map<string, Float32Array>(),
    view = (frame: number) =>
      frameView(plane.view, sidecar, plane.frame_index, frame);
  return {
    view,
    pixels(frame) {
      const seen = view(frame);
      if (!seen) return null;
      const key = `${seen.primary_deg}|${seen.secondary_deg}|${seen.detector_width_mm}`;
      let placed = kept.get(key);
      if (!placed) {
        placed = projectRegistered(
          seen,
          plane.isocenter,
          plane.matrix,
          plane.points,
          plane.size,
        );
        if (kept.size >= REPLAY_LIMITS.kept_views)
          kept.delete(kept.keys().next().value as string);
        kept.set(key, placed);
      }
      return placed;
    },
  };
}

function rate(duration_s: number, frames: number) {
  if (
    !Number.isFinite(duration_s) ||
    duration_s <= 0 ||
    !Number.isInteger(frames) ||
    frames < 1
  )
    throw new Error("Invalid recording length");
  return frames / duration_s;
}

/** The frame shown at a media time, for a recording of `frames` frames at an
 * even rate over its length. A frame begins at its number over the rate; a
 * time just short of that by rounding still names it. */
export function frameAt(media_s: number, duration_s: number, frames: number) {
  const at = Math.floor(media_s * rate(duration_s, frames) + 0.01);
  return Math.min(frames - 1, Math.max(0, at));
}

/** The media time at the middle of a frame. */
export function timeOf(frame: number, duration_s: number, frames: number) {
  return (frame + 0.5) / rate(duration_s, frames);
}

/** Where the admitted crop lies in the picture the browser decoded: the
 * crop is in the pixels the frame was admitted from, and a browser may
 * decode the recording at another size. */
export function sourceRectangle(
  crop: readonly number[],
  source: { rows: number; columns: number },
  picture: { width: number; height: number },
): [number, number, number, number] {
  if (!(picture.width >= 1) || !(picture.height >= 1))
    throw new Error("Invalid picture size");
  const x = picture.width / source.columns,
    y = picture.height / source.rows;
  return [crop[0] * x, crop[1] * y, crop[2] * x, crop[3] * y];
}

/** Correlation of the brightness of two pictures of one size: 1 for the same
 * picture whatever its brightness and contrast, 0 for a flat one. */
export function likeness(a: Uint8Array, b: Uint8Array): number {
  const n = a.length;
  if (!n || b.length !== n) throw new Error("Invalid pictures");
  let sa = 0,
    sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n,
    mb = sb / n;
  let ab = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma,
      db = b[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
