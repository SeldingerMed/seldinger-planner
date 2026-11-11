/** Automatic rigid registration proposal and an unsaved draft preview for a
 * verified secondary source. Nothing here saves or confirms a registration. */
import type { NVImage } from "@niivue/niivue";
import { useEffect, useMemo, useRef, useState } from "react";
import { createNativeSampler } from "./nativeSampling";
import type { Vec3 } from "./obliqueSlice";
import { createFusionSampler, validateRigid } from "./rigidFusion";
import {
  createRegistrationJob,
  REGISTRATION_LIMITS,
  type RegistrationJob,
  type RegistrationProposal as Proposal,
} from "./rigidRegistration";

type Props = {
  primary: NVImage;
  secondary: NVImage;
  /** The draft matrix as the operator sees it. */
  matrixText: string;
  primaryWindow: [number, number];
  secondaryWindow: [number, number];
  opacity: number;
  disabled: boolean;
  /** Offers a proposed matrix to the draft. The owner may refuse it. */
  onPropose: (matrixText: string) => void;
};
type Scope = { primary: NVImage; secondary: NVImage; matrixText: string };
const SLICE_MS = 12,
  // A hidden tab has nothing on screen to keep responsive, and browsers run
  // its timers about once a second, so each slice uses most of that second.
  // A tab hidden for longer is given almost no processor time whatever the
  // slice: the run then waits, and continues when the tab is shown again.
  HIDDEN_SLICE_MS = 800,
  PIXELS = 128;
const PLANES = [
  // Image right is patient left; image up is anterior, then superior.
  { name: "axial", right: [-1, 0, 0], up: [0, 1, 0] },
  { name: "coronal", right: [-1, 0, 0], up: [0, 0, 1] },
  // Image left is anterior; image up is superior.
  { name: "sagittal", right: [0, -1, 0], up: [0, 0, 1] },
] as const;

function parseMatrix(text: string): number[][] | null {
  try {
    return validateRigid(JSON.parse(text));
  } catch {
    return null;
  }
}

/** What the status line says of the starting matrix. A start under the
 * overlap floor has a score of zero that is not a measurement, so it is
 * described instead of shown. */
export function startScoreText({
  start_score,
  start_overlap,
}: Pick<Proposal, "start_score" | "start_overlap">): string {
  if (start_overlap >= REGISTRATION_LIMITS.min_overlap)
    return `starting matrix ${start_score.toFixed(3)}`;
  // Rounded as the proposal's own share is, but never up to the floor: a
  // start just under it must not read as having met it.
  const percent = Math.min(
    Math.round(start_overlap * 100),
    Math.round(REGISTRATION_LIMITS.min_overlap * 100) - 1,
  );
  return `the starting matrix put only ${percent}% of the secondary inside the primary and was not scored`;
}

export default function RegistrationProposal({
  primary,
  secondary,
  matrixText,
  primaryWindow,
  secondaryWindow,
  opacity,
  disabled,
  onPropose,
}: Props) {
  const [run, setRun] = useState<(Scope & { job: RegistrationJob }) | null>(
      null,
    ),
    [outcome, setOutcome] = useState<
      (Scope & { proposal?: Proposal; failure?: string }) | null
    >(null);
  const offer = useRef(onPropose);
  offer.current = onPropose;
  const same = (scope: Scope | null) =>
    !!scope &&
    scope.primary === primary &&
    scope.secondary === secondary &&
    scope.matrixText === matrixText;
  // A run belongs to the volumes and the matrix it started from. Any change
  // to them, or the owner becoming busy, drops it before it can report.
  const active = !disabled && same(run) ? run : null;
  // Dropped for good: restoring the old inputs must not resume it.
  useEffect(() => {
    if (run && !active) setRun(null);
  }, [run, active]);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const { job, ...scope } = active;
    const slice = () => {
      const deadline =
        performance.now() + (document.hidden ? HIDDEN_SLICE_MS : SLICE_MS);
      try {
        if (!job.advance(() => performance.now() >= deadline)) {
          timer = setTimeout(slice, 0);
          return;
        }
        const proposal = job.result(),
          text = JSON.stringify(proposal.matrix);
        setRun(null);
        setOutcome({ ...scope, matrixText: text, proposal });
        offer.current(text);
      } catch (error) {
        setRun(null);
        setOutcome({
          ...scope,
          failure:
            error instanceof Error ? error.message : "Registration failed",
        });
      }
    };
    timer = setTimeout(slice, 0);
    return () => clearTimeout(timer);
  }, [active]);

  const matrix = useMemo(() => parseMatrix(matrixText), [matrixText]);
  function start() {
    if (disabled || !matrix) return;
    setOutcome(null);
    setRun({
      primary,
      secondary,
      matrixText,
      job: createRegistrationJob(primary, secondary, matrix),
    });
  }
  // An outcome is shown only for the exact draft it describes.
  const shown = same(outcome) ? outcome : null,
    proposal = shown?.proposal;

  // Scalars, so a caller's fresh window arrays do not redraw the preview.
  const [primaryLow, primaryHigh] = primaryWindow,
    [secondaryLow, secondaryHigh] = secondaryWindow;
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]),
    [previewError, setPreviewError] = useState(false);
  useEffect(() => {
    setPreviewError(false);
    if (!matrix) return;
    try {
      const fusion = createFusionSampler(primary, secondary, matrix, {
          primary_window: [primaryLow, primaryHigh],
          secondary_window: [secondaryLow, secondaryHigh],
          opacity,
        }),
        native = secondary.getAffine(),
        shape = createNativeSampler(secondary).shape,
        middle = shape.map((n) => (n - 1) / 2),
        at = (m: number[][], p: number[]) =>
          m
            .slice(0, 3)
            .map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]) as Vec3,
        center = at(matrix, at(native, middle)),
        // The box of the secondary as the draft matrix turns it, so that a
        // turned volume keeps its corners in frame.
        corners = Array.from({ length: 8 }, (_, c) =>
          at(
            matrix,
            at(
              native,
              shape.map((n, j) => ((c >> j) & 1 ? n - 0.5 : -0.5)),
            ),
          ),
        ),
        extent = Math.max(
          ...[0, 1, 2].map(
            (k) =>
              Math.max(...corners.map((p) => p[k])) -
              Math.min(...corners.map((p) => p[k])),
          ),
        ),
        mm = Math.min(300, Math.max(40, 1.25 * extent)) / PIXELS;
      PLANES.forEach((plane, index) => {
        const context = canvases.current[index]?.getContext("2d");
        if (!context) return;
        const image = context.createImageData(PIXELS, PIXELS);
        for (let row = 0, o = 0; row < PIXELS; row++)
          for (let column = 0; column < PIXELS; column++, o += 4) {
            const u = (column - (PIXELS - 1) / 2) * mm,
              v = ((PIXELS - 1) / 2 - row) * mm,
              sample = fusion.sample(
                center.map(
                  (c, k) => c + u * plane.right[k] + v * plane.up[k],
                ) as Vec3,
              );
            image.data.set(sample.rgba, o);
          }
        context.putImageData(image, 0, 0);
      });
    } catch (error) {
      // The status line cannot tell an unsupported pair from a defect in
      // the sampling; the console can.
      console.warn("Draft registration preview failed", error);
      setPreviewError(true);
    }
  }, [
    primary,
    secondary,
    matrix,
    primaryLow,
    primaryHigh,
    secondaryLow,
    secondaryHigh,
    opacity,
  ]);

  return (
    <div className="registration-proposal">
      <button
        type="button"
        disabled={disabled || (!active && !matrix)}
        onClick={() => (active ? setRun(null) : start())}
      >
        {active ? "Cancel registration proposal" : "Propose rigid registration"}
      </button>
      <p className="registration-note">
        Searches translation across the primary volume and turns of up to{" "}
        {REGISTRATION_LIMITS.rotation_deg}° about each primary RAS axis from the
        matrix above, which can combine into a larger turn, by image intensity
        alone. At least {Math.round(REGISTRATION_LIMITS.min_overlap * 100)}% of
        the secondary must lie inside the primary. It is a proposal to check and
        correct, not a validated registration, and it cannot tell that two
        sources show different anatomy.
      </p>
      <p role="status">
        {active
          ? "Computing registration proposal… This waits while the tab is in the background."
          : proposal
            ? `Proposed matrix entered above: moved ${proposal.translation_mm.toFixed(1)} mm and ${proposal.rotation_deg.toFixed(1)}° from the starting matrix. Normalized mutual information ${proposal.score.toFixed(3)} (${startScoreText(proposal)}), with ${Math.round(proposal.overlap * 100)}% of the secondary inside the primary. The score is not an accuracy measure. The secondary was compared in ${proposal.sample_mm.toFixed(1)} mm blocks. Review the draft preview before confirming.`
            : ""}
      </p>
      {shown?.failure && (
        <p role="alert">
          Registration proposal failed: {shown.failure}. The matrix is
          unchanged.
        </p>
      )}
      {/* The canvases stay mounted through a failure, hidden: the effect
          draws before a figure it had removed could be put back. */}
      {matrix && (
        <figure hidden={previewError}>
          <div className="registration-preview">
            {PLANES.map((plane, index) => (
              <canvas
                key={plane.name}
                ref={(node) => {
                  canvases.current[index] = node;
                }}
                width={PIXELS}
                height={PIXELS}
                role="img"
                aria-label={`Draft registration preview, ${plane.name}`}
              />
            ))}
          </div>
          <figcaption>
            Draft registration preview · not saved or confirmed · axial, coronal
            and sagittal planes through the secondary volume center. Gray:
            primary. Cyan: secondary under the matrix above. Axial and coronal:
            image right is patient left. Sagittal: image left is anterior.
          </figcaption>
        </figure>
      )}
      {(!matrix || previewError) && (
        <p role="status">
          {matrix
            ? "Draft registration preview is unavailable for these sources."
            : "Enter a valid rigid matrix to preview or propose a registration."}
        </p>
      )}
    </div>
  );
}
