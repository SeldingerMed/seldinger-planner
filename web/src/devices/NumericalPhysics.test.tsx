import { useLayoutEffect } from "react";
import { afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { expect, it, vi, beforeEach } from "vitest";
import NumericalPhysics from "./NumericalPhysics";

vi.mock("../api", () => {
  class RevisionConflictError extends Error {}
  return {
    RevisionConflictError,
    api: vi.fn(),
  };
});
import { api } from "../api";
const apiMock = vi.mocked(api);

const SCOPE = {
  caseState: {
    case_id: "case-1",
    title: "t",
    image_sha256: "a".repeat(64),
    source_url: null,
    dimensions: [1, 1, 1],
    spacing_mm: [1, 1, 1],
    spatial_units: "mm" as const,
    artifact_version: "3",
    notes: "",
    measurements: [],
  },
  sourceRevision: "rev-7",
  geometryResultId: "geom-9",
};

const hex64 = (c: string) => c.repeat(64);
const POINTS = [
  [0, 0, 0],
  [1, 0, 0],
  [2, 0.1, 0],
  [3, -0.1, 0],
  [4, 0, 0.1],
  [5, 0, -0.1],
];

function rodResult(overrides: Record<string, unknown> = {}) {
  return {
    method: "discrete_elastic_rod_native_lumen",
    clinical_validation: false,
    device_calibrated: false,
    optimizer_success: true,
    iterations: 42,
    energy_initial_n_mm: 120.5,
    energy_final_n_mm: 88.25,
    max_penetration_mm: 0.021,
    minimum_nodal_wall_clearance_mm: 0.134,
    points_ras: POINTS,
    job_sha256: hex64("b"),
    ...overrides,
  };
}

function flowResult() {
  return {
    method: "taylor_hood_native_voxel_stokes_brinkman",
    clinical_validation: false,
    device_calibrated: false,
    baseline_mean_sac_speed_mm_s: 42.5,
    treated_mean_sac_speed_mm_s: 12.75,
    relative_sac_speed_change_pct: -70,
    solver_diagnostics: {
      baseline: {
        momentum_residual_relative: 1e-6,
        discrete_continuity_residual: 2e-7,
        divergence_l2: 3e-8,
      },
      treated: {
        momentum_residual_relative: 4e-6,
        discrete_continuity_residual: 5e-7,
        divergence_l2: 6e-8,
      },
    },
    job_sha256: hex64("d"),
  };
}

function fillFlow() {
  fireEvent.click(screen.getByRole("button", { name: /stokes-flow/i }));
  for (const [label, value] of Object.entries({
    "Flow axis (native 0/1/2)": "1",
    "Inlet velocity (mm/s)": "120",
    "Fluid viscosity (Pa·s)": "0.0035",
    "Brinkman resistance (Pa·s per mm2)": "0.4",
    "Neck thickness (mm)": "1.5",
  }))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function envelope(
  kind: "rod-deployment" | "stokes-flow",
  result: unknown,
  overrides: Record<string, unknown> = {},
) {
  return {
    case_id: "case-1",
    image_sha256: hex64("a"),
    artifact_version: "3",
    reference_revision: "rev-7",
    kind,
    current: {
      status: "current",
      result_id: "res-11",
      dependencies: {
        case_id: "case-1",
        geometry_result_id: "geom-9",
        image_sha256: hex64("a"),
        artifact_version: "3",
        source_revision: "rev-7",
      },
      parameters:
        kind === "rod-deployment"
          ? {
              radius_mm: 0.125,
              ea_n: 8,
              ei_n_mm2: 0.02,
              contact_stiffness_n_per_mm: 0.5,
              rest_points_ras: null,
            }
          : {
              flow_axis: 1,
              inlet_velocity_mm_s: 120,
              viscosity_pa_s: 0.0035,
              resistance_pa_s_per_mm2: 0.4,
              neck_thickness_mm: 1.5,
            },
      parameters_sha256: hex64("c"),
      result,
    },
    ...overrides,
  };
}

function rodProps() {
  return {
    caseState: SCOPE.caseState,
    sourceRevision: SCOPE.sourceRevision,
    geometryResultId: SCOPE.geometryResultId,
  };
}

function fillRod(valid = true) {
  const values: Record<string, string> = valid
    ? {
        "Rod radius (mm)": "0.125",
        "Rod elastic axial stiffness EA (N)": "8",
        "Rod bending stiffness EI (N·mm2)": "0.02",
        "Lumen contact stiffness (N per mm)": "0.5",
      }
    : {
        "Rod radius (mm)": "0.125",
        "Rod elastic axial stiffness EA (N)": "8",
        "Rod bending stiffness EI (N·mm2)": "not-a-number",
        "Lumen contact stiffness (N per mm)": "0.5",
      };
  for (const [label, value] of Object.entries(values))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  return values;
}

beforeEach(() => {
  apiMock.mockReset();
});

afterEach(cleanup);

it("notifies saved-run readers only after a verified computation acknowledgement", async () => {
  const onStored = vi.fn();
  apiMock.mockResolvedValue(envelope("rod-deployment", rodResult()));
  render(<NumericalPhysics {...rodProps()} {...{onStored}} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", {name:"Compute solved numerics"}));
  await waitFor(() => expect(onStored).toHaveBeenCalledOnce());
});

it("disables the solver panel without a fully bound anatomy scope", () => {
  render(
    <NumericalPhysics
      caseState={null}
      sourceRevision={null}
      geometryResultId={null}
    />,
  );
  expect(screen.getByLabelText("Rod radius (mm)")).toBeDisabled();
  expect(screen.getByRole("button", { name: /compute/i })).toBeDisabled();
});

it("posts rod parameters with scope identities and renders a fully validated current result", async () => {
  apiMock.mockResolvedValue(envelope("rod-deployment", rodResult()));
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
  expect(apiMock).toHaveBeenCalledWith(
    "/cases/case-1/physics/rod-deployment",
    {
      artifact_version: "3",
      reference_revision: "rev-7",
      geometry_result_id: "geom-9",
      parameters: {
        radius_mm: 0.125,
        ea_n: 8,
        ei_n_mm2: 0.02,
        contact_stiffness_n_per_mm: 0.5,
        rest_points_ras: null,
      },
    },
    "POST",
  );
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  expect(
    screen.getByText(/discrete_elastic_rod_native_lumen/),
  ).toBeInTheDocument();
  expect(screen.getByText(/88\.25/)).toBeInTheDocument();
  expect(screen.getByText(/0\.021/)).toBeInTheDocument();
  expect(screen.getByText(/0\.134/)).toBeInTheDocument();
  expect(screen.getByText(/iterations: 42/i)).toBeInTheDocument();
  expect(screen.getAllByText(/nonclinical/i).length).toBeGreaterThan(0);
});

it("suppresses a deferred stale rod response and renders only the newer matching result", async () => {
  let resolveOld: (v: unknown) => void = () => {};
  const old = new Promise((r) => (resolveOld = r));
  const newer = envelope(
    "rod-deployment",
    rodResult({ energy_final_n_mm: 77 }),
  );
  newer.current.parameters = {
    radius_mm: 0.13,
    ea_n: 8,
    ei_n_mm2: 0.02,
    contact_stiffness_n_per_mm: 0.5,
    rest_points_ras: null,
  };
  apiMock.mockImplementationOnce(() => old).mockResolvedValueOnce(newer);
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  // User edits an input while the first request is in flight: stale result is suppressed.
  fireEvent.change(screen.getByLabelText("Rod radius (mm)"), {
    target: { value: "0.13" },
  });
  await act(async () => resolveOld(envelope("rod-deployment", rodResult())));
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /compute/i })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  expect(screen.queryByText(/88\.25/)).not.toBeInTheDocument();
  expect(screen.getByText(/77/)).toBeInTheDocument();
  // The old (radius 0.125) response never rendered: only one result region exists.
  expect(screen.getAllByTestId("np-result")).toHaveLength(1);
});

it("clears the rendered result when an input changes", async () => {
  apiMock.mockResolvedValue(envelope("rod-deployment", rodResult()));
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByLabelText("Rod radius (mm)"), {
    target: { value: "0.2" },
  });
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("clears the rendered result when case, source or geometry identity changes", async () => {
  apiMock.mockResolvedValue(envelope("rod-deployment", rodResult()));
  const { rerender } = render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  rerender(<NumericalPhysics {...rodProps()} geometryResultId="geom-10" />);
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
  rerender(<NumericalPhysics {...rodProps()} sourceRevision="rev-8" />);
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
  rerender(
    <NumericalPhysics
      {...rodProps()}
      caseState={{ ...SCOPE.caseState, artifact_version: "4" }}
    />,
  );
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("rejects a malformed or contradictory response instead of rendering it", async () => {
  // Wrong method name in result.
  apiMock.mockResolvedValue(
    envelope("rod-deployment", rodResult({ method: "something_else" })),
  );
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByText(/not rendered/i)).toBeInTheDocument(),
  );
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("rejects non-finite numeric output instead of rendering it", async () => {
  apiMock.mockResolvedValue(
    envelope("rod-deployment", rodResult({ energy_final_n_mm: Number.NaN })),
  );
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByText(/not rendered/i)).toBeInTheDocument(),
  );
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("keeps invalid draft text un-coerced and refuses to compute until fields validate", () => {
  render(<NumericalPhysics {...rodProps()} />);
  fillRod(false);
  expect(screen.getByRole("button", { name: /compute/i })).toBeDisabled();
  expect(screen.getByLabelText("Rod bending stiffness EI (N·mm2)")).toHaveValue(
    "not-a-number",
  );
});

it("posts stokes-flow parameters and renders speeds and solver diagnostics", async () => {
  apiMock.mockResolvedValue(envelope("stokes-flow", flowResult()));
  render(<NumericalPhysics {...rodProps()} />);
  fireEvent.click(screen.getByRole("button", { name: /stokes-flow/i }));
  const fill: Record<string, string> = {
    "Flow axis (native 0/1/2)": "1",
    "Inlet velocity (mm/s)": "120",
    "Fluid viscosity (Pa·s)": "0.0035",
    "Brinkman resistance (Pa·s per mm2)": "0.4",
    "Neck thickness (mm)": "1.5",
  };
  for (const [label, value] of Object.entries(fill))
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(apiMock).toHaveBeenCalled());
  expect(apiMock).toHaveBeenCalledWith(
    "/cases/case-1/physics/stokes-flow",
    {
      artifact_version: "3",
      reference_revision: "rev-7",
      geometry_result_id: "geom-9",
      parameters: {
        flow_axis: 1,
        inlet_velocity_mm_s: 120,
        viscosity_pa_s: 0.0035,
        resistance_pa_s_per_mm2: 0.4,
        neck_thickness_mm: 1.5,
      },
    },
    "POST",
  );
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  expect(screen.getByText(/42\.5/)).toBeInTheDocument();
  expect(screen.getByText(/-70/)).toBeInTheDocument();
  expect(screen.queryByText(/optimizer_success:/)).not.toBeInTheDocument();
  expect(
    screen.getByText(/taylor_hood_native_voxel_stokes_brinkman/),
  ).toBeInTheDocument();
  expect(screen.getAllByText(/nonclinical/i).length).toBeGreaterThan(0);
});

it("rejects missing flow residual diagnostics without crashing or painting numbers", async () => {
  const bad = flowResult();
  // An empty object must not pass vacuous Object.values validation.
  Object.assign(bad.solver_diagnostics, { baseline: {} });
  apiMock.mockResolvedValue(envelope("stokes-flow", bad));
  render(<NumericalPhysics {...rodProps()} />);
  fillFlow();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("rejects contradictory signed sac-speed arithmetic", async () => {
  apiMock.mockResolvedValue(
    envelope("stokes-flow", {
      ...flowResult(),
      relative_sac_speed_change_pct: 70,
    }),
  );
  render(<NumericalPhysics {...rodProps()} />);
  fillFlow();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("hides retained numbers during the commit, before passive effects clear old state", async () => {
  const painted: boolean[] = [];
  function Parent({ version, units }: { version: string; units: string }) {
    useLayoutEffect(() => {
      painted.push(!!document.querySelector('[data-testid="np-result"]'));
    }, [version, units]);
    return (
      <NumericalPhysics
        {...rodProps()}
        caseState={{
          ...SCOPE.caseState,
          artifact_version: version,
          spatial_units: units,
        }}
      />
    );
  }
  apiMock.mockResolvedValue(envelope("rod-deployment", rodResult()));
  const view = render(<Parent version="3" units="mm" />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() =>
    expect(screen.getByTestId("np-result")).toBeInTheDocument(),
  );
  view.rerender(<Parent version="4" units="mm" />);
  expect(painted.at(-1)).toBe(false);
});

it("rejects contradictory nested case identity", async () => {
  const response = envelope("rod-deployment", rodResult());
  Object.assign(response.current.dependencies, { case_id: "another-case" });
  apiMock.mockResolvedValue(response);
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("preserves an out-of-range radius draft but disables computation", () => {
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.change(screen.getByLabelText("Rod radius (mm)"), {
    target: { value: "-0.2" },
  });
  expect(screen.getByLabelText("Rod radius (mm)")).toHaveValue("-0.2");
  expect(screen.getByRole("button", { name: /compute/i })).toBeDisabled();
  expect(apiMock).not.toHaveBeenCalled();
});

it("requires exact numeric parameter echoes, not an approximate match", async () => {
  const response = envelope("rod-deployment", rodResult());
  Object.assign(response.current.parameters, { radius_mm: 0.12500000000001 });
  apiMock.mockResolvedValue(response);
  render(<NumericalPhysics {...rodProps()} />);
  fillRod();
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByTestId("np-result")).not.toBeInTheDocument();
});

it("never issues a network request when inputs are invalid", () => {
  render(<NumericalPhysics {...rodProps()} />);
  fillRod(false);
  fireEvent.click(screen.getByRole("button", { name: /compute/i }));
  expect(apiMock).not.toHaveBeenCalled();
});
