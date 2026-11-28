// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadTrending } from "../src/web/store-world.ts";
import { stubFetchUrl } from "./moderation-fixtures.ts";

function trendingResponse(): Response {
  return Response.json({ trending: [{ tag: "gardens", postCount: 12 }] });
}

function articlesResponse(): Response {
  return Response.json({ articles: [{ id: "art-1", title: "Dispatch one", summary: "Wire copy", publishedAt: 1764307200000 }] });
}

function errorResponse(message: string): Response {
  return Response.json({ message }, { status: 500 });
}

function stubRailLoads(failing: ReadonlySet<"trending" | "articles">) {
  stubFetchUrl((url) => {
    if (/\/api\/trending(\?|$)/.test(url)) {
      return Promise.resolve(failing.has("trending") ? errorResponse("Trending unavailable") : trendingResponse());
    }
    if (/\/api\/articles/.test(url)) {
      return Promise.resolve(failing.has("articles") ? errorResponse("News unavailable") : articlesResponse());
    }
    return Promise.resolve(Response.json({ predictions: [], perps: [] }));
  });
}

function stubDeferredRailLoads() {
  const trending: Array<(res: Response) => void> = [];
  const articles: Array<(res: Response) => void> = [];
  stubFetchUrl(
    (url) =>
      new Promise<Response>((resolve) => {
        (url.includes("/api/trending") ? trending : articles).push(resolve);
      }),
  );
  return { trending, articles };
}

function expectRail(trendingTitles: string[], error: string | null) {
  const s = getStoreSnapshot();
  expect(s.trendingLoading).toBe(false);
  expect(s.rightRailTrending.map((t) => t.title)).toEqual(trendingTitles);
  expect(s.errorMessage).toBe(error);
  return s;
}

async function loadRail(failing: ReadonlySet<"trending" | "articles">) {
  stubRailLoads(failing);
  await loadTrending();
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
    await loadRail(new Set(["trending"]));
    expectRail([], "Trending unavailable");
  });

  it("surfaces a failed news load while keeping the trending topics that loaded", async () => {
    await loadRail(new Set(["articles"]));
    expectRail(["gardens"], "News unavailable");
  });

  it("loads the rail without an error when both requests succeed", async () => {
    await loadRail(new Set());
    const s = expectRail(["gardens"], null);
    expect(s.rightRailArticles.map((a) => a.id)).toEqual(["art-1"]);
  });

  it("ignores a stale load that fails after a newer load succeeded", async () => {
    const held = stubDeferredRailLoads();
    const stale = loadTrending();
    const fresh = loadTrending();
    held.trending[1](trendingResponse());
    held.articles[1](articlesResponse());
    await fresh;
    held.trending[0](errorResponse("Trending unavailable"));
    held.articles[0](articlesResponse());
    await stale;
    expectRail(["gardens"], null);
  });
});
