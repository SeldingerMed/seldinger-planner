/** The CT coronary tree over the same patient's cine, across heartbeats.
 *
 * The tree is admitted to the case only when it names this scan's SHA-256.
 * The cine is a local bundle (planner/cine_bundle.py) read in this browser
 * and never sent anywhere. The operator states that the cine is this
 * patient's; nothing pairs them by name. From the tree and the stated pair
 * the browser makes one proposal (./coronaryCorrespondence.ts): the heart's
 * period read from the cine, the frame at the CT's phase, each CT branch
 * named where it lies on that frame or named as not found, ambiguous or in
 * conflict, and the matched branches followed over the beats. The operator
 * replays it and confirms it, or does not. A confirmed record carries the
 * digests of the tree and the cine, never their contents. */
import { useEffect, useMemo, useRef, useState } from "react";
import "./coronary.css";
import type { CaseState } from "./api";
import { newRandomId } from "./browserCrypto";
import { parseCineBundle, type CineBundle } from "./cineBundle";
import {
  CORRESPONDENCE_METHOD,
  createCorrespondenceJob,
  REFUSAL_TEXT,
  type BranchStatus,
  type CorrespondenceProposal,
  type CorrespondenceResult,
  type CtTreeBranch,
} from "./coronaryCorrespondence";
import type { Identity } from "./territoryWorkflow";

type Props = {
  caseState: Pick<CaseState, "case_id" | "image_sha256" | "artifact_version">;
  binding: Pick<Identity, "reference_revision">;
  disabled?: boolean;
};

type TreeBody = {
  source_sha256: string;
  provenance: "curated_annotation" | "operator_traced" | "trained_inference";
  ct_phase_percent: number | null;
  branches: CtTreeBranch[];
};
type TreeRecord = {
  tree_revision: number;
  current:
    | { status: "not_confirmed" | "stale" }
    | { status: "current"; record_id: string; body_sha256: string; body: TreeBody };
};
type SavedRecord = {
  correspondence_revision: number;
  current:
    | { status: "not_confirmed" | "stale" }
    | {
        status: "current";
        record_id: string;
        evidence: "verified" | "unavailable";
        inputs: { pair: { tree_sha256: string; cine_source_sha256: string } };
        result: { matched: string[]; not_matched: Record<string, BranchStatus> };
      };
};
type Pair = { record_id: string; tree_sha256: string; cine_source_sha256: string };

const PROVENANCE_WORDS: Record<TreeBody["provenance"], string> = {
  curated_annotation: "curated annotation",
  operator_traced: "traced by an operator",
  trained_inference: "trained inference",
};
const STATUS_WORDS: Record<BranchStatus, string> = {
  matched: "matched",
  not_found: "not found in the cine",
  ambiguous: "ambiguous: two courses fit",
  conflict: "in conflict with another branch",
};
const TIMING_WORDS: Record<string, string> = {
  frame_time_vector: "recorded per frame",
  frame_time: "recorded frame interval",
  cine_rate: "display rate only, not a time",
};
const BRANCH_COLOR = ["#ff5a5a", "#ffd24a", "#4ad2ff", "#b07aff", "#5aff9a", "#ff9a3c"];

const short = (sha: string) => sha.slice(0, 8);
const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));

async function send<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body ? "PUT" : "GET",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const value = await response.json();
      if (typeof value?.detail === "string") detail = value.detail;
    } catch {
      // The status alone.
    }
    throw new Error(detail);
  }
  return response.json();
}

function readBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
}

/** What the server keeps of a confirmed proposal: digests, the phase, the
 * pose, each branch's outcome and the motion's counts. */
export function confirmedInputs(
  proposal: CorrespondenceProposal,
  treeRevision: number,
  cine: CineBundle,
) {
  if (!cine.view) throw new Error("The cine has no view");
  return {
    confirmed: true,
    method: CORRESPONDENCE_METHOD,
    pair: {
      stated_by: "operator",
      tree_revision: treeRevision,
      tree_sha256: proposal.tree_sha256,
      cine_source_sha256: proposal.cine_source_sha256,
      cine_bundle_sha256: proposal.bundle_sha256,
    },
    phase: {
      method: proposal.phase.method,
      ct_phase_percent: proposal.phase.ct_phase_percent,
      period_ms: proposal.phase.period_ms,
      quiet_frames: [...new Set(proposal.phase.quiet_frames)].sort((a, b) => a - b),
      frame: proposal.phase.frame,
    },
    view: cine.view,
    ct_to_carm_ras: proposal.fit.ct_to_carm_ras,
    reported_fit_score: clamp01(proposal.fit.score),
    branches: proposal.branches.map((b) => ({
      id: b.id,
      status: b.status,
      reported_score: clamp01(b.score),
    })),
    motion: {
      method: proposal.motion.method,
      frames: proposal.motion.frames.length,
      followed: proposal.motion.followed,
      refused: proposal.motion.refused,
    },
    clinical_validation: false,
  };
}

function FrameView({
  cine,
  proposal,
  frame,
}: {
  cine: CineBundle;
  proposal: CorrespondenceProposal;
  frame: number;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const { width, height } = cine.frames[0];
  useEffect(() => {
    const context = canvas.current?.getContext?.("2d");
    if (!context) return;
    const image = context.createImageData(width, height),
      pixels = cine.frames[frame].pixels;
    for (let i = 0; i < pixels.length; i++) {
      image.data[4 * i] = image.data[4 * i + 1] = image.data[4 * i + 2] = pixels[i];
      image.data[4 * i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }, [cine, frame, width, height]);
  const shown = proposal.motion.frames[frame];
  const colour = (id: string) =>
    BRANCH_COLOR[proposal.branches.findIndex((b) => b.id === id) % BRANCH_COLOR.length];
  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 512 }}>
      <canvas
        ref={canvas}
        width={width}
        height={height}
        style={{ width: "100%", display: "block" }}
        aria-label="Cine frame"
      />
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        aria-label="CT branches on this frame"
      >
        {shown && shown.status !== "refused"
          ? shown.branches.map((b) => (
              <polyline
                key={b.id}
                data-branch={b.id}
                points={b.points_px.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke={colour(b.id)}
                strokeWidth={1.5}
              />
            ))
          : null}
      </svg>
      <p role="status">
        Frame {frame + 1} of {cine.frames.length}
        {frame === proposal.phase.frame
          ? ": the CT's phase, where the branches were matched."
          : proposal.phase.quiet_frames.includes(frame)
            ? ": same phase, later beat."
            : ""}
        {shown?.status === "refused" ? " The tree is not drawn on this frame: it could not be followed." : ""}
      </p>
    </div>
  );
}

export default function CoronaryCorrespondencePanel({ caseState, binding, disabled }: Props) {
  const base = `/api/cases/${encodeURIComponent(caseState.case_id)}`;
  const [tree, setTree] = useState<TreeRecord | null>(null);
  const [saved, setSaved] = useState<SavedRecord | null>(null);
  const [cine, setCine] = useState<CineBundle | null>(null);
  const [pair, setPair] = useState<Pair | null>(null);
  const [result, setResult] = useState<CorrespondenceResult | null>(null);
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    let live = true;
    Promise.all([
      send<TreeRecord>(`${base}/coronary-tree`),
      send<SavedRecord>(`${base}/coronary-correspondence`),
    ])
      .then(([t, s]) => {
        if (!live) return;
        setTree(t);
        setSaved(s);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [base]);

  const current = tree?.current.status === "current" ? tree.current : null;
  const proposal = result?.status === "proposed" ? result : null;
  // A new tree or cine ends the proposal made from the old ones.
  useEffect(() => {
    run.current++;
    setResult(null);
    setFrame(0);
  }, [current?.body_sha256, cine?.bundle_sha256]);

  async function admitTree(file: File) {
    setError(null);
    setBusy(true);
    try {
      const text = new TextDecoder().decode(await readBytes(file));
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error("The tree file is not JSON.");
      }
      const next = await send<TreeRecord>(`${base}/coronary-tree`, {
        artifact_version: caseState.artifact_version,
        reference_revision: binding.reference_revision,
        tree_revision: tree?.tree_revision ?? 0,
        export: envelope,
      });
      setTree(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadCine(file: File) {
    setError(null);
    setBusy(true);
    try {
      setCine(await parseCineBundle(await readBytes(file)));
    } catch (e) {
      setCine(null);
      setError((e as Error).message === "Not a cine bundle" ? "Not a cine bundle." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function propose() {
    if (!current || !cine) return;
    const mine = ++run.current;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const job = createCorrespondenceJob({
        tree: {
          tree_sha256: current.body_sha256,
          ct_phase_percent: current.body.ct_phase_percent,
          branches: current.body.branches,
        },
        cine: {
          source_sha256: cine.source_sha256,
          bundle_sha256: cine.bundle_sha256,
          frames: cine.frames,
          timing: cine.timing,
          view: cine.view,
          geometry: cine.geometry,
        },
        pair,
      });
      // Short slices keep the page responsive.
      for (;;) {
        const until = performance.now() + 40;
        if (job.advance(() => performance.now() > until)) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (run.current !== mine) return;
      }
      const found = job.result();
      setResult(found);
      if (found.status === "proposed") setFrame(found.phase.frame);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      if (run.current === mine) setBusy(false);
    }
  }

  async function confirm() {
    if (!proposal || !cine || !tree) return;
    setBusy(true);
    setError(null);
    try {
      const next = await send<SavedRecord>(`${base}/coronary-correspondence`, {
        artifact_version: caseState.artifact_version,
        reference_revision: binding.reference_revision,
        correspondence_revision: saved?.correspondence_revision ?? 0,
        inputs: confirmedInputs(proposal, tree.tree_revision, cine),
      });
      setSaved(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const stated =
    pair && current && cine
      ? pair.tree_sha256 === current.body_sha256 && pair.cine_source_sha256 === cine.source_sha256
      : false;
  const savedCurrent = saved?.current.status === "current" ? saved.current : null;
  const off = disabled || busy;
  const branchWords = useMemo(
    () =>
      proposal?.branches.map((b) => ({
        ...b,
        words: STATUS_WORDS[b.status],
      })) ?? [],
    [proposal],
  );

  return (
    <section
      aria-label="Coronary tree over the cine"
      className="planning-section coronary-correspondence"
    >
      <h3>Coronary tree over the same patient's cine</h3>
      <p>
        One proposal from the CT tree and a cine you state is this patient's. It is not clinically
        validated; it is drawn only for you to confirm or set aside.
      </p>

      <h4>CT coronary tree</h4>
      {current ? (
        <p>
          {current.body.branches.length} branches, {PROVENANCE_WORDS[current.body.provenance]},
          CT phase{" "}
          {current.body.ct_phase_percent === null
            ? "not stated"
            : `${current.body.ct_phase_percent} percent`}
          . Tree {short(current.body_sha256)}.
        </p>
      ) : (
        <p>No tree admitted for this scan.</p>
      )}
      <label>
        Admit CT coronary tree
        <input
          type="file"
          accept=".json,application/json"
          disabled={off}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void admitTree(f);
            e.target.value = "";
          }}
        />
      </label>

      <h4>Cine</h4>
      {cine ? (
        <p>
          {cine.frames.length} frames, {cine.frames[0].width} by {cine.frames[0].height}; times{" "}
          {cine.timing ? TIMING_WORDS[cine.timing] : "not recorded"}; C-arm view{" "}
          {cine.view ? "recorded" : "not recorded"}
          {cine.geometry === "fixed"
            ? ", standing still"
            : cine.geometry === "moving"
              ? ", moving"
              : ", motion not declared"}
          . Cine {short(cine.source_sha256)}, held in this browser only.
        </p>
      ) : (
        <p>No cine loaded.</p>
      )}
      <label>
        Load cine bundle
        <input
          type="file"
          disabled={off}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadCine(f);
            e.target.value = "";
          }}
        />
      </label>

      <h4>Pair</h4>
      <label>
        <input
          type="checkbox"
          disabled={off || !current || !cine}
          checked={pair !== null}
          onChange={(e) =>
            setPair(
              e.target.checked && current && cine
                ? {
                    record_id: newRandomId(),
                    tree_sha256: current.body_sha256,
                    cine_source_sha256: cine.source_sha256,
                  }
                : null,
            )
          }
        />
        I state that this cine is this patient's
        {current && cine ? ` (tree ${short(current.body_sha256)}, cine ${short(cine.source_sha256)})` : ""}.
      </label>
      {pair && !stated ? (
        <p role="note">The stated pair names another tree or cine than the ones loaded now.</p>
      ) : null}

      <div>
        <button type="button" disabled={off || !current || !cine} onClick={() => void propose()}>
          Propose correspondence
        </button>
      </div>
      {busy ? <p role="status">Working…</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {result?.status === "refused" ? (
        <p role="alert" data-refusal={result.reason}>
          No proposal. {REFUSAL_TEXT[result.reason]}
        </p>
      ) : null}

      {proposal && cine ? (
        <div aria-label="Proposal">
          <p>
            Heart period read from the cine: {Math.round(proposal.phase.period_ms)} ms. The CT's
            phase ({proposal.phase.ct_phase_percent} percent) was matched on frame{" "}
            {proposal.phase.frame + 1}; the same phase recurs on{" "}
            {proposal.phase.quiet_frames.length} frames. Fit {proposal.fit.score.toFixed(2)} (from{" "}
            {proposal.fit.start_score.toFixed(2)}), vessel evidence, not an accuracy.
          </p>
          <table>
            <thead>
              <tr>
                <th>CT branch</th>
                <th>In the cine</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {branchWords.map((b) => (
                <tr key={b.id} data-branch={b.id} data-status={b.status}>
                  <td>
                    {b.label} ({b.id})
                  </td>
                  <td>{b.words}</td>
                  <td>{b.score.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Matched on frame {proposal.phase.frame + 1}, then followed on{" "}
            {proposal.motion.followed} of the other {proposal.motion.frames.length - 1} frames;
            not drawn on {proposal.motion.refused}.
          </p>
          <FrameView cine={cine} proposal={proposal} frame={frame} />
          <label>
            Frame
            <input
              type="range"
              min={0}
              max={cine.frames.length - 1}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
            />
          </label>
          <button type="button" disabled={off} onClick={() => setFrame(proposal.phase.frame)}>
            Go to the CT's phase
          </button>
          <div>
            <button type="button" disabled={off} onClick={() => void confirm()}>
              Confirm this correspondence
            </button>
          </div>
        </div>
      ) : null}

      {savedCurrent ? (
        <p role="status" aria-label="Confirmed correspondence">
          Confirmed: {savedCurrent.result.matched.length} branches matched
          {Object.keys(savedCurrent.result.not_matched).length
            ? `, ${Object.keys(savedCurrent.result.not_matched).length} not`
            : ""}
          , tree {short(savedCurrent.inputs.pair.tree_sha256)} with cine{" "}
          {short(savedCurrent.inputs.pair.cine_source_sha256)}.{" "}
          {savedCurrent.evidence === "verified"
            ? "It still matches the admitted tree."
            : "The tree has changed since; it no longer stands."}
        </p>
      ) : null}
    </section>
  );
}
