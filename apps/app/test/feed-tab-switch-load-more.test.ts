// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadFeed, loadMoreFeed, selectFeedTab } from "../src/web/store-world.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { decodePosts } from "../src/web/types.ts";
import { feedErrorResponse as errorResponse, feedPost as post, installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

function seedLatestPage() {
  setStoreState({
    feedTab: "latest",
    feedPosts: decodePosts([post("latest-1")]),
    feedNextCursor: "1764201600000:latest-1",
    feedLoading: false,
    feedLoadingMore: false,
    pendingNewPostCount: 0,
  });
}

function expectLatestPageIntact() {
  const s = getStoreSnapshot();
  expect(s.feedTab).toBe("latest");
  expect(s.feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
  expect(s.feedNextCursor).toBe("1764201600000:latest-1");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("home feed tab switch and Load more", () => {
  it('a failed tab load rolls back to the previous tab with its page and cursor intact (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const switching = selectFeedTab("top");
    expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual([]);
    pending.get("GET /api/feed?tab=top&mode=game")?.resolve(errorResponse());
    await switching;
    expectLatestPageIntact();
    const loading = loadMoreFeed();
    pending.get("GET /api/feed?tab=latest&cursor=1764201600000%3Alatest-1&mode=game")?.resolve(errorResponse());
    await loading;
    expect(getStoreSnapshot().feedLoadingMore).toBe(false);
    expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
  });

  it('a successful tab load replaces the list and cursor with the new tab page (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const switching = selectFeedTab("top");
    pending.get("GET /api/feed?tab=top&mode=game")?.resolve(jsonResponse({ items: [post("top-1")], nextCursor: "9:1764201600000:1764201600000:top-1" }));
    await switching;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["top-1"]);
    expect(s.feedNextCursor).toBe("9:1764201600000:1764201600000:top-1");
  });

  it('switching back to the loaded tab before the new tab loads keeps its page when the reload fails (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const loaded = selectFeedTab("latest");
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(jsonResponse({ items: [post("latest-1")], nextCursor: "1764201600000:latest-1" }));
    await loaded;
    const toTop = selectFeedTab("top");
    const backToLatest = selectFeedTab("latest");
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(errorResponse());
    await backToLatest;
    pending.get("GET /api/feed?tab=top&mode=game")?.resolve(errorResponse());
    await toTop;
    expectLatestPageIntact();
    expect(getStoreSnapshot().feedLoading).toBe(false);
  });

  it('Load more failure keeps the current list and cursor for retry (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const loading = loadMoreFeed();
    pending.get("GET /api/feed?tab=latest&cursor=1764201600000%3Alatest-1&mode=game")?.resolve(errorResponse());
    await loading;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
    expect(s.feedNextCursor).toBe("1764201600000:latest-1");
    expect(s.feedLoadingMore).toBe(false);
  });

  it('signing out before a failed reload does not restore the signed-in tab page (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    setStoreState({ viewer: makeViewerSession() });
    seedLatestPage();
    const loaded = selectFeedTab("latest");
    pending.get("GET /api/feed?tab=latest")?.resolve(jsonResponse({ items: [post("latest-1")], nextCursor: "1764201600000:latest-1" }));
    await loaded;
    const toTop = selectFeedTab("top");
    setStoreState({ viewer: null, feedTab: "latest" });
    const reloading = loadFeed("latest");
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(errorResponse());
    await reloading;
    pending.get("GET /api/feed?tab=top")?.resolve(errorResponse());
    await toTop;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual([]);
    expect(s.feedNextCursor).toBeNull();
    expect(s.feedLoading).toBe(false);
  });
});
