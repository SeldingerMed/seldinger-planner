import type { Point3 } from "./geometry";

export const measurementRoles = [
  ["sac_height", "Sac height"],
  ["sac_width", "Sac width"],
  ["neck_width", "Neck width"],
  ["proximal_parent", "Proximal parent"],
  ["distal_parent", "Distal parent"],
] as const;
export const discussionOptions = [
  ["observation", "Observation"],
  ["coiling", "Coiling"],
  ["assisted_coiling", "Assisted coiling"],
  ["flow_diversion", "Flow diversion"],
  ["intrasaccular", "Intrasaccular"],
  ["clipping", "Clipping"],
] as const;
export type MeasurementRole = (typeof measurementRoles)[number][0];
export type DiscussionOption = (typeof discussionOptions)[number][0];
export type AneurysmPlan = {
  lesion_label: string;
  location_note: string;
  focus_ras: Point3 | null;
  rupture_status: "unknown" | "unruptured" | "ruptured";
  clinical_context: string;
  measurement_links: Partial<Record<MeasurementRole, string>>;
  options: DiscussionOption[];
  questions: string;
};
export const emptyPlan: AneurysmPlan = {
  lesion_label: "Target aneurysm",
  location_note: "",
  focus_ras: null,
  rupture_status: "unknown",
  clinical_context: "",
  measurement_links: {},
  options: [],
  questions: "",
};
