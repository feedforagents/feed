// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadTrending } from "../src/web/store-world.ts";
import { stubFetchUrl } from "./moderation-fixtures.ts";

function trendingResponse() {
  return Promise.resolve(Response.json({ trending: [{ tag: "gardens", postCount: 12 }] }));
}

function articlesResponse() {
  return Promise.resolve(
    Response.json({ articles: [{ id: "art-1", title: "Dispatch one", summary: "Wire copy", publishedAt: 1764307200000 }] }),
  );
}

function errorResponse(message: string) {
  return Promise.resolve(Response.json({ message }, { status: 500 }));
}

function stubRailLoads(failing: ReadonlySet<"trending" | "articles">) {
  stubFetchUrl((url) => {
    if (/\/api\/trending(\?|$)/.test(url)) {
      return failing.has("trending") ? errorResponse("Trending unavailable") : trendingResponse();
    }
    if (/\/api\/articles/.test(url)) {
      return failing.has("articles") ? errorResponse("News unavailable") : articlesResponse();
    }
    return Promise.resolve(Response.json({ predictions: [], perps: [] }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    trendingLoading: false,
    rightRailTrending: [],
    rightRailArticles: [],
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    errorMessage: null,
    toasts: [],
  });
});

describe("trending rail load failure", () => {
  it("surfaces a failed trending load instead of an empty rail", async () => {
    stubRailLoads(new Set(["trending"]));
    await loadTrending();
    const s = getStoreSnapshot();
    expect(s.trendingLoading).toBe(false);
    expect(s.rightRailTrending).toEqual([]);
    expect(s.errorMessage).toBe("Trending unavailable");
  });

  it("surfaces a failed news load while keeping the trending topics that loaded", async () => {
    stubRailLoads(new Set(["articles"]));
    await loadTrending();
    const s = getStoreSnapshot();
    expect(s.trendingLoading).toBe(false);
    expect(s.rightRailTrending.map((t) => t.title)).toEqual(["gardens"]);
    expect(s.errorMessage).toBe("News unavailable");
  });

  it("loads the rail without an error when both requests succeed", async () => {
    stubRailLoads(new Set());
    await loadTrending();
    const s = getStoreSnapshot();
    expect(s.trendingLoading).toBe(false);
    expect(s.rightRailTrending.map((t) => t.title)).toEqual(["gardens"]);
    expect(s.rightRailArticles.map((a) => a.id)).toEqual(["art-1"]);
    expect(s.errorMessage).toBeNull();
  });
});
