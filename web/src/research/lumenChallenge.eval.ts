// Offline worker. Receives one already-staged procedural frame, never the pack path.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { admit, transfer } from "./lumenChallenge";
import { decide } from "./lumenGate";
import { runProposal, lumenIsocenterDepth } from "./lumenProposal";
const ids = [
  "full-tree-v1",
  "selective-a-v1",
  "selective-b-v1",
  "overlap-a-v1",
  "overlap-b-v1",
];
it("records both real Planner searches before any reveal", () => {
  const id = process.env.LUMEN_CASE ?? "",
    root = process.env.LUMEN_RUN;
  if (!root || !ids.includes(id))
    throw new Error("Expected staged run and released case");
  const dir = join(root, id),
    json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const cam = admit(json(join(dir, "problem.json")), id),
    geometry = readFileSync(join(dir, "geometry.json"));
  const branches: number[][][] = JSON.parse(geometry.toString()).branches.map(
    (b: { points_mm: number[][] }) => b.points_mm,
  );
  const gray = new Uint8Array(readFileSync(join(dir, "gray.bin")));
  const labels = ["base", "depth+20"];
  const starts: (number[][] | null)[] = labels.map((_, i) => [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, lumenIsocenterDepth(cam.source_to_detector_mm) + 20 * i],
    [0, 0, 0, 1],
  ]);
  if (id === "overlap-b-v1") {
    const a = join(root, "overlap-a-v1");
    if (!geometry.equals(readFileSync(join(a, "geometry.json"))))
      throw new Error("Paired geometry mismatch");
    const cal = json(join(dir, "calibration.json")),
      prev = json(join(a, "result.json"));
    if (prev.case_id !== "overlap-a-v1")
      throw new Error("Missing recorded A proposals");
    labels.forEach((label, i) => {
      const row = prev.runs.find((r: { label: string }) => r.label === label);
      if (!row) throw new Error("Missing A depth trial");
      starts[i] = row.pose ? transfer(cal, row.pose.model_to_camera_mm) : null;
    });
  }
  const searched = starts.map((start) => {
    if (!start)
      return { pose: null, native: null, failure: "No A proposal to transfer" };
    try {
      return { ...runProposal(cam, branches, gray, start), failure: null };
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      return { pose: null, native: null, failure: e.message };
    }
  });
  const wrap = (m: number[][] | null) =>
    m && { schema: "lumen-rigid-pose/1", case_id: id, model_to_camera_mm: m };
  const runs = searched.map((r, i) => ({
    label: labels[i],
    start: wrap(starts[i]),
    ...r,
    pose: wrap(r.pose),
    gate: decide(cam, branches, gray, r.pose, searched[1 - i].pose),
  }));
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ case_id: id, runs }, null, 2) + "\n",
    { flag: "wx" },
  );
}, 120000);
