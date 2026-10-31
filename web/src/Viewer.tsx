import { useEffect, useRef } from "react";
import { Niivue, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
import { point3, volumeMetadata, type Point3 } from "./geometry";
export type VolumeInfo = ReturnType<typeof volumeMetadata>;
type Props = {
  file: File | null;
  mode: string;
  windowRange: [number, number];
  focus: Point3 | null;
  onLocation: (p: Point3) => void;
  onLoaded: (info: VolumeInfo) => void;
  onError: (message: string) => void;
};
export default function Viewer({
  file,
  mode,
  windowRange,
  focus,
  onLocation,
  onLoaded,
  onError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<Niivue | null>(null);
  const ready = useRef<Promise<Niivue | null> | null>(null);
  const callbacks = useRef({ onLocation, onLoaded, onError });
  callbacks.current = { onLocation, onLoaded, onError };
  const display = useRef(windowRange);
  display.current = windowRange;
  useEffect(() => {
    if (!canvas.current) return;
    const nv = new Niivue({
      backColor: [0.018, 0.028, 0.035, 1],
      crosshairColor: [0.35, 0.86, 0.75, 0.85],
      crosshairWidth: 1,
      isColorbar: false,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      isRadiologicalConvention: true,
    });
    viewer.current = nv;
    nv.onLocationChange = (location: unknown) => {
      const p = point3((location as { mm?: unknown })?.mm);
      if (p) callbacks.current.onLocation(p);
    };
    ready.current = nv
      .attachToCanvas(canvas.current)
      .then(() => {
        nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
        return nv;
      })
      .catch(() => {
        callbacks.current.onError(
          "WebGL 2 is unavailable. Open this workspace in a WebGL-capable browser.",
        );
        return null;
      });
    return () => {
      nv.onLocationChange = () => {};
      nv._gl?.getExtension("WEBGL_lose_context")?.loseContext();
      viewer.current = null;
    };
  }, []);
  useEffect(() => {
    if (!file) return;
    let active = true;
    (async () => {
      try {
        const nv = await ready.current;
        if (!nv || !active) return;
        for (const vol of [...nv.volumes]) nv.removeVolume(vol);
        await nv.loadFromFile(file);
        if (!active) return;
        const vol = nv.volumes[0];
        if (!vol?.hdr) throw new Error("No readable 3D NIfTI image");
        const info = volumeMetadata(vol.hdr);
        vol.cal_min = display.current[0];
        vol.cal_max = display.current[1];
        nv.updateGLVolume();
        callbacks.current.onLoaded(info);
        const center = point3(nv.frac2mm(nv.scene.crosshairPos, 0, true));
        if (center) callbacks.current.onLocation(center);
      } catch {
        if (active)
          callbacks.current.onError(
            "Could not open this NIfTI volume. Check its format and image geometry.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [file]);
  useEffect(() => {
    const nv = viewer.current;
    if (!nv) return;
    const types: Record<string, SLICE_TYPE> = {
      linked: SLICE_TYPE.MULTIPLANAR,
      axial: SLICE_TYPE.AXIAL,
      coronal: SLICE_TYPE.CORONAL,
      sagittal: SLICE_TYPE.SAGITTAL,
      volume: SLICE_TYPE.RENDER,
    };
    nv.setSliceType(types[mode] ?? SLICE_TYPE.MULTIPLANAR);
  }, [mode]);
  useEffect(() => {
    const nv = viewer.current;
    const vol = nv?.volumes[0];
    if (!nv || !vol) return;
    vol.cal_min = windowRange[0];
    vol.cal_max = windowRange[1];
    nv.updateGLVolume();
  }, [windowRange]);
  useEffect(() => {
    const nv = viewer.current;
    if (!focus || !nv?.volumes.length) return;
    nv.scene.crosshairPos = nv.mm2frac(focus, 0, true);
    nv.drawScene();
  }, [focus]);
  return <canvas ref={canvas} aria-label="Linked CTA slices and 3D volume" />;
}
