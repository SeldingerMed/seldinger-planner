/** When contrast reaches each segment of the 3D vessel mask, read from the
 * frames of one run under one registration.
 *
 * A segment's brightness in a frame is the mean under its axis samples. Its
 * filling in a frame is how far that is from the frame of the run in which
 * the segment is least filled, and its arrival is where along the run the
 * filling first reaches half its peak. A segment as full in every frame of the run, or
 * never filled, shows no change and has no arrival. Frames are counted by
 * their number in the source; no time is known here. A vessel that lies
 * over the segment in the frame fills the same pixels, so a segment under
 * another can read early. */
import type { Polarity } from "./vesselness2d";
import type { VesselSegments } from "./vesselSegments";

export const CONTRAST_ARRIVAL_METHOD = "segment_half_peak_v1";
export const CONTRAST_ARRIVAL_LIMITS = {
  min_frames: 3,
  max_frames: 8,
  /** A segment with a smaller share of its samples in the frame is outside
   * the field. */
  min_in_field: 0.5,
  /** Brightness levels a segment's filling must change by over the run. */
  min_peak: 6,
  /** Share of the peak that counts as arrived. */
  level: 0.5,
} as const;

export type ArrivalState =
  /** Arrives between two frames of the run. */
  | "arrives"
  /** Filled to half its peak in the run's first frame already. */
  | "filled_from_first"
  /** As full in every frame: filled throughout, or never. */
  | "no_change"
  | "outside_field";
export type SegmentArrival = {
  state: ArrivalState;
  /** Source frame number, between two frames' numbers where the filling
   * crosses the level between them. Null unless the state is "arrives" or
   * "filled_from_first". */
  arrival: number | null;
  /** Brightness levels at the fullest frame. */
  peak: number;
  /** Filling in each frame, in brightness levels. */
  filling: number[];
};
export type ArrivalInput = {
  segments: VesselSegments;
  /** Frame pixel coordinates of the axis samples, two per sample. */
  pixels: Float32Array;
  width: number;
  height: number;
  polarity: Polarity;
  /** Frames of one run, in the order they were taken. */
  frames: { index: number; gray: Uint8Array }[];
};

export function contrastArrival(input: ArrivalInput): SegmentArrival[] {
  const L = CONTRAST_ARRIVAL_LIMITS,
    { width: w, height: h, frames, pixels } = input,
    { labels } = input.segments,
    count = labels.length;
  if (
    !Array.isArray(frames) ||
    frames.length < L.min_frames ||
    frames.length > L.max_frames
  )
    throw new Error("Contrast arrival needs three to eight frames of a run");
  if (
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 3 ||
    h < 3 ||
    frames.some(
      (frame, i) =>
        frame.gray.length !== w * h ||
        !Number.isInteger(frame.index) ||
        (i > 0 && frame.index <= frames[i - 1].index),
    )
  )
    throw new Error("Frames of a run must be one size and in order");
  if (pixels.length !== 2 * count) throw new Error("Invalid vessel segments");
  const sign = input.polarity === "dark" ? -1 : 1,
    sums = input.segments.segments.map(() => frames.map(() => 0)),
    inField = input.segments.segments.map(() => 0),
    total = input.segments.segments.map(() => 0);
  for (let k = 0; k < count; k++) {
    total[labels[k]]++;
    const x = pixels[2 * k],
      y = pixels[2 * k + 1];
    if (!(x >= 0 && y >= 0 && x <= w && y <= h)) continue;
    inField[labels[k]]++;
    // Three by three pixels around the sample, kept inside the frame.
    const cx = Math.min(w - 2, Math.max(1, Math.floor(x))),
      cy = Math.min(h - 2, Math.max(1, Math.floor(y))),
      into = sums[labels[k]];
    frames.forEach(({ gray }, f) => {
      let sum = 0;
      for (let j = cy - 1; j <= cy + 1; j++)
        for (let i = cx - 1; i <= cx + 1; i++) sum += gray[j * w + i];
      into[f] += (sign * sum) / 9;
    });
  }
  return sums.map((sum, index): SegmentArrival => {
    if (inField[index] < L.min_in_field * total[index] || !inField[index])
      return {
        state: "outside_field",
        arrival: null,
        peak: 0,
        filling: frames.map(() => 0),
      };
    // The least filled frame is taken over the whole segment, so that the
    // noise of single pixels does not read as filling.
    const empty = Math.min(...sum),
      filling = sum.map((value) => (value - empty) / inField[index]),
      peak = Math.max(...filling);
    if (peak < L.min_peak)
      return { state: "no_change", arrival: null, peak, filling };
    const level = L.level * peak,
      at = filling.findIndex((value) => value >= level);
    if (at === 0)
      return {
        state: "filled_from_first",
        arrival: frames[0].index,
        peak,
        filling,
      };
    const share = (level - filling[at - 1]) / (filling[at] - filling[at - 1]);
    return {
      state: "arrives",
      arrival:
        frames[at - 1].index +
        share * (frames[at].index - frames[at - 1].index),
      peak,
      filling,
    };
  });
}
