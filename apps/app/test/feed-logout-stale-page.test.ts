// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { logout } from "../src/web/store-auth.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMoreFeed } from "../src/web/store-world.ts";
import { decodePosts } from "../src/web/types.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

function post(id: string) {
  return { id, authorId: "acct-bob", authorHandle: "bob", authorDisplayName: "Bob", content: `post ${id}`, createdAt: "2026-11-27T00:00:00.000Z" };
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ message: "Feed unavailable" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

function seedFollowingPage() {
  setStoreState({
    viewer: aliceViewer,
    feedTab: "following",
    feedPosts: decodePosts([post("following-1")]),
    feedNextCursor: "1764201600000:following-1",
    feedLoading: false,
    feedLoadingMore: false,
    pendingNewPostCount: 0,
  });
}

async function tick() {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign out and the Latest feed load", () => {
  it('a failed Latest load after sign out leaves no previous-tab posts or cursor for Load more to reuse (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedFollowingPage();
    const signingOut = logout();
    pending.get("POST /api/auth/logout")?.resolve(jsonResponse({}));
    await tick();
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(errorResponse());
    await signingOut;
    const s = getStoreSnapshot();
    expect(s.viewer).toBeNull();
    expect(s.feedTab).toBe("latest");
    expect(s.feedPosts.map((p) => p.card.id)).toEqual([]);
    expect(s.feedNextCursor).toBeNull();
    await loadMoreFeed();
    expect(getStoreSnapshot().feedLoadingMore).toBe(false);
  });

  it('a successful Latest load after sign out replaces the list and cursor with the Latest page (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedFollowingPage();
    const signingOut = logout();
    pending.get("POST /api/auth/logout")?.resolve(jsonResponse({}));
    await tick();
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(jsonResponse({ items: [post("latest-1")], nextCursor: "1764201500000:latest-1" }));
    await signingOut;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
    expect(s.feedNextCursor).toBe("1764201500000:latest-1");
  });

  it('Load more failure while signed in keeps the current list and cursor for retry (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    seedFollowingPage();
    const loading = loadMoreFeed();
    pending.get("GET /api/feed?tab=following&cursor=1764201600000%3Afollowing-1")?.resolve(errorResponse());
    await loading;
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["following-1"]);
    expect(s.feedNextCursor).toBe("1764201600000:following-1");
    expect(s.feedLoadingMore).toBe(false);
  });
});
