import { useEffect, useRef, useState } from "react";
import {
  Niivue,
  SLICE_TYPE,
  SHOW_RENDER,
  MULTIPLANAR_TYPE,
} from "@niivue/niivue";
import type { Triple } from "./scenarios";
export type SceneMesh = {
  id: string;
  buffer: ArrayBuffer;
  color: [number, number, number, number];
  opacity: number;
};
type Props = {
  file: File | null;
  meshes: SceneMesh[];
  clip: number;
  ctaOpacity: number;
  zoom?: number;
  windowRange: [number, number];
  layout: "linked" | "volume";
  focus: Triple | null;
  onLocation: (point: Triple) => void;
  onError: (message: string) => void;
};
export default function DeviceScene(props: Props) {
  const canvas = useRef<HTMLCanvasElement>(null),
    queue = useRef<Promise<unknown>>(Promise.resolve()),
    callbacks = useRef(props);
  callbacks.current = props;
  const [engine, setEngine] = useState<Niivue | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    let active = true;
    const nv = new Niivue({
      backColor: [0.018, 0.026, 0.038, 1],
      isColorbar: false,
      multiplanarShowRender: SHOW_RENDER.ALWAYS,
      multiplanarLayout: MULTIPLANAR_TYPE.GRID,
      multiplanarEqualSize: true,
      isRadiologicalConvention: true,
      meshThicknessOn2D: 0.5,
      crosshairColor: [0.4, 0.9, 0.8, 1],
    });
    nv.onLocationChange = (v: unknown) => {
      const p = (v as { mm?: unknown }).mm;
      if (
        Array.isArray(p) &&
        p.length >= 3 &&
        p.slice(0, 3).every(Number.isFinite)
      )
        callbacks.current.onLocation(p.slice(0, 3) as Triple);
    };
    (async () => {
      try {
        await nv.attachToCanvas(canvas.current!);
        if (props.file) await nv.loadFromFile(props.file);
        if (!active) return;
        nv.setRenderAzimuthElevation(135, 20);
        nv.setScale(props.file ? 1 : 0.65);
        setEngine(nv);
      } catch {
        if (active)
          callbacks.current.onError(
            "Planning WebGL scene could not load the source volume.",
          );
      }
    })();
    return () => {
      active = false;
      nv.onLocationChange = () => {};
      nv._gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [props.file]);
  useEffect(() => {
    if (!engine) return;
    const nv = engine;
    let active = true;
    const owned: (typeof nv.meshes)[number][] = [];
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        try {
          for (const item of props.meshes) {
            if (!active) break;
            const added = await nv.addMeshesFromUrl([
              {
                url: `${item.id}.stl`,
                buffer: item.buffer,
                name: `${item.id}.stl`,
                rgba255: item.color,
                opacity: item.opacity,
              },
            ]);
            if (!active) {
              for (const mesh of added) nv.removeMesh(mesh);
              return;
            }
            owned.push(...added);
          }
          if (active) nv.drawScene();
        } catch {
          if (active)
            callbacks.current.onError(
              "A planning surface failed to render. No successful overlay is implied.",
            );
        }
      });
    return () => {
      active = false;
      for (const mesh of owned)
        if (nv.meshes.includes(mesh)) nv.removeMesh(mesh);
      nv.drawScene();
    };
  }, [engine, props.meshes]);
  useEffect(() => {
    if (!engine) return;
    engine.setSliceType(
      props.layout === "linked" ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.RENDER,
    );
    engine.setClipPlane([props.clip, 270, 0]);
    const volume = engine.volumes[0];
    if (volume) {
      volume.opacity = props.layout === "linked" ? 1 : props.ctaOpacity;
      volume.cal_min = props.windowRange[0];
      volume.cal_max = props.windowRange[1];
      engine.updateGLVolume();
    }
    engine.drawScene();
  }, [engine, props.clip, props.ctaOpacity, props.windowRange, props.layout]);
  useEffect(() => {
    if (!engine || !props.focus || !engine.volumes.length) return;
    engine.scene.crosshairPos = engine.mm2frac(props.focus, 0, true);
    engine.drawScene();
  }, [engine, props.focus]);
  useEffect(() => {
    if (engine && props.zoom) engine.setScale(props.zoom);
  }, [engine, props.zoom]);
  return (
    <canvas
      ref={canvas}
      aria-label="Interactive device planning scene"
      className="device-scene-canvas"
    />
  );
}
