// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadTrendingTag, toggleMute } from "../src/web/store-world.ts";
import { aliceViewer, bobPostRaw, decodedPost, erinPostRaw, resetModerationStore, stubFetchUrl } from "./moderation-fixtures.ts";

const tagIds = () => getStoreSnapshot().explore.posts.map((p) => p.card.id);

function seedTagPage() {
  setStoreState({
    viewer: aliceViewer,
    route: "Explore",
    activeTrendingTag: "gardens",
    exploreQuery: "gardens",
    explore: { trending: [], articles: [], posts: [bobPostRaw, erinPostRaw].map(decodedPost), accounts: [], actors: [], organizations: [], tags: [] },
    exploreLoading: false,
    mutedAccounts: [],
    errorMessage: null,
  });
}

it(`Muting an author keeps their posts out of a trending tag page when an in-flight tag load lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(Response.json({ muted: true }));
    if (url.startsWith("/api/trending/gardens")) {
      return gate.then(() => Response.json({ tag: "gardens", posts: [bobPostRaw, erinPostRaw] }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
  seedTagPage();
  const inFlight = loadTrendingTag("gardens");
  await toggleMute("bob", false);
  expect(tagIds()).toEqual(["erin-post"]);
  release();
  await inFlight;
  expect(tagIds()).toEqual(["erin-post"]);
  expect(getStoreSnapshot().exploreLoading).toBe(false);
});

it(`A failed mute request leaves the trending tag page and mute state unchanged (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) {
      return Promise.resolve(Response.json({ message: "Mute unavailable" }, { status: 500 }));
    }
    if (url.startsWith("/api/trending/gardens")) {
      return gate.then(() => Response.json({ tag: "gardens", posts: [bobPostRaw, erinPostRaw] }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
  seedTagPage();
  const inFlight = loadTrendingTag("gardens");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const s = getStoreSnapshot();
  expect({
    posts: tagIds(),
    muted: s.mutedAccounts.map((a) => a.handle),
    error: s.errorMessage,
  }).toEqual({
    posts: ["bob-post", "erin-post"],
    muted: [],
    error: "Mute unavailable",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({
    activeTrendingTag: null,
    exploreQuery: "",
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    exploreLoading: false,
    errorMessage: null,
    mutedAccounts: [],
  });
});
