// @vitest-environment node
/** Protocol `ljubljana-device-removal-v1`: registration by vessel evidence
 * with the pixels the device network marks left in and taken out, on the
 * Ljubljana frames as stored and with devices of labelled fluoroscopy
 * frames laid over them. Not part of the test suite:
 *   LJUBLJANA_PREPARED=<dir> DEVICE_FRAMES=<dir> DEVICE_STAGE=<frames|runs> \
 *     LJUBLJANA_SUBJECTS=<development|all> \
 *     [DEVICE_NETWORK=<file> DEVICE_RESULTS=<dir>] \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/ljubljanaDeviceRemoval.eval.ts
 * `frames` writes each subject's two 8-bit frames to DEVICE_FRAMES; a script
 * outside the browser (device_detector.transplant) then lays the devices
 * over them. `runs` marks every picture with the browser's code from the
 * stored network and registers it both ways. The results directory must not
 * exist. `all` is the protocol run, once. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import {
  deviceInput,
  deviceMask,
  parseDeviceNetwork,
  runDeviceNetwork,
} from "../deviceNetwork";
import {
  EVIDENCE_NO_POSE,
  proposeEvidenceRegistration,
  type EvidencePlaneInput,
} from "../evidenceRegistration";
import { medialPoints } from "../maskPoints";
import type { Vec3 } from "../obliqueSlice";
import { vesselEvidence, type VesselEvidence } from "../vesselEvidence2d";
import { applied, f32, inPlaneError, u16 } from "./ljubljanaEvaluation";
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

export const DEVICE_REMOVAL_PROTOCOL = {
  id: "ljubljana-device-removal-v1",
  development: [1, 2, 3, 4, 5],
  held_back: [6, 7, 8, 9, 10],
  arms: { biplane: [0, 1], frontal: [0], lateral: [1] },
  under_mm: 1,
  /** A run counts as nearer or farther when the two ways differ by more. */
  moved_mm: 0.5,
} as const;

const PREPARED = process.env.LJUBLJANA_PREPARED,
  FRAMES = process.env.DEVICE_FRAMES,
  STAGE = process.env.DEVICE_STAGE,
  SET = process.env.LJUBLJANA_SUBJECTS,
  NETWORK = process.env.DEVICE_NETWORK,
  RESULTS = process.env.DEVICE_RESULTS,
  NAMES = ["frontal", "lateral"] as const;

type Way = "left_in" | "taken_out";
type Row = {
  subject: number;
  start: number;
  picture: string;
  arm: string;
  /** Mean target error for two planes, in-plane error for one. Null where
   * the search found no pose. */
  left_in: number | null;
  taken_out: number | null;
};
type Marked = {
  subject: number;
  picture: string;
  plane: string;
  /** Share of the frame's pixels marked. */
  share: number;
  /** Pixels on which the mask written by the Python side differs, where
   * one was written. */
  differs_px: number | null;
  /** Set when the frame gave no vessel evidence with the pixels taken out. */
  refused: string | null;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function summary(rows: Row[], marked: Marked[]) {
  const out: Record<string, unknown> = {},
    { under_mm, moved_mm } = DEVICE_REMOVAL_PROTOCOL;
  for (const kind of ["clean", "device"])
    for (const arm of Object.keys(DEVICE_REMOVAL_PROTOCOL.arms)) {
      const chosen = rows.filter(
          (row) =>
            row.arm === arm && (row.picture === "clean") === (kind === "clean"),
        ),
        side = (way: Way) => {
          const found = chosen.flatMap((row) =>
            row[way] === null ? [] : [row[way]],
          );
          return {
            runs: chosen.length,
            no_proposal: chosen.length - found.length,
            under: found.filter((mm) => mm < under_mm).length,
            median_mm: found.length ? median(found) : null,
          };
        },
        both = chosen.filter(
          (row) => row.left_in !== null && row.taken_out !== null,
        ),
        moved = both.map((row) => row.taken_out! - row.left_in!);
      out[`${kind}/${arm}`] = {
        left_in: side("left_in"),
        taken_out: side("taken_out"),
        // Of the runs with a proposal both ways.
        both: both.length,
        taken_out_nearer: moved.filter((mm) => mm < -moved_mm).length,
        taken_out_farther: moved.filter((mm) => mm > moved_mm).length,
        worst_farther_mm: moved.length ? Math.max(0, ...moved) : null,
      };
    }
  for (const kind of ["clean", "device"]) {
    const chosen = marked.filter(
      (one) => (one.picture === "clean") === (kind === "clean"),
    );
    out[`${kind}/marked`] = {
      frames: chosen.length,
      mean_share: chosen.length
        ? chosen.reduce((sum, one) => sum + one.share, 0) / chosen.length
        : null,
      refused: chosen.filter((one) => one.refused).length,
      differs_from_python: chosen.filter((one) => one.differs_px).length,
    };
  }
  return out;
}

it.skipIf(!PREPARED || !FRAMES || !STAGE || !SET)(
  "runs the device removal protocol",
  () => {
    const prepared = outsideRepository(PREPARED!),
      frames = outsideRepository(FRAMES!),
      { development, held_back } = DEVICE_REMOVAL_PROTOCOL;
    if (SET !== "development" && SET !== "all")
      throw new Error("LJUBLJANA_SUBJECTS is development or all");
    if (STAGE !== "frames" && STAGE !== "runs")
      throw new Error("DEVICE_STAGE is frames or runs");
    const subjects =
      SET === "all" ? [...development, ...held_back] : [...development];
    const stored = (subject: number) => {
      const tag = `subject${String(subject).padStart(2, "0")}`,
        dir = `${prepared}/${tag}`,
        subjectFile = JSON.parse(readFileSync(`${dir}/subject.json`, "utf8")),
        g = referenceGeometry(
          subjectFile.volume_shape,
          subjectFile.volume_affine,
          subjectFile.views.frontal,
          subjectFile.views.lateral,
        ),
        grays = g.planes.map((plane, k) =>
          windowGray(
            u16(`${dir}/${NAMES[k]}.u16`),
            subjectFile.views[NAMES[k]],
            plane.window,
          ),
        );
      return { tag, dir, subjectFile, g, grays };
    };
    if (STAGE === "frames") {
      for (const subject of subjects) {
        const { tag, g, grays } = stored(subject);
        g.planes.forEach((plane, k) => {
          // Refuses a frame that exists: the pictures are made once.
          writeFileSync(`${frames}/${tag}-${NAMES[k]}.u8`, grays[k], {
            flag: "wx",
          });
          writeFileSync(
            `${frames}/${tag}-${NAMES[k]}.json`,
            JSON.stringify(plane.frame) + "\n",
            { flag: "wx" },
          );
        });
      }
      return;
    }
    if (!NETWORK || !RESULTS)
      throw new Error("The runs need DEVICE_NETWORK and DEVICE_RESULTS");
    const results = outsideRepository(RESULTS),
      file = new Uint8Array(readFileSync(outsideRepository(NETWORK))),
      network = parseDeviceNetwork(file);
    // Refuses a directory that exists: a protocol run is not repeated.
    mkdirSync(results);
    const starts = protocolStarts(),
      rows: Row[] = [],
      marked: Marked[] = [];
    for (const subject of subjects) {
      const { tag, dir, subjectFile, g, grays } = stored(subject);
      const { points } = medialPoints(
        new Uint8Array(readFileSync(`${dir}/mask.u8`)),
        subjectFile.mask_shape,
        subjectFile.mask_affine,
      );
      const fiducials = storedPoints(f32(`${dir}/fiducials.f32`), g.center);
      const pivot: Vec3 = [0, 0, 0];
      for (let k = 0; k < points.length; k += 3) {
        const x = applied(g.matrix, points, k);
        for (let i = 0; i < 3; i++) pivot[i] += x[i] / (points.length / 3);
      }
      // Picture names: "clean", then "d0", "d1", ... while the files exist.
      const pictures = ["clean"];
      for (let d = 0; existsSync(`${frames}/${tag}-frontal-d${d}.u8`); d++)
        pictures.push(`d${d}`);
      if (pictures.length === 1)
        throw new Error(`No device pictures for ${tag} in DEVICE_FRAMES`);
      for (const picture of pictures) {
        // Each plane's evidence both ways. Null where the frame gave none
        // with the pixels taken out.
        const evidence = g.planes.map((plane, k) => {
          const base = `${frames}/${tag}-${NAMES[k]}`,
            { width, height } = plane.frame,
            gray =
              picture === "clean"
                ? grays[k]
                : new Uint8Array(readFileSync(`${base}-${picture}.u8`)),
            mask = deviceMask(
              runDeviceNetwork(
                network,
                deviceInput(gray, width, height, P.polarity, network.grid),
              ),
              width,
              height,
            ),
            count = mask.reduce((sum, value) => sum + value, 0),
            other = `${base}-${picture}.mask.u8`,
            left_in = vesselEvidence(gray, width, height, P.polarity);
          let taken_out: VesselEvidence | null = left_in,
            refused: string | null = null;
          if (count)
            try {
              taken_out = vesselEvidence(gray, width, height, P.polarity, mask);
            } catch (error) {
              // Only a frame left with no vessel evidence is recorded.
              if (
                !(error instanceof Error) ||
                !error.message.startsWith("No line-like vessels")
              )
                throw error;
              taken_out = null;
              refused = error.message;
            }
          marked.push({
            subject,
            picture,
            plane: NAMES[k],
            share: count / mask.length,
            differs_px: existsSync(other)
              ? new Uint8Array(readFileSync(other)).reduce(
                  (sum, value, at) => sum + (value !== mask[at] ? 1 : 0),
                  0,
                )
              : null,
            refused,
          });
          return { left_in, taken_out };
        });
        starts[subject - 1].forEach((by, j) => {
          const start = perturbed(g.matrix, pivot, by);
          for (const [arm, which] of Object.entries(
            DEVICE_REMOVAL_PROTOCOL.arms,
          )) {
            const run = (way: Way): number | null => {
              if (which.some((k) => !evidence[k][way])) return null;
              const planes = which.map((k): EvidencePlaneInput => ({
                view: g.planes[k].view,
                isocenter: g.planes[k].isocenter,
                frame: g.planes[k].frame,
                evidence: evidence[k][way]!,
                fit_detector_scale: false,
              }));
              try {
                const found = proposeEvidenceRegistration({
                  points,
                  start,
                  planes,
                });
                return which.length === 2
                  ? meanTargetError(fiducials, found.matrix, g.matrix)
                  : inPlaneError(
                      fiducials,
                      g.planes[which[0]],
                      g.matrix,
                      found.matrix,
                      found.planes[0].view,
                    );
              } catch (error) {
                // Only the search's own failure is no proposal.
                if (
                  !(error instanceof Error) ||
                  error.message !== EVIDENCE_NO_POSE
                )
                  throw error;
                return null;
              }
            };
            const left_in = run("left_in"),
              // With no pixel marked in its planes the run is the same one.
              same = which.every(
                (k) => evidence[k].taken_out === evidence[k].left_in,
              );
            rows.push({
              subject,
              start: j,
              picture,
              arm,
              left_in,
              taken_out: same ? left_in : run("taken_out"),
            });
          }
        });
      }
      writeFileSync(
        `${results}/detail.json`,
        JSON.stringify({ rows, marked }) + "\n",
      );
      console.log(`subject ${subject} done`);
    }
    const of = (set: readonly number[]) =>
      summary(
        rows.filter((row) => set.includes(row.subject)),
        marked.filter((one) => set.includes(one.subject)),
      );
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          protocol: DEVICE_REMOVAL_PROTOCOL.id,
          set: SET,
          network_sha256: createHash("sha256").update(file).digest("hex"),
          development: of(development),
          ...(SET === "all" ? { held_back: of(held_back) } : {}),
        },
        null,
        1,
      ) + "\n",
    );
  },
  12 * 60 * 60 * 1000,
);
