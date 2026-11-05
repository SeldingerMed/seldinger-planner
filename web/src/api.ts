import type { Point3 } from "./geometry";
import type { AneurysmPlan } from "./planning";
export type Measurement = {
  measurement_id: string;
  label: string;
  point_a_mm: Point3;
  point_b_mm: Point3;
  distance_mm: number;
  coordinate_system: "RAS";
};
export type CaseState = {
  case_id: string;
  title: string;
  image_sha256: string;
  source_url: string | null;
  dimensions: number[];
  spacing_mm: number[];
  spatial_units: "mm" | "unknown";
  artifact_version: string;
  notes: string;
  measurements: Measurement[];
  aneurysm_plan?: AneurysmPlan | null;
};
export class RevisionConflictError extends Error {
  constructor() {
    super("Case changed. Reload saved state to review it before saving again.");
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
): Promise<T> {
  const response = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (response.status === 409) throw new RevisionConflictError();
    throw new Error(`Workspace request failed (${response.status}).`);
  }
  return response.json();
}
export async function restoreOrCreateCase(
  metadata: Pick<
    CaseState,
    "title" | "image_sha256" | "source_url" | "dimensions" | "spacing_mm"
  > &
    Partial<Pick<CaseState, "spatial_units">>,
): Promise<CaseState> {
  const key = "seldinger-case:" + metadata.image_sha256;
  const linked = new URLSearchParams(window.location.search).get("case");
  if (linked !== null && !/^[A-Za-z0-9_-]{22}$/.test(linked))
    throw new Error(
      "Linked case identifier is invalid. No replacement was created.",
    );
  const saved = linked ?? localStorage.getItem(key);
  if (saved) {
    const response = await fetch("/api/cases/" + encodeURIComponent(saved), {
      cache: "no-store",
    });
    if (response.ok) {
      const state = (await response.json()) as CaseState;
      if (
        state?.image_sha256 === metadata.image_sha256 &&
        state.case_id === saved
      ) {
        if (linked) localStorage.setItem(key, state.case_id);
        return state;
      }
    } else if (response.status !== 404)
      throw new Error(
        "Could not restore the saved workspace. No new case was created.",
      );
    if (linked !== null)
      throw new Error(
        "Linked case is missing or does not match the loaded image. No replacement was created.",
      );
  }
  const state = await api<CaseState>("/cases", metadata);
  localStorage.setItem(key, state.case_id);
  return state;
}
