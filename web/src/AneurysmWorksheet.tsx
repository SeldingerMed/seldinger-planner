import { useEffect, useState } from "react";
import type { Measurement } from "./api";
import type { Point3 } from "./geometry";
import {
  discussionOptions,
  emptyPlan,
  measurementRoles,
  type AneurysmPlan,
} from "./planning";

type Props = {
  caseId: string;
  plan: AneurysmPlan | null;
  measurements: Measurement[];
  spatialUnits: "mm" | "unknown";
  location: Point3 | null;
  disabled: boolean;
  onSave: (plan: AneurysmPlan) => Promise<void>;
  onFocus: (point: Point3) => void;
  onDirtyChange: (dirty: boolean) => void;
};
export default function AneurysmWorksheet({
  caseId,
  plan,
  measurements,
  spatialUnits,
  location,
  disabled,
  onSave,
  onFocus,
  onDirtyChange,
}: Props) {
  const initial = JSON.stringify(plan ?? emptyPlan);
  const [draft, setDraft] = useState<AneurysmPlan>(() => JSON.parse(initial));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(JSON.parse(initial));
    setError("");
  }, [caseId, initial]);
  const dirty = JSON.stringify(draft) !== initial;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  function update<K extends keyof AneurysmPlan>(
    key: K,
    value: AneurysmPlan[K],
  ) {
    setDraft((old) => ({ ...old, [key]: value }));
  }
  async function save() {
    setError("");
    try {
      await onSave(draft);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="planning-section aneurysm-worksheet" id="aneurysm-plan">
      <h3>
        Aneurysm worksheet{" "}
        <span className="plan-status">
          {dirty ? "Unsaved" : plan ? "Saved" : "New"}
        </span>
      </h3>
      <p className="method-note">Operator-entered target and context.</p>
      <fieldset disabled={disabled}>
        <label className="field-label">
          Aneurysm label
          <input
            aria-label="Aneurysm label"
            value={draft.lesion_label}
            maxLength={80}
            onChange={(e) => update("lesion_label", e.target.value)}
          />
        </label>
        <label className="field-label">
          Location / segment
          <input
            aria-label="Location / segment"
            value={draft.location_note}
            maxLength={240}
            placeholder="Operator-identified anatomy"
            onChange={(e) => update("location_note", e.target.value)}
          />
        </label>
        <div className="point-row">
          <button
            disabled={!location}
            onClick={() => update("focus_ras", location ? [...location] : null)}
          >
            Use crosshair as target
          </button>
          <button
            disabled={!draft.focus_ras}
            onClick={() => draft.focus_ras && onFocus([...draft.focus_ras])}
          >
            View target
          </button>
        </div>
        {draft.focus_ras && (
          <p className="target-coordinate mono">
            RAS {spatialUnits === "mm" ? "mm" : "source units"} ·{" "}
            {draft.focus_ras.map((v) => v.toFixed(1)).join(" / ")}
          </p>
        )}
        <label className="field-label">
          Rupture status
          <select
            aria-label="Rupture status"
            value={draft.rupture_status}
            onChange={(e) =>
              update(
                "rupture_status",
                e.target.value as AneurysmPlan["rupture_status"],
              )
            }
          >
            <option value="unknown">Unknown</option>
            <option value="unruptured">Unruptured (operator-entered)</option>
            <option value="ruptured">Ruptured (operator-entered)</option>
          </select>
        </label>
        <details className="context-details">
          <summary>Clinical context & questions</summary>
          <label className="field-label">
            Clinical context
            <textarea
              aria-label="Clinical context"
              value={draft.clinical_context}
              maxLength={2000}
              placeholder="Known history, constraints and information still needed"
              onChange={(e) => update("clinical_context", e.target.value)}
            />
          </label>
          <label className="field-label">
            Planning questions
            <textarea
              aria-label="Planning questions"
              value={draft.questions}
              maxLength={2000}
              placeholder="What should be compared or verified?"
              onChange={(e) => update("questions", e.target.value)}
            />
          </label>
        </details>
        <h4>Manual evidence links</h4>
        <p className="method-note">
          Assign a role to a saved point pair. This does not establish validated
          morphometry.
        </p>
        <div className="evidence-fields">
          {measurementRoles.map(([role, name]) => (
            <label key={role} className="field-label">
              {name}
              <select
                aria-label={`${name} evidence`}
                value={draft.measurement_links[role] ?? ""}
                disabled={spatialUnits !== "mm"}
                onChange={(e) => {
                  const links = { ...draft.measurement_links };
                  if (e.target.value) links[role] = e.target.value;
                  else delete links[role];
                  update("measurement_links", links);
                }}
              >
                <option value="">Not measured</option>
                {measurements.map((m) => (
                  <option
                    key={m.measurement_id}
                    value={m.measurement_id}
                    disabled={Object.entries(draft.measurement_links).some(
                      ([r, id]) => r !== role && id === m.measurement_id,
                    )}
                  >
                    {m.label} · {m.distance_mm.toFixed(2)} mm
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <h4>Options to discuss</h4>
        <div className="option-grid">
          {discussionOptions.map(([id, name]) => (
            <label key={id}>
              <input
                type="checkbox"
                aria-label={name}
                checked={draft.options.includes(id)}
                onChange={(e) =>
                  update(
                    "options",
                    e.target.checked
                      ? [...draft.options, id]
                      : draft.options.filter((o) => o !== id),
                  )
                }
              />
              {name}
            </label>
          ))}
        </div>
        <button
          className="primary"
          disabled={!dirty || !draft.lesion_label.trim()}
          onClick={save}
        >
          Save aneurysm plan
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="worksheet-error">
          {error}
        </p>
      )}
    </section>
  );
}
