// @vitest-environment node
/** Development look at taking devices out of the vessel evidence, on
 * Ljubljana subjects 01 to 05. Not part of the test suite and not a protocol.
 *   LJUBLJANA_PREPARED=<dir> DEVICE_DEV=<dir> DEVICE_STAGE=<frames|runs> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/deviceRemovalDev.eval.ts
 * `frames` writes each subject's two 8-bit frames to DEVICE_DEV. A script
 * outside the browser (device_detector.transplant) then lays devices of
 * labelled fluoroscopy frames over them and marks devices in every picture.
 * `runs` registers the pictures with and without the marked pixels. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  EVIDENCE_NO_POSE,
  proposeEvidenceRegistration,
  type EvidencePlaneInput,
} from "../evidenceRegistration";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { vesselEvidence } from "../vesselEvidence2d";
import { applied, f32, u16 } from "./ljubljanaEvaluation";
import {
  meanTargetError,
  referenceGeometry,
  storedPoints,
  windowGray,
} from "./ljubljanaGeometry";
import {
  LJUBLJANA_PROTOCOL as P,
  perturbed,
  protocolStarts,
} from "./ljubljanaProtocol";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  DEV = process.env.DEVICE_DEV,
  STAGE = process.env.DEVICE_STAGE,
  SUBJECTS = (process.env.DEVICE_SUBJECTS ?? "1,2,3,4,5")
    .split(",")
    .map(Number),
  NAMES = ["frontal", "lateral"] as const;

it.skipIf(!PREPARED || !DEV || !STAGE)(
  "device removal, development",
  () => {
    const prepared = outsideRepository(PREPARED!),
      dev = outsideRepository(DEV!),
      starts = protocolStarts(),
      rows: unknown[] = [];
    for (const subject of SUBJECTS) {
      const tag = `subject${String(subject).padStart(2, "0")}`,
        dir = `${prepared}/${tag}`,
        stored = JSON.parse(readFileSync(`${dir}/subject.json`, "utf8"));
      const g = referenceGeometry(
        stored.volume_shape,
        stored.volume_affine,
        stored.views.frontal,
        stored.views.lateral,
      );
      const grays = g.planes.map((plane, k) =>
        windowGray(
          u16(`${dir}/${NAMES[k]}.u16`),
          stored.views[NAMES[k]],
          plane.window,
        ),
      );
      if (STAGE === "frames") {
        g.planes.forEach((plane, k) => {
          writeFileSync(`${dev}/${tag}-${NAMES[k]}.u8`, grays[k]);
          writeFileSync(
            `${dev}/${tag}-${NAMES[k]}.json`,
            JSON.stringify(plane.frame) + "\n",
          );
        });
        continue;
      }
      const { points } = medialPoints(
        new Uint8Array(readFileSync(`${dir}/mask.u8`)),
        stored.mask_shape,
        stored.mask_affine,
      );
      const fiducials = storedPoints(f32(`${dir}/fiducials.f32`), g.center);
      const pivot: Vec3 = [0, 0, 0];
      for (let k = 0; k < points.length; k += 3) {
        const x = applied(g.matrix, points, k);
        for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
      }
      // Picture names: "clean", then "d0", "d1", ... while the files exist.
      const pictures = ["clean"];
      for (let d = 0; existsSync(`${dev}/${tag}-frontal-d${d}.u8`); d++)
        pictures.push(`d${d}`);
      for (const picture of pictures)
        for (const removed of [false, true]) {
          const planes = g.planes.map((plane, k): EvidencePlaneInput => {
            const base = `${dev}/${tag}-${NAMES[k]}`,
              gray =
                picture === "clean"
                  ? grays[k]
                  : new Uint8Array(readFileSync(`${base}-${picture}.u8`)),
              mask = removed
                ? new Uint8Array(readFileSync(`${base}-${picture}.mask.u8`))
                : undefined;
            return {
              view: plane.view,
              isocenter: plane.isocenter,
              frame: plane.frame,
              evidence: vesselEvidence(
                gray,
                plane.frame.width,
                plane.frame.height,
                P.polarity,
                mask,
              ),
              fit_detector_scale: false,
            };
          });
          starts[subject - 1].forEach((by, j) => {
            let mm: number | null = null;
            try {
              const found = proposeEvidenceRegistration({
                points,
                start: perturbed(g.matrix, pivot, by),
                planes,
              });
              mm = meanTargetError(fiducials, found.matrix, g.matrix);
            } catch (error) {
              if (
                !(error instanceof Error) ||
                error.message !== EVIDENCE_NO_POSE
              )
                throw error;
            }
            rows.push({ subject, start: j, picture, removed, mm });
          });
        }
      writeFileSync(`${dev}/runs.json`, JSON.stringify(rows) + "\n");
      console.log(`subject ${subject} done`);
    }
  },
  6 * 60 * 60 * 1000,
);
