/**
 * The view network's weights, fetched from the planner and checked here.
 *
 * The size and SHA-256 are fixed in this file and, to the same values, in
 * planner/model_assets.py; a server test holds the two equal. The route
 * takes no parameters. Bytes of any other size or hash are not parsed.
 */
import { sha256Hex } from "./browserCrypto";
import { parseViewNetwork, type ViewNetwork } from "./poseInitializer";

export const VIEW_NETWORK_FILE = {
  size_bytes: 7_097_120,
  sha256: "1c76811cc68707e9a55c8ad99b75e13eeaf9b292c1fb10db75c0e7872a2b8b56",
} as const;

export const VIEW_NETWORK_ABSENT = "The view network is not installed";
export const VIEW_NETWORK_UNREADABLE =
  "The view network could not be read unchanged and is not used";

/** Fetches, checks and parses the network. Rejects with one of the two
 * messages above, or with an abort. `expected` is there for the tests: the
 * application passes nothing and gets the one identity fixed above. */
export async function loadViewNetwork(
  signal?: AbortSignal,
  expected: { size_bytes: number; sha256: string } = VIEW_NETWORK_FILE,
): Promise<ViewNetwork> {
  const response = await fetch("/api/view-network", {
    cache: "no-store",
    signal,
  });
  if (response.status === 404) throw new Error(VIEW_NETWORK_ABSENT);
  if (!response.ok) throw new Error(VIEW_NETWORK_UNREADABLE);
  const buffer = await response.arrayBuffer();
  if (
    buffer.byteLength !== expected.size_bytes ||
    (await sha256Hex(buffer)) !== expected.sha256
  )
    throw new Error(VIEW_NETWORK_UNREADABLE);
  try {
    return parseViewNetwork(new Uint8Array(buffer));
  } catch {
    throw new Error(VIEW_NETWORK_UNREADABLE);
  }
}
