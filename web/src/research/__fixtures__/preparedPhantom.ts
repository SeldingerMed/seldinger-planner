import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderFrame,
  rigid,
  treeMask,
  TREE,
} from "../../__fixtures__/angioPhantom";
import { viewFrame, type ViewNumbers } from "../../carmGeometry";
import { medialPoints } from "../../maskPoints";
import type { Vec3 } from "../../obliqueSlice";

/** Writes one phantom subject in the prepared layout, with its cameras
 * stored the way the Ljubljana copy stores them, and returns nothing the
 * evaluation could use: the evaluation must find the reference pose from
 * the files alone. */
export function writeSubject(dir: string) {
  const { mask, shape, affine } = treeMask(1, TREE);
  const middle = shape.map((n) => (n - 1) / 2),
    center = [0, 1, 2].map(
      (i) =>
        affine[i][0] * middle[0] +
        affine[i][1] * middle[1] +
        affine[i][2] * middle[2] +
        affine[i][3],
    );
  // The patient lies turned in the C-arm frame, volume center at its origin.
  const turn = rigid([4, -5, 7], [0, 0, 0]),
    reference = turn.map((row, i) =>
      i < 3
        ? [
            ...row.slice(0, 3),
            -(row[0] * center[0] + row[1] * center[1] + row[2] * center[2]),
          ]
        : row,
    );
  const base = {
    source_detector_mm: 1200,
    source_isocenter_mm: 800,
    detector_width_mm: 180,
    detector_height_mm: 180,
  };
  const views: [string, ViewNumbers, number, number][] = [
    ["frontal", { ...base, primary_deg: 0, secondary_deg: 6 }, 24, 10],
    ["lateral", { ...base, primary_deg: 84, secondary_deg: -4 }, 0, 16],
  ];
  const stored: Record<string, unknown> = {};
  for (const [name, view, cutLeft, cutTop] of views) {
    const { u, v, d } = viewFrame(view.primary_deg, view.secondary_deg),
      // The central ray passes 3 mm right of and 2 mm above the C-arm origin.
      isocenter = [0, 1, 2].map((i) => 3 * u[i] + 2 * v[i]) as Vec3,
      size = 300,
      gray = renderFrame(view, isocenter, reference, {
        width: size,
        height: size,
        polarity: "dark",
        noise: 12,
        seed: name.length,
      });
    // Stored frame: the rendered one with columns cut from the left and rows
    // from the top, so the central ray is off its middle.
    const width = size - cutLeft,
      height = size - cutTop,
      pixels = new Uint16Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        pixels[y * width + x] = 257 * gray[(y + cutTop) * size + x + cutLeft];
    writeFileSync(join(dir, `${name}.u16`), new Uint8Array(pixels.buffer));
    // Camera axes and source in the centered world: C-arm vectors turned back.
    const back = (x: readonly number[]) =>
      [0, 1, 2].map(
        (j) => turn[0][j] * x[0] + turn[1][j] * x[1] + turn[2][j] * x[2],
      );
    const right = back(u),
      up = back(v),
      beam = back(d),
      source = back(isocenter.map((value, i) => value - 800 * d[i]));
    const pitch = view.detector_width_mm / size;
    stored[name] = {
      // The stored pose's columns are image right, minus the beam, image up.
      pose: [
        ...[0, 1, 2].map((i) => [right[i], -beam[i], up[i], source[i]]),
        [0, 0, 0, 1],
      ],
      intrinsics: {
        sdd: 1200,
        delx: pitch,
        dely: pitch,
        x0: (size / 2 - cutLeft - width / 2) * pitch,
        y0: (size / 2 - cutTop - height / 2) * pitch,
      },
      width,
      height,
    };
  }
  writeFileSync(join(dir, "mask.u8"), Uint8Array.from(mask));
  const { points } = medialPoints(mask, shape, affine);
  writeFileSync(
    join(dir, "fiducials.f32"),
    new Uint8Array(points.map((value, k) => value - center[k % 3]).buffer),
  );
  writeFileSync(
    join(dir, "subject.json"),
    JSON.stringify({
      volume_shape: shape,
      volume_affine: affine,
      mask_shape: shape,
      mask_affine: affine,
      views: stored,
    }),
  );
}
