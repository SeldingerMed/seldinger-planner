// @vitest-environment node
/** Known-pose virtual X-ray control for the guarded bone line-up
 * (../abdominalLineup.ts). The frames are virtual X-rays of the very scan
 * the line-up reads, rendered at a known pose by
 * scripts/research/lineup_control.py (controlset) in the form the frame
 * admission command keeps, so the pose that made each frame is known
 * exactly. Not part of the test suite:
 *   CONTROL_DIR=<dir> npx vitest run --config vitest.research.config.ts \
 *     src/research/virtualXrayControl.eval.ts
 *
 * CONTROL_DIR is one case folder, or a folder of them. A case folder holds
 * volume.i16 (the scan, first index fastest), volume.json ({shape,
 * affine}), frames/<pose>/ (frames.json and one gray frame per plane) and
 * truth-<pose>.json ({isocenter, volume_to_carm_ras}), and may hold
 * vessels.json ({groups: name to RAS points}), the scan's own named vessel
 * points, which are then scored as well. Each pose is lined
 * up from the scan as it lies, on its first frame alone and then on both.
 * Every path lies outside this repository. Nothing is written: one line per
 * line-up goes to standard output. CONTROL_VARIANT may hold engine settings
 * (BONE_LINEUP) for a design experiment; it is printed first. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { it } from "vitest";
import { proposeAbdominalLineup } from "../abdominalLineup";
import { BONE_LINEUP, boneSamples, type BoneFrameInput } from "../boneLineup";
import { camera } from "../carmGeometry";
import { inPlaneErrorMm, poseDistanceMm, vesselScores } from "./controlScore";
import { outsideRepository } from "./outsideRepository";

const DIR = process.env.CONTROL_DIR;
const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

type Plane = {
  plane: string;
  columns: number;
  rows: number;
  geometry: BoneFrameInput["view"];
};

function controlCase(dir: string, name: string) {
  const meta = JSON.parse(readFileSync(`${dir}/volume.json`, "utf8"));
  const file = readFileSync(`${dir}/volume.i16`);
  const data = new Int16Array(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength),
  );
  const samples = boneSamples({ data, shape: meta.shape, affine: meta.affine });
  // Named vessel points from the scan's own segmentation, when the case has
  // them (heldout_control.py). Scored only; the line-up reads bone.
  const vessels = existsSync(`${dir}/vessels.json`)
    ? JSON.parse(readFileSync(`${dir}/vessels.json`, "utf8")).groups
    : null;
  for (const pose of readdirSync(`${dir}/frames`).sort()) {
    const truth = JSON.parse(readFileSync(`${dir}/truth-${pose}.json`, "utf8"));
    const manifest = JSON.parse(
      readFileSync(`${dir}/frames/${pose}/frames.json`, "utf8"),
    );
    const frames: BoneFrameInput[] = manifest.planes.map((plane: Plane) => ({
      view: plane.geometry,
      isocenter: truth.isocenter,
      pixels: readFileSync(`${dir}/frames/${pose}/${plane.plane}-000000.gray`),
      width: plane.columns,
      height: plane.rows,
    }));
    const first = frames[0].view;
    const cam = camera(first, truth.isocenter);
    const magnification = first.source_detector_mm / first.source_isocenter_mm;
    const score = (m: number[][]) => ({
      in_plane_mm: inPlaneErrorMm(
        cam,
        magnification,
        samples.points,
        m,
        truth.volume_to_carm_ras,
      ),
      three_d_mm: poseDistanceMm(samples.points, m, truth.volume_to_carm_ras),
      ...(vessels && {
        vessels: vesselScores(
          cam,
          magnification,
          vessels,
          m,
          truth.volume_to_carm_ras,
        ),
      }),
    });
    for (const used of [frames.slice(0, 1), frames]) {
      const t0 = performance.now();
      let line: Record<string, unknown> = {
        case: name,
        pose,
        frames: used.length,
        start: score(IDENTITY),
      };
      try {
        const found = proposeAbdominalLineup({
          samples,
          frames: used,
          start: IDENTITY,
        });
        line = {
          ...line,
          depth: found.depth,
          second_view: found.second_view,
          start_score: found.start_score,
          score: found.frame_scores,
          found: score(found.matrix),
        };
      } catch (error) {
        line.failed = String((error as Error).message);
      }
      line.seconds = (performance.now() - t0) / 1000;
      console.log(JSON.stringify(line));
      if (frames.length < 2) break;
    }
  }
}

it.skipIf(!DIR)(
  "guarded line-up on known-pose virtual X-rays",
  () => {
    const dir = outsideRepository(DIR as string);
    const variant = JSON.parse(process.env.CONTROL_VARIANT || "{}");
    for (const key of Object.keys(variant))
      if (!(key in BONE_LINEUP))
        throw new Error(`Unknown engine setting: ${key}`);
    Object.assign(BONE_LINEUP as Record<string, unknown>, variant);
    console.log(JSON.stringify({ variant }));
    if (existsSync(`${dir}/volume.json`)) controlCase(dir, ".");
    else
      for (const name of readdirSync(dir).sort())
        if (existsSync(`${dir}/${name}/volume.json`))
          controlCase(`${dir}/${name}`, name);
  },
  3_600_000,
);
