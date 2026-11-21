/**
 * View proposals for one frame, for the overlay studio.
 *
 * The network is a research artifact (docs/research/view-network-v1.md).
 * It reads the frame's vessel evidence and nothing else, and it never sees
 * the 3D model. Its views are for an operator to pick from, or to ignore.
 */
import {
  networkInput,
  proposeViews,
  runViewNetwork,
  type ViewNetwork,
  type ViewProposal,
} from "./poseInitializer";
import { STUDIO_REQUEST_TIMEOUT_MS } from "./requestDeadline";
import { vesselEvidence } from "./vesselEvidence2d";
import type { Polarity } from "./vesselness2d";
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
    let late = false;
    const deadline = setTimeout(() => {
        late = true;
        control.abort();
      }, VIEW_NETWORK_TIMEOUT_MS),
      loading = loadViewNetwork(control.signal)
        .catch((error: unknown) => {
          throw late ? new Error(VIEW_NETWORK_LATE) : error;
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

/** Up to five ranked views for one frame, as the evaluation computed them:
 * the frame's vessel evidence at the stated polarity, through the network. */
export function frameViews(
  network: ViewNetwork,
  frame: { gray: Uint8Array; width: number; height: number },
  polarity: Polarity,
): ViewProposal[] {
  return proposeViews(
    runViewNetwork(
      network,
      networkInput(
        network,
        vesselEvidence(frame.gray, frame.width, frame.height, polarity),
      ),
    ),
  );
}

const breathe = () => new Promise<void>((done) => setTimeout(done, 0));

/** The promise, or the caller's own abort if that comes first. The promise
 * itself is left to run. */
function unlessAbandoned<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
}

/** Fetches the network if need be and proposes views for the frame. The
 * computation takes about a second and is not sliced; it yields once
 * before it starts so that a status can be shown. */
export async function proposeFrameViews(
  frame: { gray: Uint8Array; width: number; height: number },
  polarity: Polarity,
  signal?: AbortSignal,
): Promise<ViewProposal[]> {
  const network = await unlessAbandoned(viewNetwork(), signal);
  await breathe();
  signal?.throwIfAborted();
  return frameViews(network, frame, polarity);
}
