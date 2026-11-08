import { useCallback, useEffect, useRef, useState } from "react";
import type { NVImage } from "@niivue/niivue";
import type { Vec3 } from "./obliqueSlice";
import { renderNativeScene, type ViewOptions } from "./nativeReformats";
import { stable } from "./territoryWorkflow";

type Scene = ReturnType<typeof renderNativeScene>;

/** Published only for the successfully computed scene currently displayed. */
export type RenderReceipt = {
  identityKey: string;
  volume: NVImage;
  secondaryVolume: NVImage | null;
  optionsKey: string;
  pathKey: string;
  provenance: Scene["provenance"];
};

type Props = {
  identityKey: string;
  volume: NVImage | null;
  path: Vec3[] | null;
  options: ViewOptions;
  secondary?: { volume: NVImage; transform: number[][] } | null;
  disabled?: boolean;
  onReceipt?: (receipt: RenderReceipt | null) => void;
};

type Paint = {
  gateKey: string;
  volume: NVImage;
  secondaryVolume: NVImage | null;
  scene: Scene;
};

/** One canvas raster, painted from real producer bytes via putImageData. */
function RasterCanvas(props: {
  label: string;
  caption: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  onFailure: () => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    try {
      if (!ctx) throw new Error("Canvas unavailable");
      const image = ctx.createImageData(props.width, props.height);
      image.data.set(props.rgba);
      ctx.putImageData(image, 0, 0);
    } catch {
      props.onFailure();
    }
  }, [props.rgba, props.width, props.height, props.onFailure]);
  return (
    <figure className="native-render-figure">
      <canvas
        ref={ref}
        width={props.width}
        height={props.height}
        aria-label={props.label}
      />
      <figcaption>{props.caption}</figcaption>
    </figure>
  );
}

/** Pure display of the native reformat producer. No fetch, save, export or
 * settings controls: the parent owns those and reads the render receipt. */
export default function NativeReformatView({
  identityKey,
  volume,
  path,
  options,
  secondary,
  disabled = false,
  onReceipt,
}: Props) {
  const optionsKey = stable(options);
  const pathKey = stable(path);
  const transformKey = stable(secondary?.transform ?? null);
  const secondaryVolume = secondary?.volume ?? null;
  const gateKey = `${identityKey}|${optionsKey}|${pathKey}|${transformKey}|${disabled}`;
  const [paint, setPaint] = useState<Paint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);
  const receiptRef = useRef<{
    key: string;
    volume: NVImage;
    secondary: NVImage | null;
  } | null>(null);

  // Synchronous gate: any change in identity, path, options, transform,
  // source references or disabled state hides the previous paint at once,
  // before the next asynchronous request repaints it.
  const current =
    paint !== null &&
    paint.gateKey === gateKey &&
    Object.is(paint.volume, volume) &&
    Object.is(paint.secondaryVolume, secondaryVolume);

  useEffect(() => {
    const run = ++runRef.current;
    const invalid = !volume || !path || disabled;
    if (invalid) {
      setPaint(null);
      setError(null);
      const receiptKey = null;
      if (receiptRef.current !== receiptKey) {
        receiptRef.current = receiptKey;
        onReceipt?.(null);
      }
      return;
    }
    const timer = setTimeout(() => {
      if (run !== runRef.current) return;
      try {
        const scene = renderNativeScene(
          volume,
          path,
          options,
          secondary ?? undefined,
        );
        if (run !== runRef.current) return;
        setError(null);
        setPaint({ gateKey, volume, secondaryVolume, scene });
        const receiptKey = `${gateKey}|owned`;
        if (
          receiptRef.current?.key !== receiptKey ||
          receiptRef.current.volume !== volume ||
          receiptRef.current.secondary !== secondaryVolume
        ) {
          receiptRef.current = {
            key: receiptKey,
            volume,
            secondary: secondaryVolume,
          };
          onReceipt?.({
            identityKey,
            volume,
            secondaryVolume,
            optionsKey,
            pathKey,
            provenance: scene.provenance,
          });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Native rendering failed");
        setPaint(null);
        if (receiptRef.current !== null) {
          receiptRef.current = null;
          onReceipt?.(null);
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [
    identityKey,
    volume,
    path,
    secondaryVolume,
    transformKey,
    optionsKey,
    pathKey,
    gateKey,
    options,
    secondary,
    disabled,
    onReceipt,
  ]);

  const paintFailed = useCallback(() => {
    setPaint(null);
    setError("Native image canvas could not be painted");
    receiptRef.current = null;
    onReceipt?.(null);
  }, [onReceipt]);

  if (!current || !paint) {
    return (
      <div className="native-render-grid">
        <p>
          {error
            ? error
            : !volume || !path || disabled
              ? "No reformat to display."
              : "Computing native reformats…"}
        </p>
      </div>
    );
  }
  const { scene } = paint;
  return (
    <div className="native-render-grid">
      <RasterCanvas
        onFailure={paintFailed}
        label="Straightened planar reformat along path"
        caption={`Straightened CPR · ${scene.provenance.span_mm} mm span`}
        width={scene.straightened.width}
        height={scene.straightened.height}
        rgba={scene.straightened.rgba}
      />
      <RasterCanvas
        onFailure={paintFailed}
        label="Stretched planar reformat along path"
        caption={`Stretched CPR · ${scene.provenance.station_mm} mm station`}
        width={scene.stretched.width}
        height={scene.stretched.height}
        rgba={scene.stretched.rgba}
      />
      {scene.endoluminal ? (
        <RasterCanvas
          onFailure={paintFailed}
          label="Endoluminal first-person intensity boundary flythrough"
          caption={`Endoluminal flythrough · first-person intensity boundary raycast · ${scene.provenance.ray_hits} ray hits`}
          width={scene.endoluminal.width}
          height={scene.endoluminal.height}
          rgba={scene.endoluminal.rgba}
        />
      ) : (
        <p>
          Endoluminal flythrough unavailable:{" "}
          {scene.endoluminal_error || "no boundary within threshold"}
        </p>
      )}
      {scene.fusion && secondaryVolume ? (
        <RasterCanvas
          onFailure={paintFailed}
          label="Registered secondary cross-section"
          caption={`Registered cross-section · ${scene.fusion.secondary_missing} secondary-missing samples`}
          width={scene.fusion.width}
          height={scene.fusion.height}
          rgba={scene.fusion.rgba}
        />
      ) : null}
      {scene.straightened.outside > 0 ? (
        <p>{scene.straightened.outside} samples outside the source volume</p>
      ) : null}
    </div>
  );
}
