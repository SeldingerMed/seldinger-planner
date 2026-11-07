import { useEffect, useMemo, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import { planeBasis, sampleObliqueSlice, type Vec3 } from "./obliqueSlice";

type Section = {
  plane_origin: Vec3;
  plane_normal: Vec3;
  contour_world: number[][];
};
type Paint = {
  volume: NVImage;
  section: Section;
  windowKey: string;
  url: string;
  outside: number;
};
export default function ObliqueSection({
  section,
  volume,
  windowRange = [0, 600],
}: {
  section: Section;
  volume: NVImage | null;
  windowRange?: [number, number];
}) {
  const [paint, setPaint] = useState<Paint | null>(null);
  const [failure, setFailure] = useState<{
    volume: NVImage;
    section: Section;
    windowKey: string;
  } | null>(null);
  const windowKey = windowRange.join(":");
  const projection = useMemo(() => {
    try {
      const [u, v] = planeBasis(section.plane_normal);
      if (
        section.contour_world.length < 3 ||
        section.contour_world.length > 4096 ||
        !section.plane_origin.every(Number.isFinite)
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
      const bounds = {
        minX: Math.min(...pts.map((p) => p[0])) - 4,
        maxX: Math.max(...pts.map((p) => p[0])) + 4,
        minY: Math.min(...pts.map((p) => p[1])) - 4,
        maxY: Math.max(...pts.map((p) => p[1])) + 4,
      };
      const path =
        pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ") + " Z";
      return { u, v, bounds, path };
    } catch {
      return null;
    }
  }, [section]);
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
      setPaint({ volume, section, windowKey, url, outside: result.outside });
      setFailure(null);
    } catch {
      setFailure({ volume, section, windowKey });
      setPaint(null);
    }
  }, [volume, section, projection, windowKey]);
  const current =
    volume &&
    paint?.volume === volume &&
    paint.section === section &&
    paint.windowKey === windowKey
      ? paint
      : null;
  const failed =
    volume &&
    failure?.volume === volume &&
    failure.section === section &&
    failure.windowKey === windowKey;
  if (!projection) return <span>Section view unavailable</span>;
  const { minX, maxX, minY, maxY } = projection.bounds;
  return (
    <figure className={`oblique-section${volume ? " has-native-cta" : ""}`}>
      <svg
        className="morphometry-contour"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={
          current
            ? "Oblique CTA with accepted mask contour"
            : "Section contour in its own plane"
        }
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
        <path d={projection.path} className="morphometry-contour-path" />
      </svg>
      {volume && (
        <figcaption>
          {current
            ? "Native CTA · accepted-mask contour"
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
