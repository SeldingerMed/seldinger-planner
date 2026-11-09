import { describe, expect, it } from "vitest";

import {
  parseAnatomyProposal,
  type AnatomyProposalBinding,
  type AnatomyProposalEnvelope,
} from "./anatomyProposal";

/**
 * Literal fixture extracted from the actual producer receipt
 * artifacts/phase5/anatomy-default-path-verified.json (receipt.proposal).
 * Values are verbatim from the real default-API + fixed-worker run; no field
 * is invented. Hash tokens are treated as opaque identities, never recomputed.
 */
const FIXTURE = {
  case_id: "MJbqKO1iFLQJaUH-l0CFkQ",
  image_sha256:
    "59bb2b04f473a54990cba82020cb550f2b94ffa11f10a0839313b5c2837c2cfb",
  artifact_version: "3",
  reference_revision:
    "f6358cdca2a8f72c0c96262b054b5b26dfe80981f478e999f48358a648f0216b",
  proposal_id:
    "7d5cc40f3c8835ee4c55d871fe0edf3f09a7f2947ba8e48467759b924535d339",
  proposal: {
    dependencies: {
      artifact_version: "3",
      calculation_version: "anatomy-input-proposal-v1",
      case_id: "MJbqKO1iFLQJaUH-l0CFkQ",
      image_sha256:
        "59bb2b04f473a54990cba82020cb550f2b94ffa11f10a0839313b5c2837c2cfb",
      masks: {
        aneurysm: {
          candidate_id: "SnjTcp0Buq80EPsu7d6IwA",
          mask_sha256:
            "482997ba3185529b34bac882ec9695c05ebe27b606f6987b50205bb63a571ac6",
          segmentation_revision: 2,
        },
        vessel: {
          candidate_id: "s4vG9KeCpT1UslbvgINjDw",
          mask_sha256:
            "c3dc05be459d65e22a374d4459618efd3645cce46258f63d4c5ccec7647ad73f",
          segmentation_revision: 1,
        },
      },
      source_revision:
        "f6358cdca2a8f72c0c96262b054b5b26dfe80981f478e999f48358a648f0216b",
    },
    diagnostics: {
      aneurysm_component_voxels: 123,
      interface_voxel_count: 28,
      neck_plane_rms_residual_mm: 0.4670248868079294,
      parent_point_count: 9,
      parent_length_mm: 10.485281374238571,
      target_component_selected: false,
      grid_shape: [16, 16, 24],
    },
    inputs: {
      neck_origin: [8.0, 5.821428571428571, 12.0],
      neck_normal: [-0.0, -1.0, -0.0],
      aneurysm_seed: [8.0, 4.0, 12.0],
      parent_path: [
        [7.0, 7.0, 9.0],
        [8.0, 8.0, 9.0],
        [8.0, 8.0, 10.0],
        [8.0, 7.0, 11.0],
        [8.0, 6.0, 12.0],
        [8.0, 7.0, 13.0],
        [8.0, 8.0, 14.0],
        [8.0, 8.0, 15.0],
        [9.0, 7.0, 15.0],
      ],
      proximal_index: 3,
      distal_index: 5,
    },
    job_sha256:
      "c9e0d5159c5ffc124b20988f40521561dde6868b30cdbeaf6cb1a10017c56f54",
    method: "accepted_mask_anatomy_geometry_proposal",
    operator_confirmation_required: true,
    proposal_version: "anatomy-input-proposal-v1",
  },
} as const;

const BINDING: AnatomyProposalBinding = {
  case_id: FIXTURE.case_id,
  image_sha256: FIXTURE.image_sha256,
  artifact_version: FIXTURE.artifact_version,
  reference_revision: FIXTURE.reference_revision,
};

function baseline(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>;
}

function parse(mutate?: (b: Record<string, unknown>) => void): AnatomyProposalEnvelope {
  const payload = baseline();
  if (mutate) mutate(payload);
  return parseAnatomyProposal(payload, BINDING);
}

function expectReject(mutate: (b: Record<string, unknown>) => void, why: string) {
  expect(() => parse(mutate), why).toThrow(/^Anatomy proposal rejected: /);
}

describe("parseAnatomyProposal", () => {
  it("rejects sparse grid dimensions", () => {
    expectReject((raw) => {
      const proposal = raw.proposal as Record<string, unknown>;
      (proposal.diagnostics as Record<string, unknown>).grid_shape = new Array(3);
    }, "sparse grid is not three dimensions");
  });

  it("rejects a sparse parent path even when station/count fields agree", () => {
    expectReject((raw) => {
      const proposal = raw.proposal as Record<string, unknown>;
      const inputs = proposal.inputs as Record<string, unknown>;
      inputs.parent_path = new Array(4);
      inputs.proximal_index = 1;
      inputs.distal_index = 2;
      (proposal.diagnostics as Record<string, unknown>).parent_point_count = 4;
    }, "missing path points are not finite JSON");
  });

  it("rejects sparse coordinate arrays instead of retaining undefined coordinates", () => {
    expectReject((raw) => {
      const proposal = raw.proposal as Record<string, unknown>;
      const inputs = proposal.inputs as Record<string, unknown>;
      inputs.neck_origin = new Array(3);
    }, "sparse world coordinates are not finite JSON");
  });

  it("accepts the actual producer receipt verbatim", () => {
    const env = parse();
    expect(env.case_id).toBe(FIXTURE.case_id);
    expect(env.proposal_id).toBe(FIXTURE.proposal_id);
    expect(env.proposal.method).toBe("accepted_mask_anatomy_geometry_proposal");
    expect(env.proposal.operator_confirmation_required).toBe(true);
    expect(env.proposal.proposal_version).toBe("anatomy-input-proposal-v1");
    expect(env.proposal.inputs.parent_path).toHaveLength(9);
    expect(env.proposal.inputs.proximal_index).toBe(3);
    expect(env.proposal.inputs.distal_index).toBe(5);
    expect(env.proposal.diagnostics.parent_point_count).toBe(9);
    expect(env.proposal.diagnostics.grid_shape).toEqual([16, 16, 24]);
    expect(env.proposal.dependencies.masks.vessel.candidate_id).toBe(
      "s4vG9KeCpT1UslbvgINjDw",
    );
    expect(env.proposal.dependencies.masks.aneurysm.mask_sha256).toBe(
      "482997ba3185529b34bac882ec9695c05ebe27b606f6987b50205bb63a571ac6",
    );
  });

  it("deep-clones the parsed result so retained values never alias the caller raw input", () => {
    const raw = baseline();
    const env = parseAnatomyProposal(raw, BINDING);
    const record = raw as Record<string, unknown>;
    const rawInputs = (record.proposal as Record<string, unknown>)
      .inputs as Record<string, unknown>;
    const rawPath = rawInputs.parent_path as number[][];
    expect(env.proposal.inputs.parent_path[0]).not.toBe(rawPath[0]);
    rawPath[0][0] = 999;
    (rawInputs.parent_path as unknown[]).splice(0, 1);
    expect(env.proposal.inputs.parent_path).toHaveLength(9);
    expect(env.proposal.inputs.parent_path[0][0]).toBe(7);
  });

  it("rejects non-object and malformed outer payloads", () => {
    expect(() => parseAnatomyProposal(null, BINDING)).toThrow();
    expect(() => parseAnatomyProposal("proposal", BINDING)).toThrow();
    expect(() => parseAnatomyProposal([], BINDING)).toThrow();
  });

  it("rejects outer identity mismatch against the binding", () => {
    expectReject(
      (b) => {
        b.case_id = "other-case";
      },
      "outer case id mismatch",
    );
    expectReject(
      (b) => {
        b.image_sha256 = "0".repeat(64);
      },
      "outer image hash mismatch",
    );
    expectReject(
      (b) => {
        b.artifact_version = "4";
      },
      "outer artifact version mismatch",
    );
    expectReject(
      (b) => {
        b.reference_revision = "a".repeat(64);
      },
      "outer reference revision mismatch",
    );
  });

  it("rejects non-contract method, confirmation, and version markers", () => {
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).method = "invented_method";
      },
      "wrong method",
    );
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).operator_confirmation_required =
          false;
      },
      "confirmation false",
    );
    expectReject(
      (b) => {
        // 1 is not the strict boolean true.
        (b.proposal as Record<string, unknown>).operator_confirmation_required =
          1;
      },
      "confirmation as number one",
    );
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).proposal_version = "v2";
      },
      "wrong proposal version",
    );
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).job_sha256 = "XYZ";
      },
      "non-hex job hash",
    );
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).job_sha256 = "A".repeat(64);
      },
      "uppercase job hash",
    );
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).proposal_id = "f".repeat(63);
      },
      "short proposal id",
    );
  });

  it("rejects unexpected or missing keys at every level", () => {
    expectReject(
      (b) => {
        (b.proposal as Record<string, unknown>).extra = 1;
      },
      "extra proposal key",
    );
    expectReject(
      (b) => {
        delete (b.proposal as Record<string, unknown>).diagnostics;
      },
      "missing diagnostics",
    );
    expectReject(
      (b) => {
        delete (b.proposal as Record<string, unknown>).dependencies;
      },
      "missing dependencies",
    );
    expectReject(
      (b) => {
        delete ((b.proposal as Record<string, unknown>).inputs as Record<string, unknown>)
          .distal_index;
      },
      "missing input key",
    );
    expectReject(
      (b) => {
        ((b.proposal as Record<string, unknown>).inputs as Record<string, unknown>).surprise = 0;
      },
      "extra input key",
    );
    expectReject(
      (b) => {
        delete ((b.proposal as Record<string, unknown>).diagnostics as Record<string, unknown>)
          .grid_shape;
      },
      "missing diagnostics key",
    );
    expectReject(
      (b) => {
        delete ((b.proposal as Record<string, unknown>).dependencies as Record<string, unknown>)
          .masks;
      },
      "missing dependencies masks",
    );
    expectReject(
      (b) => {
        delete (((b.proposal as Record<string, unknown>).dependencies as Record<string, unknown>)
          .masks as Record<string, unknown>).vessel;
      },
      "missing vessel mask role",
    );
    expectReject(
      (b) => {
        const m = ((b.proposal as Record<string, unknown>).dependencies as Record<string, unknown>)
          .masks as Record<string, unknown>;
        (m.vessel as Record<string, unknown>).extra = "x";
      },
      "extra mask descriptor key",
    );
  });

  it("rejects dependency identity mismatches", () => {
    const deps = (b: Record<string, unknown>) =>
      (b.proposal as Record<string, unknown>).dependencies as Record<string, unknown>;
    expectReject((b) => void (deps(b).case_id = "elsewhere"), "dep case mismatch");
    expectReject((b) => void (deps(b).image_sha256 = "1".repeat(64)), "dep image mismatch");
    expectReject((b) => void (deps(b).artifact_version = "9"), "dep artifact mismatch");
    expectReject(
      (b) => void (deps(b).source_revision = "2".repeat(64)),
      "dep source revision mismatch",
    );
    expectReject(
      (b) => void (deps(b).calculation_version = "other-calc-v9"),
      "dep calculation version mismatch",
    );
  });

  it("rejects invalid mask descriptors", () => {
    const vessel = (b: Record<string, unknown>) =>
      (
        ((b.proposal as Record<string, unknown>).dependencies as Record<string, unknown>)
          .masks as Record<string, unknown>
      ).vessel as Record<string, unknown>;
    expectReject((b) => void (vessel(b).mask_sha256 = "nothex"), "bad mask hash");
    expectReject((b) => void (vessel(b).candidate_id = ""), "empty candidate id");
    expectReject(
      (b) => void (vessel(b).candidate_id = "x".repeat(101)),
      "overlong candidate id",
    );
    expectReject((b) => void (vessel(b).segmentation_revision = 0), "zero segmentation revision");
    expectReject(
      (b) => void (vessel(b).segmentation_revision = 1.5),
      "fractional segmentation revision",
    );
  });

  it("rejects incoherent operator inputs", () => {
    const inputs = (b: Record<string, unknown>) =>
      (b.proposal as Record<string, unknown>).inputs as Record<string, unknown>;
    expectReject(
      (b) => void ((inputs(b).neck_normal as number[])[1] = -1.5),
      "non-unit normal",
    );
    expectReject(
      (b) => void ((inputs(b).neck_origin as number[])[0] = Number("1e999")),
      "non-finite neck origin",
    );
    expectReject(
      (b) => {
        (inputs(b).parent_path as unknown[]).splice(0, 1);
      },
      "too few parent points",
    );
    expectReject(
      (b) => {
        const p = inputs(b).parent_path as number[][];
        for (let i = 0; i < 25; i++) p.push([9, 9, 16]);
      },
      "too many parent points",
    );
    expectReject(
      (b) => {
        const p = inputs(b).parent_path as unknown[];
        p[0] = [1, 2];
      },
      "malformed parent point",
    );
    expectReject(
      (b) => void (inputs(b).proximal_index = 0),
      "boundary proximal index",
    );
    expectReject(
      (b) => void (inputs(b).distal_index = 8),
      "boundary distal index",
    );
    expectReject((b) => void (inputs(b).proximal_index = 5), "duplicate station");
  });

  it("rejects incoherent diagnostics", () => {
    const diag = (b: Record<string, unknown>) =>
      (b.proposal as Record<string, unknown>).diagnostics as Record<string, unknown>;
    expectReject(
      (b) => void (diag(b).parent_point_count = 8),
      "point count mismatch",
    );
    expectReject(
      (b) => void (diag(b).neck_plane_rms_residual_mm = Number("-1e999")),
      "non-finite rms",
    );
    expectReject(
      (b) => void (diag(b).neck_plane_rms_residual_mm = -0.1),
      "negative rms",
    );
    expectReject((b) => void (diag(b).parent_length_mm = 0), "zero parent length");
    expectReject((b) => void (diag(b).parent_length_mm = Number("1e999")), "non-finite length");
    expectReject(
      (b) => void (diag(b).interface_voxel_count = 2),
      "interface below three",
    );
    expectReject(
      (b) => void (diag(b).interface_voxel_count = 124),
      "interface exceeds component",
    );
    expectReject(
      (b) => void (diag(b).aneurysm_component_voxels = 0),
      "zero component",
    );
    expectReject(
      (b) => void (diag(b).aneurysm_component_voxels = 8_000_001),
      "component over bound",
    );
    expectReject((b) => void (diag(b).target_component_selected = 1), "numeric target flag");
    expectReject((b) => void (diag(b).target_component_selected = "false"), "string target flag");
    expectReject(
      (b) => void (diag(b).grid_shape = [16, 16, 2049]),
      "grid axis over bound",
    );
    expectReject(
      (b) => void (diag(b).grid_shape = [2048, 2048, 3]),
      "grid volume over bound",
    );
    expectReject((b) => void (diag(b).grid_shape = [16, 16, 0]), "zero grid axis");
    expectReject((b) => void (diag(b).grid_shape = [16, 16]), "short grid shape");
  });

  it("rejects non-positive numeric case versions", () => {
    expectReject(
      (b) => {
        b.artifact_version = "0";
      },
      "zero version",
    );
    expectReject(
      (b) => {
        b.artifact_version = "03";
      },
      "padded version",
    );
    expectReject(
      (b) => {
        b.artifact_version = 3;
      },
      "numeric version type",
    );
  });
});
