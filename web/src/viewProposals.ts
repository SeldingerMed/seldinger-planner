/**
 * The view network for the overlay studio: fetched once per page, and asked
 * for views of the volume from a frame's vessel evidence. It never sees the
 * 3D model. The vessel evidence search is run from each view it proposes
 * and from the volume's own position (bestStart.ts).
 */
import {
  networkInput,
  proposeViews,
  runViewNetwork,
  type ViewNetwork,
  type ViewProposal,
} from "./poseInitializer";
import { STUDIO_REQUEST_TIMEOUT_MS } from "./requestDeadline";
import type { VesselEvidence } from "./vesselEvidence2d";
import { loadViewNetwork } from "./viewNetworkFile";

/** The deadline of the studio's other requests. */
export const VIEW_NETWORK_TIMEOUT_MS = STUDIO_REQUEST_TIMEOUT_MS;
export const VIEW_NETWORK_LATE = "The view network did not arrive in time";

let installed: Promise<ViewNetwork> | null = null;

/** The network, fetched and checked once per page. The fetch is the page's
 * and no caller's: one who gives up leaves it running for the next. It has
 * a deadline, and a fetch that failed or ran out of time is not kept: the
 * next call tries again. */
export function viewNetwork(): Promise<ViewNetwork> {
  if (!installed) {
    const control = new AbortController();
    const deadline = setTimeout(() => control.abort(), VIEW_NETWORK_TIMEOUT_MS),
      loading = loadViewNetwork(control.signal)
        .catch((error: unknown) => {
          // Only the stop made here is lateness: an abort, once this
          // deadline has passed. Whatever else went wrong is reported as
          // what it is, even when it surfaces afterwards.
          const stopped =
            control.signal.aborted &&
            (error as { name?: unknown } | null)?.name === "AbortError";
          throw stopped ? new Error(VIEW_NETWORK_LATE) : error;
        })
        .finally(() => clearTimeout(deadline));
    installed = loading;
    loading.catch(() => {
      if (installed === loading) installed = null;
    });
  }
  return installed;
}

/** Forgets the fetched network. For tests. */
export function forgetViewNetwork() {
  installed = null;
}

/** Up to five ranked views for one frame's vessel evidence. */
export function evidenceViews(
  network: ViewNetwork,
  evidence: VesselEvidence,
): ViewProposal[] {
  return proposeViews(runViewNetwork(network, networkInput(network, evidence)));
}
