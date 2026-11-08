import { useEffect, useMemo, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import {
  planeBasis,
  sampleObliqueSlice,
  type Vec3,
  type PlaneBounds,
} from "./obliqueSlice";

type Section = {
  plane_origin: Vec3;
  plane_normal: Vec3;
  contour_world: number[][];
};
type Paint = {
  volume: NVImage;
  section: Section;
  windowKey: string;
  boundsKey: string;
  url: string;
  outside: number;
};

/** Map a screen click to true plane coordinates via the SVG user-space
 * transform (getScreenCTM().inverse()), preferring SVGPoint then DOMPoint. */
export function screenToPlane(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM?.();
  if (
    !ctm ||
    ![ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f].every(Number.isFinite)
  )
    return null;
  let m: { a: number; b: number; c: number; d: number; e: number; f: number };
  try {
    m = ctm.inverse();
  } catch {
    return null;
  }
  if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) return null;
  try {
    const pt = svg.createSVGPoint?.();
    if (pt && typeof pt.matrixTransform === "function") {
      pt.x = clientX;
      pt.y = clientY;
      const t = pt.matrixTransform(m as DOMMatrix);
      if (Number.isFinite(t.x) && Number.isFinite(t.y))
        return { x: t.x, y: t.y };
    }
  } catch {
    /* fall through to DOMPoint */
  }
  try {
    const p = new DOMPoint(clientX, clientY, 0, 1);
    const t = p.matrixTransform(m as DOMMatrix);
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) return { x: t.x, y: t.y };
  } catch {
    return null;
  }
  return null;
}

export default function ObliqueSection({
  section,
  volume,
  windowRange = [0, 600],
  bounds,
  onPick,
  contourLabel,
}: {
  section: Section;
  volume: NVImage | null;
  windowRange?: [number, number];
  bounds?: PlaneBounds;
  onPick?: (ras: Vec3) => void;
  contourLabel?: string;
}) {
  const [paint, setPaint] = useState<Paint | null>(null);
  const [failure, setFailure] = useState<{
    volume: NVImage;
    section: Section;
    windowKey: string;
    boundsKey: string;
  } | null>(null);
  const windowKey = windowRange.join(":");
  const projection = useMemo(() => {
    try {
      const [u, v] = planeBasis(section.plane_normal);
      if (!section.plane_origin.every(Number.isFinite)) return null;
      let viewport: PlaneBounds;
      if (bounds) {
        if (
          ![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every(
            Number.isFinite,
          ) ||
          bounds.maxX - bounds.minX <= 0 ||
          bounds.maxY - bounds.minY <= 0
        )
          return null;
        viewport = bounds;
      } else {
        if (
          section.contour_world.length < 3 ||
          section.contour_world.length > 4096
        )
          return null;
        const pts = section.contour_world.map((p) => {
          if (p.length !== 3 || !p.every(Number.isFinite))
            throw new Error("Invalid contour");
          const d = p.map((x, i) => x - section.plane_origin[i]);
          return [
            d.reduce((s, x, i) => s + x * u[i], 0),
            d.reduce((s, x, i) => s + x * v[i], 0),
          ];
        });
        viewport = {
          minX: Math.min(...pts.map((p) => p[0])) - 4,
          maxX: Math.max(...pts.map((p) => p[0])) + 4,
          minY: Math.min(...pts.map((p) => p[1])) - 4,
          maxY: Math.max(...pts.map((p) => p[1])) + 4,
        };
      }
      const local = section.contour_world.map((p) => {
        if (p.length !== 3 || !p.every(Number.isFinite))
          throw new Error("Invalid contour");
        const d = p.map((x, i) => x - section.plane_origin[i]);
        return [
          d.reduce((s, x, i) => s + x * u[i], 0),
          d.reduce((s, x, i) => s + x * v[i], 0),
        ];
      });
      const path =
        local.length >= 1
          ? local.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ") +
            (local.length >= 3 ? " Z" : "")
          : "";
      return { u, v, bounds: viewport, path };
    } catch {
      return null;
    }
  }, [section, bounds]);
  const boundsKey = projection
    ? [
        projection.bounds.minX,
        projection.bounds.maxX,
        projection.bounds.minY,
        projection.bounds.maxY,
      ].join(":")
    : "";
  useEffect(() => {
    if (!volume || !projection) return;
    try {
      const result = sampleObliqueSlice(
        volume,
        section.plane_origin,
        section.plane_normal,
        projection.bounds,
        windowKey.split(":").map(Number) as [number, number],
      );
      const canvas = document.createElement("canvas");
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas2D unavailable");
      const data = ctx.createImageData(result.width, result.height);
      data.data.set(result.rgba);
      ctx.putImageData(data, 0, 0);
      const url = canvas.toDataURL("image/png");
      if (!url.startsWith("data:image/png"))
        throw new Error("Invalid image export");
      setPaint({
        volume,
        section,
        windowKey,
        boundsKey,
        url,
        outside: result.outside,
      });
      setFailure(null);
    } catch {
      setFailure({ volume, section, windowKey, boundsKey });
      setPaint(null);
    }
  }, [volume, section, projection, windowKey, boundsKey]);
  const current =
    volume &&
    paint?.volume === volume &&
    paint.section === section &&
    paint.windowKey === windowKey &&
    paint.boundsKey === boundsKey
      ? paint
      : null;
  const failed =
    volume &&
    failure?.volume === volume &&
    failure.section === section &&
    failure.windowKey === windowKey &&
    failure.boundsKey === boundsKey;
  if (!projection) return <span>Section view unavailable</span>;
  const { minX, maxX, minY, maxY } = projection.bounds;
  const label = contourLabel ?? "accepted mask contour";
  const handlePick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    const plane = screenToPlane(e.currentTarget, e.clientX, e.clientY);
    if (!plane) return;
    const { u, v } = projection;
    onPick([
      section.plane_origin[0] + u[0] * plane.x + v[0] * plane.y,
      section.plane_origin[1] + u[1] * plane.x + v[1] * plane.y,
      section.plane_origin[2] + u[2] * plane.x + v[2] * plane.y,
    ]);
  };
  return (
    <figure className={`oblique-section${volume ? " has-native-cta" : ""}`}>
      <svg
        className="morphometry-contour"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          current
            ? `Oblique CTA with ${label}`
            : "Section contour in its own plane"
        }
        onClick={handlePick}
      >
        {current && (
          <image
            href={current.url}
            x={minX}
            y={minY}
            width={maxX - minX}
            height={maxY - minY}
            preserveAspectRatio="none"
          />
        )}
        {projection.path && (
          <path d={projection.path} className="morphometry-contour-path" />
        )}
      </svg>
      {volume && (
        <figcaption>
          {current
            ? `Native CTA · ${label}`
            : failed
              ? "CTA plane unavailable · contour only"
              : "Sampling CTA plane…"}
          {current && (
            <small>
              Screen right RAS:{" "}
              {projection.u.map((n) => n.toFixed(2)).join(" / ")}
              <br />
              Screen down RAS:{" "}
              {projection.v.map((n) => n.toFixed(2)).join(" / ")}
              {current.outside > 0 && (
                <>
                  <br />
                  {current.outside} pixels outside image
                </>
              )}
            </small>
          )}
        </figcaption>
      )}
    </figure>
  );
}
