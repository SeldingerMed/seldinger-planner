import { validateRigid } from "../rigidFusion";
import { validateLumenCamera } from "./lumenProposal";
import type { LumenCamera } from "./lumenGate";
// Only fixed, pinned problem members are decoded by the staging process.
export function admit(
  p: {
    schema: string;
    case_id: string;
    provenance: string;
    image: string;
    geometry: string;
    camera: LumenCamera & { axes: string };
  },
  id: string,
) {
  if (
    p.schema !== "lumen-registration/1" ||
    p.case_id !== id ||
    p.provenance !== "procedural" ||
    p.image !== "image.png" ||
    p.geometry !== "geometry.json" ||
    p.camera.axes !==
      "+x right, +y down, +z forward (right-handed, source at origin, screen y down)" ||
    p.camera.width_px !== 512 ||
    p.camera.height_px !== 512
  )
    throw new Error("Mismatched Lumen problem contract");
  return validateLumenCamera(p.camera);
}
export function transfer(
  c: {
    schema: string;
    from_case: string;
    to_case: string;
    camera_a_to_camera_b_mm: number[][];
  },
  pose: number[][],
) {
  if (
    c.schema !== "lumen-camera-pair/1" ||
    c.from_case !== "overlap-a-v1" ||
    c.to_case !== "overlap-b-v1"
  )
    throw new Error("Mismatched calibration pair");
  const b = validateRigid(c.camera_a_to_camera_b_mm),
    a = validateRigid(pose);
  return validateRigid(
    b.map((row) =>
      a[0].map((_, j) => row.reduce((sum, k, i) => sum + k * a[i][j], 0)),
    ),
  );
}
