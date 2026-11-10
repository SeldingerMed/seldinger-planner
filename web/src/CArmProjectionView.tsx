import { useEffect, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { angleLabel, type ViewNumbers } from "./carmGeometry";
import {
  createProjectionJob,
  projectOverlay,
  type ProjectionImage,
  type ProjectionJob,
} from "./carmProjection";
import { stable } from "./territoryWorkflow";
import type { Vec3 } from "./obliqueSlice";

type Props = {
  identityKey: string;
  volume: NVImage | null;
  view: ViewNumbers | null;
  isocenter: Vec3 | null;
  path: Vec3[];
  threshold: number | null;
  disabled?: boolean;
};
type Paint = { gateKey: string; volume: NVImage; image: ProjectionImage };
const LONG_SIDE_PX = 160;
const STEP_MM = 1;
/** Main-thread time one render slice may hold before yielding to input. */
const SLICE_MS = 12;

/** Display-only simulated projection with the target path drawn over it. */
export default function CArmProjectionView({
  identityKey,
  volume,
  view,
  isocenter,
  path,
  threshold,
  disabled = false,
}: Props) {
  const gateKey = `${identityKey}|${stable(view)}|${stable(isocenter)}|${threshold}|${disabled}`;
  const pathKey = stable(path);
  const [paint, setPaint] = useState<Paint | null>(null),
    [error, setError] = useState(""),
    [overlayNote, setOverlayNote] = useState("");
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const ready = !!volume && !!view && !!isocenter && threshold !== null;
  const current =
    ready &&
    paint !== null &&
    paint.gateKey === gateKey &&
    paint.volume === volume
      ? paint
      : null;

  useEffect(() => {
    if (!volume || !view || !isocenter || threshold === null || disabled) {
      setPaint(null);
      setError("");
      return;
    }
    // The ray sum runs in short slices so typing in an angle field stays
    // responsive. The cleanup clears the pending slice, which drops a
    // superseded or unmounted view before it can finish or set state.
    let job: ProjectionJob | null = null,
      timer: ReturnType<typeof setTimeout>;
    const slice = () => {
      try {
        if (!job) {
          const aspect = view.detector_height_mm / view.detector_width_mm;
          job = createProjectionJob(volume, view, isocenter, {
            width_px: Math.max(
              8,
              Math.round(aspect > 1 ? LONG_SIDE_PX / aspect : LONG_SIDE_PX),
            ),
            height_px: Math.max(
              8,
              Math.round(aspect > 1 ? LONG_SIDE_PX : LONG_SIDE_PX * aspect),
            ),
            step_mm: STEP_MM,
            threshold,
          });
        }
        const deadline = performance.now() + SLICE_MS;
        if (!job.advance(() => performance.now() >= deadline)) {
          timer = setTimeout(slice, 0);
          return;
        }
        setError("");
        setPaint({ gateKey, volume, image: job.image() });
      } catch (failure) {
        setPaint(null);
        setError(
          failure instanceof Error
            ? failure.message
            : "Simulated projection failed",
        );
      }
    };
    timer = setTimeout(slice, 0);
    return () => clearTimeout(timer);
  }, [gateKey, volume]);

  useEffect(() => {
    if (!current || !view || !isocenter) return;
    const { image } = current;
    let context: CanvasRenderingContext2D | null | undefined;
    try {
      context = canvas.current?.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const pixels = context.createImageData(image.width, image.height);
      pixels.data.set(image.rgba);
      context.putImageData(pixels, 0, 0);
    } catch {
      setPaint(null);
      setError("Simulated projection canvas could not be painted");
      return;
    }
    try {
      const overlay = projectOverlay(view, isocenter, path, image);
      context.lineWidth = 1;
      context.strokeStyle = "#ffb000";
      context.beginPath();
      overlay.path.forEach(([x, y], index) =>
        index === 0 ? context.moveTo(x, y) : context.lineTo(x, y),
      );
      context.stroke();
      context.strokeStyle = "#39c5e8";
      context.beginPath();
      const [cx, cy] = overlay.isocenter;
      context.moveTo(cx - 4, cy);
      context.lineTo(cx + 4, cy);
      context.moveTo(cx, cy - 4);
      context.lineTo(cx, cy + 4);
      context.stroke();
      setOverlayNote("");
    } catch {
      setOverlayNote(
        " The target path cannot be projected in this view, so it is not drawn.",
      );
    }
  }, [current, pathKey]);

  if (!current || !view) {
    return (
      <div className="native-render-grid">
        <p>
          {error
            ? error
            : !volume
              ? "No verified source volume is loaded."
              : !isocenter
                ? "Set an isocenter to preview a simulated projection."
                : !view
                  ? "Enter valid view values to preview a simulated projection."
                  : threshold === null
                    ? "Enter a valid projection threshold to preview a simulated projection."
                    : disabled
                      ? "Simulated projection paused."
                      : "Computing simulated projection…"}
        </p>
      </div>
    );
  }
  const { image } = current;
  return (
    <div className="native-render-grid">
      <figure className="native-render-figure carm-figure">
        <canvas
          ref={canvas}
          width={image.width}
          height={image.height}
          aria-label="Simulated projection of the source volume in the edited C-arm view"
        />
        <figcaption>
          Simulated projection ·{" "}
          {angleLabel(view.primary_deg, view.secondary_deg)} · ray sum of
          intensity above {threshold} at {STEP_MM} mm steps ·{" "}
          {image.rays_through_volume} of {image.width * image.height} rays cross
          the volume. Computed from this source; bone and calcium are not
          removed. Not an acquired angiogram. Image right is the patient&apos;s
          left at 0/0. Orange: target path. Blue cross: isocenter.
          {overlayNote}
        </figcaption>
      </figure>
    </div>
  );
}
