/** Interactive native-oblique section editor. Controlled: every plane edit and
 * contour pick is reported through onChange; nothing auto-confirms. Draft
 * coordinate strings apply only via the explicit Apply plane action, which
 * clears any prior contour. Plane viewport is an explicit field-of-view span.
 */
import { useMemo, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import ObliqueSection from "./ObliqueSection";
import { planeBasis, type Vec3, type PlaneBounds } from "./obliqueSlice";

export type Section = {
  origin: Vec3;
  normal: Vec3;
  contour: Vec3[];
};

const finite = (n: number) => Number.isFinite(n);

function parseVec3(text: string): Vec3 | null {
  const parts = text
    .split(/[,\s]+/)
    .filter((s) => s.length > 0)
    .map(Number);
  if (parts.length !== 3 || !parts.every(finite)) return null;
  return parts as Vec3;
}

const vec3Text = (v: Vec3) => v.map((n) => String(n)).join(", ");

export default function TerritorySectionEditor({
  value,
  onChange,
  volume,
  cursor,
  disabled = false,
  label,
}: {
  value: Section;
  onChange: (section: Section) => void;
  volume: NVImage | null;
  cursor: Vec3 | null;
  disabled?: boolean;
  label?: string;
}) {
  const [originDraft, setOriginDraft] = useState(vec3Text(value.origin));
  const [normalDraft, setNormalDraft] = useState(vec3Text(value.normal));
  const [spanDraft, setSpanDraft] = useState("40");
  const [error, setError] = useState<string | null>(null);

  const parsedSpan = Number(spanDraft);
  const span =
    finite(parsedSpan) && parsedSpan >= 1 && parsedSpan <= 200
      ? parsedSpan
      : 40;
  let basis: [Vec3, Vec3] | null = null;
  try {
    basis = planeBasis(value.normal);
  } catch {
    basis = null;
  }
  const viewport = useMemo<PlaneBounds>(
    () => ({
      minX: -span / 2,
      maxX: span / 2,
      minY: -span / 2,
      maxY: span / 2,
    }),
    [span],
  );
  const section = useMemo(
    () => ({
      plane_origin: value.origin,
      plane_normal: value.normal,
      contour_world: value.contour,
    }),
    [value.origin, value.normal, value.contour],
  );

  const guard = (): boolean => {
    if (disabled) {
      setError(null);
      return true;
    }
    return false;
  };

  const applyPlane = () => {
    if (guard()) return;
    const origin = parseVec3(originDraft);
    const normal = parseVec3(normalDraft);
    if (!origin || !normal) {
      setError("Origin and normal must be three finite numbers");
      return;
    }
    const len = Math.hypot(...normal);
    if (!finite(len) || len === 0) {
      setError("Normal must be nonzero");
      return;
    }
    setError(null);
    onChange({ origin, normal, contour: [] });
  };

  const useCursor = () => {
    if (guard() || !cursor) return;
    setOriginDraft(vec3Text(cursor));
    setError(null);
  };

  const pick = (ras: Vec3) => {
    if (guard()) return;
    onChange({ ...value, contour: [...value.contour, ras] });
  };

  const undoPoint = () => {
    if (guard() || value.contour.length === 0) return;
    onChange({ ...value, contour: value.contour.slice(0, -1) });
  };

  const clearContour = () => {
    if (guard() || value.contour.length === 0) return;
    onChange({ ...value, contour: [] });
  };

  return (
    <section
      className="territory-section-editor"
      aria-label={label ?? "Section editor"}
    >
      <div className="territory-section-plane">
        <label>
          Plane origin (RAS mm)
          <input
            value={originDraft}
            disabled={disabled}
            onChange={(e) => setOriginDraft(e.target.value)}
            aria-label="Plane origin"
          />
        </label>
        <label>
          Plane normal (RAS)
          <input
            value={normalDraft}
            disabled={disabled}
            onChange={(e) => setNormalDraft(e.target.value)}
            aria-label="Plane normal"
          />
        </label>
        <label>
          Field of view span (mm, 1–200)
          <input
            value={spanDraft}
            disabled={disabled}
            onChange={(e) => setSpanDraft(e.target.value)}
            aria-label="Field of view span"
          />
        </label>
        <button type="button" disabled={disabled} onClick={useCursor}>
          Use cursor
        </button>
        <button type="button" disabled={disabled} onClick={applyPlane}>
          Apply plane
        </button>
        {error && (
          <p role="alert" className="territory-section-error">
            {error}
          </p>
        )}
      </div>
      <ObliqueSection
        section={section}
        volume={volume}
        bounds={basis ? viewport : undefined}
        onPick={pick}
        contourLabel="section contour"
      />
      <div className="territory-section-contour">
        <span>Contour points: {value.contour.length}</span>
        <button
          type="button"
          disabled={disabled || value.contour.length === 0}
          onClick={undoPoint}
        >
          Undo point
        </button>
        <button
          type="button"
          disabled={disabled || value.contour.length === 0}
          onClick={clearContour}
        >
          Clear contour
        </button>
      </div>
    </section>
  );
}
