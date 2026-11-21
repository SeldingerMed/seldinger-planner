import { useEffect, useId, useRef, useState } from "react";
import type { StartView, ViewProposal } from "./poseInitializer";
import type { PlaneLabel, VerifiedFrame } from "./projectionFrames";
import type { Polarity } from "./vesselness2d";
import { proposeFrameViews } from "./viewProposals";

/** A proposed view the operator picked as the start of a search, with the
 * frame and polarity it was proposed for. */
export type StartPick = {
  frame_sha256: string;
  plane: PlaneLabel;
  polarity: Polarity;
  /** 0 is the network's first proposal. */
  rank: number;
  view: StartView;
  share: number;
};

/** Whole degrees. A small negative angle is 0, not -0. */
const degrees = (value: number) => `${value.toFixed(0).replace(/^-0$/, "0")}°`;

/** The words for one picked or listed view. */
export function viewWords(view: StartView): string {
  return `primary ${degrees(view.primary_deg)}, secondary ${degrees(view.secondary_deg)}, turned ${degrees(view.turn_deg)} in the image`;
}

/** The network's share for a view. A share too small to round to one
 * percent is not shown as none, and one that rounds to the whole is not
 * shown as the whole. */
export function shareWords(share: number): string {
  if (share > 0 && share < 0.005) return "under 1%";
  if (share >= 0.995) return "over 99%";
  return `${Math.round(share * 100)}%`;
}

/** Proposes views for the frame on screen and lets the operator pick one
 * as the start of the search, or none. Nothing is picked for them. */
export default function ViewProposalPicker({
  frame,
  polarity,
  disabled,
  picked,
  elsewhere,
  onPick,
}: {
  frame: VerifiedFrame | null;
  polarity: Polarity;
  disabled: boolean;
  /** The pick, when it belongs to this frame and polarity and is the start
   * of the next search. */
  picked: StartPick | null;
  /** The start of the next search when it is a view picked for another
   * frame: with two planes, the other plane's. */
  elsewhere: StartPick | null;
  onPick: (pick: StartPick | null) => void;
}) {
  const name = useId(),
    key = frame ? `${frame.sha256}:${polarity}` : "",
    [found, setFound] = useState<{ key: string; views: ViewProposal[] } | null>(
      null,
    ),
    [working, setWorking] = useState(""),
    [failure, setFailure] = useState<{ key: string; message: string } | null>(
      null,
    ),
    open = useRef<AbortController | null>(null);
  // A request is for one frame at one polarity. When another is shown, or
  // the control goes, it is stopped: its views could not be listed. A
  // failure goes with it, and is not shown again when the frame comes back.
  useEffect(
    () => () => {
      open.current?.abort();
      setFailure(null);
    },
    [key],
  );

  async function propose() {
    if (!frame || disabled) return;
    const owned = key,
      control = new AbortController();
    open.current?.abort();
    open.current = control;
    setWorking(owned);
    setFailure(null);
    try {
      const views = await proposeFrameViews(frame, polarity, control.signal);
      if (!control.signal.aborted) setFound({ key: owned, views });
    } catch (error) {
      if (!control.signal.aborted)
        setFailure({
          key: owned,
          message:
            error instanceof Error && error.message
              ? error.message
              : "The views could not be proposed",
        });
    } finally {
      if (open.current === control) setWorking("");
    }
  }

  const views = found && found.key === key ? found.views : null,
    busy = !!working && working === key;
  return (
    <div className="view-proposals">
      <div className="native-actions">
        <button
          type="button"
          disabled={disabled || !frame || busy}
          onClick={() => void propose()}
        >
          {busy ? "Proposing views…" : "Propose views for this frame"}
        </button>
      </div>
      {failure && failure.key === key && (
        <p role="alert">
          No views were proposed: {failure.message.replace(/\.$/, "")}.
        </p>
      )}
      {views && frame && (
        <fieldset disabled={disabled}>
          <legend>Start the search from</legend>
          <label>
            <input
              type="radio"
              name={name}
              checked={!picked && !elsewhere}
              onChange={() => onPick(null)}
            />{" "}
            The volume&apos;s own position
          </label>
          {elsewhere && (
            <label>
              <input type="radio" name={name} checked readOnly /> Proposed view{" "}
              {elsewhere.rank + 1} for plane {elsewhere.plane.toUpperCase()}
              &apos;s frame: {viewWords(elsewhere.view)}
            </label>
          )}
          {views.map((view, rank) => (
            <label key={rank}>
              <input
                type="radio"
                name={name}
                checked={picked?.rank === rank}
                onChange={() =>
                  onPick({
                    frame_sha256: frame.sha256,
                    plane: frame.plane,
                    polarity,
                    rank,
                    view: {
                      primary_deg: view.primary_deg,
                      secondary_deg: view.secondary_deg,
                      turn_deg: view.turn_deg,
                    },
                    share: view.share,
                  })
                }
              />{" "}
              Proposed view {rank + 1}: {viewWords(view)} (share{" "}
              {shareWords(view.share)})
            </label>
          ))}
        </fieldset>
      )}
      <p className="carm-note">
        Proposed views come from a research network trained on synthetic frames,
        and are not for clinical use. It reads this frame only and never sees
        the 3D model. On real frames its first view is often not the nearest,
        and none of the five need be right. Angles are LAO positive and cranial
        positive, as in the entered geometry. The share is the network&apos;s
        own score, not a probability. A picked view turns the 3D model under the
        entered geometry before the search starts, and a proposal started this
        way can be reviewed but not saved.
      </p>
    </div>
  );
}
