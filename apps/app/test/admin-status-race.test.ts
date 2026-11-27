// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadAdminStatus } from "../src/web/store-auth.ts";
import { adminViewer } from "./admin-fixtures.ts";
import { installDeferredFetchQueue, jsonResponse } from "./deferred-fetch.ts";

const statusKey = "GET /api/admin/status";

function seedAdmin(): void {
  setStoreState({ viewer: adminViewer, adminStatus: null, adminLoading: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, adminStatus: null, adminLoading: false });
});

describe("admin status load race", () => {
  it('stale response started before a hold resolve must not resurrect the resolved hold (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const refresh = loadAdminStatus();
    const reload = loadAdminStatus();
    queue.resolveNewest(statusKey, jsonResponse({ manualHolds: [] }));
    await reload;
    expect(getStoreSnapshot().adminStatus?.manualHolds.map((h) => h.id)).toEqual([]);
    queue.resolveOldest(statusKey, jsonResponse({ manualHolds: [{ id: "market-1", question: "Will it rain?" }] }));
    await refresh;
    expect(getStoreSnapshot().adminStatus?.manualHolds.map((h) => h.id)).toEqual([]);
    expect(getStoreSnapshot().adminLoading).toBe(false);
  });

  it('stale response started before a fast-forward must not rewind the world clock (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const refresh = loadAdminStatus();
    const reload = loadAdminStatus();
    queue.resolveNewest(statusKey, jsonResponse({ currentDay: 3, currentHour: 9 }));
    await reload;
    expect(getStoreSnapshot().adminStatus?.currentHour).toBe(9);
    queue.resolveOldest(statusKey, jsonResponse({ currentDay: 3, currentHour: 4 }));
    await refresh;
    expect(getStoreSnapshot().adminStatus?.currentHour).toBe(9);
    expect(getStoreSnapshot().adminLoading).toBe(false);
  });
});
