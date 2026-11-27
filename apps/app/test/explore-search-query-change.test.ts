// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { loadExplore } from "../src/web/store-world.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

function post(id: string) {
  return { id, authorId: "acct-alice", authorHandle: "alice", authorDisplayName: "Alice", content: `post ${id}`, createdAt: "2026-11-27T00:00:00.000Z" };
}

function explorePayload(postId: string, handle: string) {
  return {
    trending: [],
    articles: [],
    search: {
      posts: [post(postId)],
      accounts: [{ accountId: `acct-${handle}`, handle, displayName: handle, bio: "", avatarUrl: null, viewerFollows: false }],
      actors: [],
      organizations: [],
      tags: [],
    },
  };
}

function errorResponse(): Response {
  return new Response(JSON.stringify({ message: "Explore unavailable" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

function exploreKey(q: string) {
  return `GET /api/explore?q=${q}&mode=game`;
}

async function loadAliceResults(pending: ReturnType<typeof installDeferredFetch>) {
  const loading = loadExplore("alice");
  pending.get(exploreKey("alice"))?.resolve(jsonResponse(explorePayload("alice-1", "alice")));
  pending.get("GET /api/markets")?.resolve(jsonResponse({ predictions: [], perps: [] }));
  await loading;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explore search query change", () => {
  it('a failed new search leaves no previous-query posts or people under the new query (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    await loadAliceResults(pending);
    const searching = loadExplore("boris");
    pending.get(exploreKey("boris"))?.resolve(errorResponse());
    pending.get("GET /api/markets")?.resolve(jsonResponse({ predictions: [], perps: [] }));
    await searching;
    const s = getStoreSnapshot();
    expect(s.exploreQuery).toBe("boris");
    expect(s.explore.posts.map((p) => p.card.id)).toEqual([]);
    expect(s.explore.accounts.map((a) => a.handle)).toEqual([]);
    expect(s.exploreLoading).toBe(false);
  });

  it('a successful new search replaces the previous query results (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    await loadAliceResults(pending);
    const searching = loadExplore("boris");
    pending.get(exploreKey("boris"))?.resolve(jsonResponse(explorePayload("boris-1", "boris")));
    pending.get("GET /api/markets")?.resolve(jsonResponse({ predictions: [], perps: [] }));
    await searching;
    const s = getStoreSnapshot();
    expect(s.exploreQuery).toBe("boris");
    expect(s.explore.posts.map((p) => p.card.id)).toEqual(["boris-1"]);
    expect(s.explore.accounts.map((a) => a.handle)).toEqual(["boris"]);
  });

  it('a failed refresh of the current query keeps its results for retry (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const pending = installDeferredFetch();
    await loadAliceResults(pending);
    const refreshing = loadExplore("alice");
    pending.get(exploreKey("alice"))?.resolve(errorResponse());
    pending.get("GET /api/markets")?.resolve(jsonResponse({ predictions: [], perps: [] }));
    await refreshing;
    const s = getStoreSnapshot();
    expect(s.exploreQuery).toBe("alice");
    expect(s.explore.posts.map((p) => p.card.id)).toEqual(["alice-1"]);
    expect(s.explore.accounts.map((a) => a.handle)).toEqual(["alice"]);
  });
});
