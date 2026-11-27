// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMoreFeed, selectFeedTab } from "../src/web/store-world.ts";
import { decodePosts } from "../src/web/types.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

function post(id: string) {
  return { id, authorId: "acct-bob", authorHandle: "bob", authorDisplayName: "Bob", content: `post ${id}`, createdAt: "2026-11-27T00:00:00.000Z" };
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ message: "Feed unavailable" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("home feed tab switch and Load more", () => {
  it('a failed tab load leaves no previous-tab posts or cursor for Load more to reuse (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const switching = selectFeedTab("top");
    pending.get("GET /api/feed")?.resolve(errorResponse());
    await switching;
    const s = getStoreSnapshot();
    expect(s.feedTab).toBe("top");
    expect(s.feedPosts.map((p) => p.card.id)).toEqual([]);
    expect(s.feedNextCursor).toBeNull();
    await loadMoreFeed();
    expect(getStoreSnapshot().feedLoadingMore).toBe(false);
  });

  it('a successful tab load replaces the list and cursor with the new tab page (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const switching = selectFeedTab("top");
    pending.get("GET /api/feed")?.resolve(jsonResponse({ items: [post("top-1")], nextCursor: "9:1764201600000:1764201600000:top-1" }));
    await switching;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["top-1"]);
    expect(s.feedNextCursor).toBe("9:1764201600000:1764201600000:top-1");
  });

  it('Load more failure keeps the current list and cursor for retry (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedLatestPage();
    const loading = loadMoreFeed();
    pending.get("GET /api/feed")?.resolve(errorResponse());
    await loading;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
    expect(s.feedNextCursor).toBe("1764201600000:latest-1");
    expect(s.feedLoadingMore).toBe(false);
  });
});
