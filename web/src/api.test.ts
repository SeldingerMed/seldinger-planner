import { afterEach, expect, test, vi } from "vitest";
import {
  api,
  CONFLICT_REASON_HEADER,
  MEASUREMENTS_NOT_CURRENT,
  restoreOrCreateCase,
  RevisionConflictError,
} from "./api";
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState(null, "", "/");
});
test("reopens the saved workspace for the same image rather than losing its notes", async () => {
  const sha = "a".repeat(64);
  const saved = {
    case_id: "saved-case",
    image_sha256: sha,
    notes: "Synthetic saved note",
    measurements: [],
    artifact_version: "3",
  };
  localStorage.setItem("seldinger-case:" + sha, "saved-case");
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const restored = await restoreOrCreateCase({
    title: "Synthetic fixture",
    image_sha256: sha,
    source_url: null,
    dimensions: [10, 10, 10],
    spacing_mm: [1, 1, 1],
  });
  expect(restored.notes).toBe("Synthetic saved note");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe("/api/cases/saved-case");
});

test("an explicit case link reopens the same image-bound case on a fresh browser", async () => {
  const sha = "b".repeat(64),
    id = "L".repeat(22);
  history.replaceState(null, "", "/?case=" + id);
  const saved = {
    case_id: id,
    image_sha256: sha,
    notes: "Synthetic linked note",
    measurements: [],
    artifact_version: "4",
  };
  const fetcher = vi
    .fn()
    .mockImplementation((url: string, options?: RequestInit) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            options?.method === "POST"
              ? { ...saved, case_id: "new-case" }
              : saved,
          ),
          { status: 200 },
        ),
      ),
    );
  vi.stubGlobal("fetch", fetcher);
  const result = await restoreOrCreateCase({
    title: "Synthetic fixture",
    image_sha256: sha,
    source_url: null,
    dimensions: [10, 10, 10],
    spacing_mm: [1, 1, 1],
  });
  expect(result.case_id).toBe(id);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe("/api/cases/" + id);
  expect(localStorage.getItem("seldinger-case:" + sha)).toBe(id);
});

test.each(["missing", "wrong-image", "wrong-case"])(
  "a %s linked case fails closed without creating a replacement",
  async (mode) => {
    const sha = "b".repeat(64),
      id = "L".repeat(22);
    history.replaceState(null, "", "/?case=" + id);
    const state = {
      case_id: mode === "wrong-case" ? "M".repeat(22) : id,
      image_sha256: mode === "wrong-image" ? "c".repeat(64) : sha,
    };
    const fetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(state), {
          status: mode === "missing" ? 404 : 200,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      restoreOrCreateCase({
        title: "Synthetic fixture",
        image_sha256: sha,
        source_url: null,
        dimensions: [10, 10, 10],
        spacing_mm: [1, 1, 1],
      }),
    ).rejects.toThrow(/linked case/i);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(localStorage.getItem("seldinger-case:" + sha)).toBeNull();
  },
);

test.each(["", "../not-a-case", "short"])(
  "rejects malformed linked case %j before requests",
  async (id) => {
    const sha = "b".repeat(64);
    history.replaceState(null, "", "/?case=" + encodeURIComponent(id));
    const fetcher = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ case_id: "L".repeat(22), image_sha256: sha }),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      restoreOrCreateCase({
        title: "Synthetic fixture",
        image_sha256: sha,
        source_url: null,
        dimensions: [10, 10, 10],
        spacing_mm: [1, 1, 1],
      }),
    ).rejects.toThrow(/linked case/i);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

test("a refusal for a changed case carries the reason the server gave, or none", async () => {
  // The names the server uses: planner/device_scenario_server.py.
  expect([CONFLICT_REASON_HEADER, MEASUREMENTS_NOT_CURRENT]).toEqual([
    "X-Conflict-Reason",
    "measurements-not-current",
  ]);
  for (const [headers, reason] of [
    [
      { "X-Conflict-Reason": "measurements-not-current" },
      "measurements-not-current",
    ],
    [{}, null],
    // A header that came through empty is no reason.
    [{ "X-Conflict-Reason": "" }, null],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 409, headers })),
    );
    const refused = await api("/cases/one/device-scenarios").catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RevisionConflictError);
    expect((refused as RevisionConflictError).reason).toBe(reason);
  }
});
