/**
 * Strict wire decoder for the accepted-mask anatomy geometry proposal
 * envelope produced by planner.anatomy_server. The decoder accepts only the
 * exact producer wire shape (strict key sets, bounded identities, coherent
 * diagnostics) and never aliases the caller's parsed JSON: every retained
 * array is rebuilt. Hash tokens are opaque lowercase SHA-256 strings; the
 * decoder never recomputes Python JSON hashes (JS number serialization is not
 * byte-compatible with the Python canonical encoding).
 */

export type Vec3 = [number, number, number];

export type AnatomyInputs = {
  neck_origin: Vec3;
  neck_normal: Vec3;
  aneurysm_seed: Vec3;
  parent_path: Vec3[];
  proximal_index: number;
  distal_index: number;
};

export type AnatomyMaskDescriptor = {
  candidate_id: string;
  mask_sha256: string;
  segmentation_revision: number;
};

export type AnatomyProposalDependencies = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  source_revision: string;
  masks: { vessel: AnatomyMaskDescriptor; aneurysm: AnatomyMaskDescriptor };
  calculation_version: string;
};

export type AnatomyProposalDiagnostics = {
  aneurysm_component_voxels: number;
  interface_voxel_count: number;
  neck_plane_rms_residual_mm: number;
  parent_point_count: number;
  parent_length_mm: number;
  target_component_selected: boolean;
  grid_shape: [number, number, number];
};

export type AnatomyProposalEnvelope = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
  proposal_id: string;
  proposal: {
    inputs: AnatomyInputs;
    diagnostics: AnatomyProposalDiagnostics;
    dependencies: AnatomyProposalDependencies;
    job_sha256: string;
    method: "accepted_mask_anatomy_geometry_proposal";
    operator_confirmation_required: true;
    proposal_version: "anatomy-input-proposal-v1";
  };
};

export type AnatomyProposalBinding = {
  case_id: string;
  image_sha256: string;
  artifact_version: string;
  reference_revision: string;
};

const HEX64 = /^[0-9a-f]{64}$/;
const POSITIVE_NUMERIC = /^[1-9][0-9]{0,19}$/;

function fail(why: string): never {
  throw new Error(`Anatomy proposal rejected: ${why}`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactKeys(v: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObj(v)) fail(`${label} is not a JSON object`);
  const got = Object.keys(v as Record<string, unknown>).sort().join(",");
  const want = [...keys].sort().join(",");
  if (got !== want) fail(`${label} keys are ${got}, expected exactly ${want}`);
  return v as Record<string, unknown>;
}

function opaqueId(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length < 1 || v.length > 100) {
    fail(`${label} is not a bounded opaque identifier`);
  }
  return v;
}

function hash64(v: unknown, label: string): string {
  if (typeof v !== "string" || !HEX64.test(v)) {
    fail(`${label} is not a lowercase SHA-256 identity`);
  }
  return v;
}

function positiveNumeric(v: unknown, label: string): string {
  if (typeof v !== "string" || !POSITIVE_NUMERIC.test(v)) {
    fail(`${label} is not a positive numeric case version`);
  }
  return v;
}

function finiteNumber(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(`${label} is not a finite number`);
  }
  return v;
}

function positiveInt(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    fail(`${label} is not a positive integer`);
  }
  return v;
}

function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") fail(`${label} is not a boolean`);
  return v;
}

function isTriple(v: unknown): v is Vec3 {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    Array.from(v).every((x) => typeof x === "number" && Number.isFinite(x))
  );
}

function triple(v: unknown, label: string): Vec3 {
  if (!isTriple(v)) fail(`${label} is not three finite coordinates`);
  return [v[0], v[1], v[2]];
}

function parseMask(v: unknown, role: string): AnatomyMaskDescriptor {
  const m = exactKeys(v, ["candidate_id", "mask_sha256", "segmentation_revision"], `${role} mask descriptor`);
  const segmentation_revision = positiveInt(m.segmentation_revision, `${role} segmentation_revision`);
  return {
    candidate_id: opaqueId(m.candidate_id, `${role} candidate_id`),
    mask_sha256: hash64(m.mask_sha256, `${role} mask_sha256`),
    segmentation_revision,
  };
}

function parseDiagnostics(v: unknown, parentPathLength: number): AnatomyProposalDiagnostics {
  const d = exactKeys(
    v,
    [
      "aneurysm_component_voxels",
      "interface_voxel_count",
      "neck_plane_rms_residual_mm",
      "parent_point_count",
      "parent_length_mm",
      "target_component_selected",
      "grid_shape",
    ],
    "diagnostics",
  );
  const component = positiveInt(d.aneurysm_component_voxels, "aneurysm_component_voxels");
  if (component > 8_000_000) fail("aneurysm_component_voxels exceeds its bound");
  const interfaceCount = positiveInt(d.interface_voxel_count, "interface_voxel_count");
  if (interfaceCount < 3) fail("interface_voxel_count must be at least 3");
  if (interfaceCount > 100_000) fail("interface_voxel_count exceeds its bound");
  if (interfaceCount > component) fail("interface_voxel_count exceeds the component voxel count");
  const rms = finiteNumber(d.neck_plane_rms_residual_mm, "neck_plane_rms_residual_mm");
  if (rms < 0) fail("neck_plane_rms_residual_mm is negative");
  const parentPointCount = positiveInt(d.parent_point_count, "parent_point_count");
  if (parentPointCount !== parentPathLength) {
    fail("parent_point_count does not match the parent path");
  }
  const length = finiteNumber(d.parent_length_mm, "parent_length_mm");
  if (!(length > 0)) fail("parent_length_mm must be positive");
  const grid = d.grid_shape;
  if (
    !Array.isArray(grid) ||
    grid.length !== 3 ||
    !Array.from(grid).every((g) => typeof g === "number" && Number.isSafeInteger(g) && g >= 1 && g <= 2048)
  ) {
    fail("grid_shape is not three bounded positive integers");
  }
  if (grid[0] * grid[1] * grid[2] > 8_000_000) fail("grid_shape exceeds its volume bound");
  return {
    aneurysm_component_voxels: component,
    interface_voxel_count: interfaceCount,
    neck_plane_rms_residual_mm: rms,
    parent_point_count: parentPointCount,
    parent_length_mm: length,
    target_component_selected: bool(d.target_component_selected, "target_component_selected"),
    grid_shape: [grid[0], grid[1], grid[2]],
  };
}

export function parseAnatomyInputs(v: unknown): AnatomyInputs {
  const i = exactKeys(
    v,
    ["neck_origin", "neck_normal", "aneurysm_seed", "parent_path", "proximal_index", "distal_index"],
    "inputs",
  );
  const neck_normal = triple(i.neck_normal, "neck_normal");
  const norm = Math.hypot(neck_normal[0], neck_normal[1], neck_normal[2]);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-6) {
    fail("neck_normal is not a finite unit vector");
  }
  const pathRaw = i.parent_path;
  if (
    !Array.isArray(pathRaw) ||
    pathRaw.length < 4 ||
    pathRaw.length > 32 ||
    !Array.from(pathRaw).every(isTriple)
  ) {
    fail("parent_path is not four to thirty-two finite points");
  }
  const parent_path = pathRaw.map((p) => [...(p as Vec3)] as Vec3);
  const last = parent_path.length - 1;
  const indices = [i.proximal_index, i.distal_index].map((x, k) => {
    const label = k === 0 ? "proximal_index" : "distal_index";
    if (typeof x !== "number" || !Number.isSafeInteger(x) || !(x > 0 && x < last)) {
      fail(`${label} is not an interior parent path index`);
    }
    return x;
  });
  if (indices[0] === indices[1]) fail("proximal_index and distal_index must be distinct");
  return {
    neck_origin: triple(i.neck_origin, "neck_origin"),
    neck_normal,
    aneurysm_seed: triple(i.aneurysm_seed, "aneurysm_seed"),
    parent_path,
    proximal_index: indices[0],
    distal_index: indices[1],
  };
}

export function parseAnatomyProposal(
  raw: unknown,
  binding: AnatomyProposalBinding,
): AnatomyProposalEnvelope {
  const outer = exactKeys(
    raw,
    ["case_id", "image_sha256", "artifact_version", "reference_revision", "proposal_id", "proposal"],
    "anatomy proposal envelope",
  );
  if (outer.case_id !== binding.case_id) fail("case identity does not match the bound case");
  if (outer.image_sha256 !== binding.image_sha256) fail("image identity does not match the bound case");
  if (outer.artifact_version !== binding.artifact_version) {
    fail("artifact version does not match the bound case");
  }
  if (outer.reference_revision !== binding.reference_revision) {
    fail("source revision does not match the bound case");
  }
  const case_id = opaqueId(outer.case_id, "case_id");
  const image_sha256 = hash64(outer.image_sha256, "image_sha256");
  const artifact_version = positiveNumeric(outer.artifact_version, "artifact_version");
  const reference_revision = hash64(outer.reference_revision, "reference_revision");
  const proposal_id = hash64(outer.proposal_id, "proposal_id");

  const proposal = exactKeys(
    outer.proposal,
    [
      "inputs",
      "diagnostics",
      "dependencies",
      "job_sha256",
      "method",
      "operator_confirmation_required",
      "proposal_version",
    ],
    "proposal",
  );
  if (proposal.method !== "accepted_mask_anatomy_geometry_proposal") {
    fail("proposal method is not the anatomy geometry proposal contract");
  }
  if (proposal.operator_confirmation_required !== true) {
    fail("proposal must require operator confirmation");
  }
  if (proposal.proposal_version !== "anatomy-input-proposal-v1") {
    fail("proposal version is not anatomy-input-proposal-v1");
  }
  const job_sha256 = hash64(proposal.job_sha256, "job_sha256");

  const inputs = parseAnatomyInputs(proposal.inputs);
  const diagnostics = parseDiagnostics(proposal.diagnostics, inputs.parent_path.length);

  const deps = exactKeys(
    proposal.dependencies,
    ["case_id", "image_sha256", "artifact_version", "source_revision", "masks", "calculation_version"],
    "dependencies",
  );
  if (deps.case_id !== case_id || deps.image_sha256 !== image_sha256) {
    fail("dependency identity does not match the proposal identity");
  }
  if (deps.artifact_version !== artifact_version) {
    fail("dependency artifact version does not match the proposal identity");
  }
  if (deps.source_revision !== reference_revision) {
    fail("dependency source revision does not match the bound source revision");
  }
  if (deps.calculation_version !== "anatomy-input-proposal-v1") {
    fail("dependency calculation version is not anatomy-input-proposal-v1");
  }
  const masks = exactKeys(deps.masks, ["vessel", "aneurysm"], "mask roles");
  const dependencies: AnatomyProposalDependencies = {
    case_id,
    image_sha256,
    artifact_version,
    source_revision: reference_revision,
    masks: {
      vessel: parseMask(masks.vessel, "vessel"),
      aneurysm: parseMask(masks.aneurysm, "aneurysm"),
    },
    calculation_version: "anatomy-input-proposal-v1",
  };

  return {
    case_id,
    image_sha256,
    artifact_version,
    reference_revision,
    proposal_id,
    proposal: { inputs, diagnostics, dependencies, job_sha256, method: "accepted_mask_anatomy_geometry_proposal", operator_confirmation_required: true, proposal_version: "anatomy-input-proposal-v1" },
  };
}
