// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadAdminWorldFacts } from "../src/web/store-auth.ts";
import { adminViewer } from "./admin-fixtures.ts";
import { installDeferredFetchQueue, jsonResponse } from "./deferred-fetch.ts";

const factsKey = "GET /api/admin/world-facts?limit=100";
const factOne = { id: "fact-1", factText: "The river market opens at dawn.", category: "markets" };
const factTwo = { id: "fact-2", factText: "A comet crosses the north sky.", category: "world" };

function seedAdmin(): void {
  setStoreState({ viewer: adminViewer, adminFacts: [], adminTabLoading: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, adminFacts: [], adminTabLoading: false });
});

describe("admin world facts load race", () => {
  it('stale response started before a create must not drop the created fact (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const refresh = loadAdminWorldFacts();
    const reload = loadAdminWorldFacts();
    queue.resolveNewest(factsKey, jsonResponse([factOne, factTwo]));
    await reload;
    expect(getStoreSnapshot().adminFacts.map((f) => f.id)).toEqual(["fact-1", "fact-2"]);
    queue.resolveOldest(factsKey, jsonResponse([factOne]));
    await refresh;
    expect(getStoreSnapshot().adminFacts.map((f) => f.id)).toEqual(["fact-1", "fact-2"]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });

  it('stale response started before a delete must not resurrect the deleted fact (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const queue = installDeferredFetchQueue();
    const refresh = loadAdminWorldFacts();
    const reload = loadAdminWorldFacts();
    queue.resolveNewest(factsKey, jsonResponse([]));
    await reload;
    expect(getStoreSnapshot().adminFacts.map((f) => f.id)).toEqual([]);
    queue.resolveOldest(factsKey, jsonResponse([factOne]));
    await refresh;
    expect(getStoreSnapshot().adminFacts.map((f) => f.id)).toEqual([]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });
});
