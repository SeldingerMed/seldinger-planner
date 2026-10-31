import { useEffect, useRef, useState } from "react";
import { Niivue, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
import { point3, volumeMetadata, type Point3 } from "./geometry";
import { loadReferenceMeshes, type CaseReference } from "./reference";
import {
  loadSegmentationMask,
  type SegmentationEntry,
  type SegmentationBinding,
} from "./segmentation";
export type VolumeInfo = ReturnType<typeof volumeMetadata>;
type Props = {
  file: File | null;
  mode: string;
  windowRange: [number, number];
  focus: Point3 | null;
  onLocation: (p: Point3) => void;
  onLoaded: (info: VolumeInfo) => void;
  onError: (message: string) => void;
  reference?: CaseReference | null;
  onReferenceStatus?: (status: "off" | "loading" | "ready" | "error") => void;
  onReferenceError?: (message: string) => void;
  segmentation?: SegmentationEntry | null;
  segmentationBinding?: SegmentationBinding | null;
  onSegmentationError?: (message: string) => void;
};
export default function Viewer({
  file,
  mode,
  windowRange,
  focus,
  onLocation,
  onLoaded,
  onError,
  reference = null,
  onReferenceStatus,
  onReferenceError,
  segmentation = null,
  segmentationBinding = null,
  onSegmentationError,
}: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<Niivue | null>(null);
  const ready = useRef<Promise<Niivue | null> | null>(null);
  const callbacks = useRef({
    onLocation,
    onLoaded,
    onError,
    onReferenceStatus,
    onReferenceError,
    onSegmentationError,
  });
  callbacks.current = {
    onLocation,
    onLoaded,
    onError,
    onReferenceStatus,
    onReferenceError,
    onSegmentationError,
  };
  const [loadedFile, setLoadedFile] = useState<File | null>(null);
  const desiredMode = useRef(mode);
  desiredMode.current = mode;
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
      // Reference surfaces are 3D models, not slice-wise annotation contours.
      meshThicknessOn2D: 0,
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
    setLoadedFile(null);
    let active = true;
    (async () => {
      try {
        const nv = await ready.current;
        if (!nv || !active) return;
        for (const mesh of [...nv.meshes]) nv.removeMesh(mesh);
        for (const vol of [...nv.volumes]) nv.removeVolume(vol);
        await nv.loadFromFile(file);
        if (!active) return;
        const vol = nv.volumes[0];
        if (!vol?.hdr) throw new Error("No readable 3D NIfTI image");
        const info = volumeMetadata(vol.hdr);
        vol.cal_min = display.current[0];
        vol.cal_max = display.current[1];
        vol.opacity = desiredMode.current === "reference" ? 0 : 1;
        nv.updateGLVolume();
        setLoadedFile(file);
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
    let active = true;
    for (const mesh of [...nv.meshes]) nv.removeMesh(mesh);
    callbacks.current.onReferenceStatus?.("off");
    if (!reference || !file || loadedFile !== file) return;
    callbacks.current.onReferenceStatus?.("loading");
    (async () => {
      try {
        const buffers = await loadReferenceMeshes(reference);
        if (!active || viewer.current !== nv) return;
        const added = await nv.addMeshesFromUrl(
          buffers.map((a) => ({
            url: a.url,
            buffer: a.buffer,
            name:
              a.id === "aneurysm"
                ? "Curated aneurysm reference.stl"
                : "Curated artery + aneurysm reference.stl",
            rgba255:
              a.id === "aneurysm" ? [247, 141, 110, 255] : [93, 202, 184, 255],
            opacity: a.id === "aneurysm" ? 1 : 0.55,
          })),
        );
        if (!active || viewer.current !== nv) {
          for (const mesh of added) nv.removeMesh(mesh);
          return;
        }
        nv.drawScene();
        callbacks.current.onReferenceStatus?.("ready");
      } catch {
        if (active) {
          callbacks.current.onReferenceStatus?.("error");
          callbacks.current.onReferenceError?.(
            "Reference surfaces failed to load or verify. The CTA remains available.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [file, loadedFile, reference]);
  useEffect(() => {
    const nv = viewer.current;
    if (!nv) return;
    const types: Record<string, SLICE_TYPE> = {
      linked: SLICE_TYPE.MULTIPLANAR,
      axial: SLICE_TYPE.AXIAL,
      coronal: SLICE_TYPE.CORONAL,
      sagittal: SLICE_TYPE.SAGITTAL,
      volume: SLICE_TYPE.RENDER,
      reference: SLICE_TYPE.RENDER,
    };
    nv.setSliceType(types[mode] ?? SLICE_TYPE.MULTIPLANAR);
    nv.setScale(mode === "reference" ? 4 : 1);
    if (nv.volumes[0]) {
      nv.volumes[0].opacity = mode === "reference" ? 0 : 1;
      nv.updateGLVolume();
    }
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
    const actual = point3(nv.frac2mm(nv.scene.crosshairPos, 0, true));
    if (actual) callbacks.current.onLocation(actual);
  }, [focus]);
  useEffect(() => {
    const nv = viewer.current;
    if (
      !nv ||
      !file ||
      loadedFile !== file ||
      !segmentation ||
      !segmentationBinding
    )
      return;
    let active = true;
    let url: string | null = null;
    let added: (typeof nv.volumes)[number] | null = null;
    (async () => {
      try {
        const buffer = await loadSegmentationMask(
          segmentation,
          segmentationBinding,
        );
        if (!active || viewer.current !== nv) return;
        url = URL.createObjectURL(new Blob([buffer]));
        const volume = await nv.addVolumeFromUrl({
          url,
          name: `${segmentation.role}-candidate.nii.gz`,
          colormap: segmentation.role === "vessel" ? "green" : "red",
          cal_min: 0,
          cal_max: 1,
          opacity: 0.65,
        });
        if (!active || viewer.current !== nv) {
          if (nv.volumes.includes(volume)) nv.removeVolume(volume);
          return;
        }
        added = volume;
        nv.updateGLVolume();
      } catch {
        if (active)
          callbacks.current.onSegmentationError?.(
            "Model mask failed to load or verify. The CTA remains available.",
          );
      } finally {
        if (url) {
          URL.revokeObjectURL(url);
          url = null;
        }
      }
    })();
    return () => {
      active = false;
      if (added && nv.volumes.includes(added)) nv.removeVolume(added);
      if (url) URL.revokeObjectURL(url);
    };
  }, [
    file,
    loadedFile,
    segmentation?.candidate_id,
    segmentation?.mask_sha256,
    segmentationBinding?.case_id,
    segmentationBinding?.image_sha256,
    segmentationBinding?.reference_revision,
  ]);
  return <canvas ref={canvas} aria-label="Linked CTA slices and 3D volume" />;
}
