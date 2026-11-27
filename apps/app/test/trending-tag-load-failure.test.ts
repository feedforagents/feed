// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadTrendingTag } from "../src/web/store-world.ts";
import { makeExploreSearchPayload, stubFetchUrl } from "./moderation-fixtures.ts";

function post(id: string, content: string) {
  return { id, authorId: "acct-alice", authorHandle: "alice", authorDisplayName: "Alice", content, createdAt: "2026-11-28T00:00:00.000Z" };
}

function trendingResponse(tag: string, postId: string) {
  return Promise.resolve(Response.json({ tag, posts: [post(postId, `Plant swap #${tag}`)] }));
}

function searchResponse(postId: string, handle: string) {
  return Promise.resolve(Response.json(makeExploreSearchPayload(post(postId, "Private gardens open Tuesday"), handle)));
}

function errorResponse(message: string) {
  return Promise.resolve(Response.json({ message }, { status: 500 }));
}

function stubTagLoads(failingTags: ReadonlySet<string>) {
  stubFetchUrl((url) => {
    const trending = /\/api\/trending\/([^?]+)/.exec(url);
    if (trending?.[1]) {
      const tag = decodeURIComponent(trending[1]);
      return failingTags.has(tag) ? errorResponse("Trending unavailable") : trendingResponse(tag, `${tag}-1`);
    }
    const explore = /\/api\/explore\?q=([^&]*)/.exec(url);
    if (explore) {
      const q = decodeURIComponent(explore[1] ?? "");
      return searchResponse(`untagged-${q}`, q);
    }
    return Promise.resolve(Response.json({ predictions: [], perps: [] }));
  });
}

function expectTagView(tag: string, postIds: ReadonlyArray<string>, errorMessage: string | null) {
  const s = getStoreSnapshot();
  expect(s.activeTrendingTag).toBe(tag);
  expect(s.explore.posts.map((p) => p.card.id)).toEqual(postIds);
  expect(s.explore.accounts.map((a) => a.handle)).toEqual([]);
  expect(s.exploreLoading).toBe(false);
  expect(s.errorMessage).toBe(errorMessage);
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    activeTrendingTag: null,
    exploreQuery: "",
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    exploreLoading: false,
    errorMessage: null,
    toasts: [],
  });
});

describe("trending tag load failure", () => {
  it('a failed trending tag load shows no search posts or people under the tag (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    stubTagLoads(new Set(["gardens"]));
    await loadTrendingTag("gardens");
    expectTagView("gardens", [], "Trending unavailable");
  });

  it('a failed switch to another tag drops the previous tag posts (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    stubTagLoads(new Set(["orchards"]));
    await loadTrendingTag("gardens");
    await loadTrendingTag("orchards");
    expectTagView("orchards", [], "Trending unavailable");
  });

  it('a successful trending tag load shows only the tag posts (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    stubTagLoads(new Set());
    await loadTrendingTag("gardens");
    expectTagView("gardens", ["gardens-1"], null);
  });

  it('a failed reload of the current tag keeps its posts and reports the failure (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const failingTags = new Set<string>();
    stubTagLoads(failingTags);
    await loadTrendingTag("gardens");
    failingTags.add("gardens");
    await loadTrendingTag("gardens");
    expectTagView("gardens", ["gardens-1"], "Trending unavailable");
  });
});
