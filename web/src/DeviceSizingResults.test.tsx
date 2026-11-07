import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import DeviceSizingResults, { parseSizingReport } from "./DeviceSizingResults";
import type { CaseState } from "./api";
import type { MorphometryBinding } from "./MorphometryInputs";
import calculatedFixture from "./fixtures/device-sizing-calculated-synthetic-metadata.json";
import outOfRangeFixture from "./fixtures/device-sizing-synthetic-metadata.json";
import variants from "./fixtures/device-sizing-synthetic-variants.json";

afterEach(cleanup);

function setup(
  fixture: { caseState: unknown; report: unknown },
  disabled = false,
) {
  const caseState = fixture.caseState as CaseState;
  const report = JSON.parse(JSON.stringify(fixture.report)) as Record<
    string,
    any
  >;
  const binding: MorphometryBinding = {
    case_id: caseState.case_id,
    image_sha256: caseState.image_sha256,
    reference_revision: report.reference_revision,
  };
  return { caseState, binding, report, disabled };
}

describe("parseSizingReport", () => {
  it("parses the calculated synthetic producer fixture with server-supplied numbers", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    const parsed = parseSizingReport(report, caseState, binding);
    expect(parsed).not.toBeNull();
    expect(parsed?.numbers_available).toBe(true);
    expect(parsed?.pipeline_status).toBe("geometric_checks_only");
    expect(parsed?.pipeline_metrics).toEqual([
      { label: "Largest parent diameter", value_mm: 3.5 },
      { label: "Minimum labeled coverage length", value_mm: 14.0 },
    ]);
    expect(parsed?.web_metrics).toEqual([
      { label: "Approximate WEB nominal target diameter", value_mm: 7.0 },
      { label: "Approximate WEB nominal target height", value_mm: 4.0 },
    ]);
  });

  it("renders producer-supplied numbers without recomputing them", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    const { queryByText } = render(
      <DeviceSizingResults
        caseState={caseState}
        binding={binding}
        report={report}
      />,
    );
    expect(queryByText("14.0 mm")).toBeTruthy();
    expect(queryByText("7.0 mm")).toBeTruthy();
    expect(queryByText("4.0 mm")).toBeTruthy();
    expect(
      queryByText(
        /No device is selected and no clinical compatibility is established/,
      ),
    ).toBeTruthy();
  });

  it("reports out_of_family_range wording for the all-outside-range fixture", () => {
    const { caseState, binding, report } = setup(outOfRangeFixture);
    const parsed = parseSizingReport(report, caseState, binding);
    expect(parsed?.pipeline_status).toBe("out_of_family_range");
    const { getByText } = render(
      <DeviceSizingResults
        caseState={caseState}
        binding={binding}
        report={report}
      />,
    );
    expect(getByText(/outside the historical documented range/)).toBeTruthy();
  });

  it("hides numbers when the inputs envelope is stale", () => {
    const { caseState, binding, report } = setup({
      caseState: variants.caseState,
      report: variants.stale,
    });
    const parsed = parseSizingReport(report, caseState, binding);
    expect(parsed?.numbers_available).toBe(false);
    const { queryByText } = render(
      <DeviceSizingResults
        caseState={caseState}
        binding={binding}
        report={report}
      />,
    );
    expect(queryByText("7.0 mm")).toBeNull();
  });

  it("returns null on mismatched nested dependencies", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    report.current.dependencies.catalog_version = "different";
    expect(parseSizingReport(report, caseState, binding)).toBeNull();
  });

  it.each([
    "source",
    "version",
    "hash",
    "unknown_geometry",
    "unknown_pipeline",
    "zero_input",
    "oversized_input",
    "extra_input",
    "nonfinite_target",
  ])("rejects malformed %s without keeping other numbers", (mode) => {
    const { caseState, binding, report } = setup(calculatedFixture);
    if (mode === "source") {
      report.geometry_dependencies.source_revision = "e".repeat(64);
      report.inputs.geometry_dependencies.source_revision = "e".repeat(64);
      report.current.dependencies.geometry.source_revision = "e".repeat(64);
    }
    if (mode === "version") {
      report.geometry_dependencies.artifact_version = "999";
      report.inputs.geometry_dependencies.artifact_version = "999";
      report.current.dependencies.geometry.artifact_version = "999";
    }
    if (mode === "hash") report.catalog_version = "not-a-hash";
    if (mode === "unknown_geometry") report.geometry_status = "unknown";
    if (mode === "unknown_pipeline")
      report.current.result.pipeline.status = "unknown";
    if (mode === "zero_input") report.inputs.measurements.distal_parent = 0;
    if (mode === "oversized_input")
      report.inputs.measurements.distal_parent = 101;
    if (mode === "extra_input") report.inputs.measurements.invented = 6;
    if (mode === "nonfinite_target")
      report.current.result.web.nominal_target_height_mm = Infinity;
    expect(parseSizingReport(report, caseState, binding)).toBeNull();
  });

  it.each([
    "unknown_result",
    "nonstrings_missing",
    "missing_outputs",
    "missing_status_numbers",
    "web_unsupported_numbers",
    "wrong_provenance",
    "wrong_missing_list",
  ])("rejects contradictory %s", (mode) => {
    const { caseState, binding, report } = setup(calculatedFixture);
    if (mode === "unknown_result") report.current.result.status = "unknown";
    if (mode === "nonstrings_missing")
      report.current.result.missing_inputs = [123];
    if (mode === "missing_outputs")
      delete report.current.result.web.nominal_target_height_mm;
    if (mode === "missing_status_numbers")
      report.current.result.pipeline.status = "missing_inputs";
    if (mode === "web_unsupported_numbers")
      report.current.result.web.status = "unsupported";
    if (mode === "wrong_provenance")
      report.current.result.provenance.note = "unrelated";
    if (mode === "wrong_missing_list")
      report.current.result.missing_inputs = ["dome_diameter"];
    expect(parseSizingReport(report, caseState, binding)).toBeNull();
  });

  it("shows actual partial producer gaps without numeric targets", () => {
    const props = setup({
      caseState: variants.caseState,
      report: variants.partial,
    });
    const parsed = parseSizingReport(
      props.report,
      props.caseState,
      props.binding,
    );
    expect(parsed?.missing_inputs).toHaveLength(6);
    expect(parsed?.pipeline_metrics).toEqual([]);
    expect(parsed?.web_metrics).toEqual([]);
  });

  it("compares captures structurally regardless of JSON key order", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    report.inputs.geometry_dependencies = Object.fromEntries(
      Object.entries(report.inputs.geometry_dependencies).reverse(),
    );
    expect(parseSizingReport(report, caseState, binding)).not.toBeNull();
  });

  it("returns null on true safety flags", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    report.current.result.pipeline.clinical_suitability_established = true;
    expect(parseSizingReport(report, caseState, binding)).toBeNull();
  });

  it("returns null on non-finite measurement values", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    report.inputs.measurements.distal_parent = Number.POSITIVE_INFINITY;
    expect(parseSizingReport(report, caseState, binding)).toBeNull();
  });

  it("hides numbers when disabled or the binding does not match", () => {
    const { caseState, binding, report } = setup(calculatedFixture);
    const disabled = render(
      <DeviceSizingResults
        caseState={caseState}
        binding={binding}
        report={report}
        disabled
      />,
    );
    expect(disabled.queryByText("7.0 mm")).toBeNull();
    const parsed = parseSizingReport(report, caseState, {
      ...binding,
      reference_revision: "other",
    });
    expect(parsed).toBeNull();
  });
});
