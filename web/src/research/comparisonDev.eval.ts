// @vitest-environment node
/** Development look at the diameter comparison on real frames: the Ljubljana
 * subjects 01 to 05 at their reference pose. Not part of the test suite and
 * not a protocol; subjects 06 to 10 are refused.
 *   LJUBLJANA_PREPARED=<dir> COMPARISON_RESULTS=<dir> \
 *     npx vitest run --config vitest.research.config.ts \
 *     src/research/comparisonDev.eval.ts
 * The results directory must not exist. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { axisCuts } from "../axisDiameter";
import { compareDiameters } from "../diameterComparison";
import { frameDiameters } from "../frameDiameter";
import { placedSamples } from "../framePlacement";
import { vesselSegments } from "../vesselSegments";
import { u16 } from "./ljubljanaEvaluation";
import { referenceGeometry, windowGray } from "./ljubljanaGeometry";
import { LJUBLJANA_PROTOCOL as P } from "./ljubljanaProtocol";
import { outsideRepository } from "./outsideRepository";

const PREPARED = process.env.LJUBLJANA_PREPARED,
  RESULTS = process.env.COMPARISON_RESULTS,
  SUBJECTS = [1, 2, 3, 4, 5];

type Row = {
  subject: number;
  plane: string;
  segment: number;
  length_mm: number;
  mask_mm: number | null;
  frame_mm: number | null;
  frame_samples: number;
};

it.skipIf(!PREPARED || !RESULTS)(
  "diameters from the mask and from the frames, subjects 01 to 05",
  () => {
    const prepared = outsideRepository(PREPARED!, "LJUBLJANA_PREPARED"),
      results = outsideRepository(RESULTS!, "COMPARISON_RESULTS");
    mkdirSync(results);
    const rows: Row[] = [],
      seconds: number[] = [];
    for (const subject of SUBJECTS) {
      const dir = `${prepared}/subject${String(subject).padStart(2, "0")}`,
        stored = JSON.parse(readFileSync(`${dir}/subject.json`, "utf8")),
        mask = new Uint8Array(readFileSync(`${dir}/mask.u8`)),
        began = performance.now(),
        segments = vesselSegments(mask, stored.mask_shape, stored.mask_affine),
        cuts = axisCuts(mask, stored.mask_shape, stored.mask_affine, segments),
        g = referenceGeometry(
          stored.volume_shape,
          stored.volume_affine,
          stored.views.frontal,
          stored.views.lateral,
        );
      g.planes.forEach((plane, k) => {
        const name = k ? "lateral" : "frontal",
          gray = windowGray(
            u16(`${dir}/${name}.u16`),
            stored.views[name],
            plane.window,
          ),
          placed = placedSamples(
            plane.view,
            plane.isocenter,
            g.matrix,
            segments.points,
            plane.frame,
          ),
          frame_mm = frameDiameters(
            { ...plane.frame, gray, polarity: P.polarity },
            placed,
            segments,
            {
              ...cuts,
              pixels: placedSamples(
                plane.view,
                plane.isocenter,
                g.matrix,
                cuts.centers,
                plane.frame,
              ).pixels,
            },
          ),
          found = compareDiameters(segments, cuts.mm, frame_mm);
        segments.segments.forEach((segment) =>
          rows.push({
            subject,
            plane: name,
            segment: segment.index,
            length_mm: segment.length_mm,
            ...found.segments[segment.index],
          }),
        );
      });
      seconds.push((performance.now() - began) / 1000);
      console.log(`subject ${subject} done`);
    }
    writeFileSync(`${results}/detail.json`, JSON.stringify(rows) + "\n");
    const both = rows.filter(
        (row) => row.mask_mm !== null && row.frame_mm !== null,
      ),
      diff = both.map((row) => row.frame_mm! - row.mask_mm!),
      sorted = (values: number[]) => [...values].sort((a, b) => a - b),
      mid = (values: number[]) => sorted(values)[values.length >> 1] ?? null;
    writeFileSync(
      `${results}/summary.json`,
      JSON.stringify(
        {
          set: "development",
          subjects: SUBJECTS,
          segment_rows: rows.length,
          measured_in_frame: both.length,
          median_difference_mm: mid(diff),
          median_absolute_difference_mm: mid(diff.map(Math.abs)),
          within_half_mm: diff.filter((d) => Math.abs(d) <= 0.5).length,
          within_one_mm: diff.filter((d) => Math.abs(d) <= 1).length,
          seconds,
        },
        null,
        1,
      ) + "\n",
    );
  },
  3_600_000,
);
