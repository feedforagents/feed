// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { logout } from "../src/web/store-auth.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadFeed, loadMoreFeed } from "../src/web/store-world.ts";
import { decodePosts } from "../src/web/types.ts";
import { feedErrorResponse as errorResponse, feedPost as post, installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

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

async function signOutResolvingLatest(feedResponse: Response): Promise<void> {
  const pending = installDeferredFetch();
  seedFollowingPage();
  const signingOut = logout();
  pending.get("POST /api/auth/logout")?.resolve(jsonResponse({}));
  await tick();
  pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(feedResponse);
  await signingOut;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign out and the Latest feed load", () => {
  it('a failed Latest load after sign out leaves no previous-tab posts or cursor for Load more to reuse (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    await signOutResolvingLatest(errorResponse());
    const s = getStoreSnapshot();
    expect(s.viewer).toBeNull();
    expect(s.feedTab).toBe("latest");
    expect(s.feedPosts.map((p) => p.card.id)).toEqual([]);
    expect(s.feedNextCursor).toBeNull();
    await loadMoreFeed();
    expect(getStoreSnapshot().feedLoadingMore).toBe(false);
  });

  it('a successful Latest load after sign out replaces the list and cursor with the Latest page (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    await signOutResolvingLatest(jsonResponse({ items: [post("latest-1")], nextCursor: "1764201500000:latest-1" }));
    const s = getStoreSnapshot();
    expect(s.feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);
    expect(s.feedNextCursor).toBe("1764201500000:latest-1");
  });

  it('signing out from Latest hides the account page while the signed-out load runs and after it fails (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    setStoreState({ viewer: aliceViewer, feedTab: "latest", pendingNewPostCount: 3 });
    const firstLoad = loadFeed("latest");
    pending.get("GET /api/feed?tab=latest")?.resolve(jsonResponse({ items: [post("latest-1")], nextCursor: "1764201600000:latest-1" }));
    await firstLoad;
    expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["latest-1"]);

    const signingOut = logout();
    pending.get("POST /api/auth/logout")?.resolve(jsonResponse({}));
    await tick();
    expect(getStoreSnapshot().feedPosts).toEqual([]);
    pending.get("GET /api/feed?tab=latest&mode=game")?.resolve(errorResponse());
    await signingOut;

    const s = getStoreSnapshot();
    expect(s.viewer).toBeNull();
    expect(s.feedPosts).toEqual([]);
    expect(s.feedNextCursor).toBeNull();
    expect(s.pendingNewPostCount).toBe(0);
    expect(s.feedLoadingMore).toBe(false);
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
