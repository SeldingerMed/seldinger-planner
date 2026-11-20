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
import { vesselEvidence } from "./vesselEvidence2d";
import type { Polarity } from "./vesselness2d";
import { loadViewNetwork } from "./viewNetworkFile";

let installed: Promise<ViewNetwork> | null = null;

/** The network, fetched and checked once per page. A fetch that failed or
 * was abandoned is not kept: the next call tries again. */
export function viewNetwork(signal?: AbortSignal): Promise<ViewNetwork> {
  if (!installed) {
    const loading = loadViewNetwork(signal);
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

/** Fetches the network if need be and proposes views for the frame. The
 * computation takes about a second and is not sliced; it yields once
 * before it starts so that a status can be shown. */
export async function proposeFrameViews(
  frame: { gray: Uint8Array; width: number; height: number },
  polarity: Polarity,
  signal?: AbortSignal,
): Promise<ViewProposal[]> {
  const network = await viewNetwork(signal);
  await breathe();
  signal?.throwIfAborted();
  return frameViews(network, frame, polarity);
}
