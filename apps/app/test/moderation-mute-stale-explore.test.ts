// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadExplore, loadTrendingTag, toggleMute } from "../src/web/store-world.ts";
import {
  aliceViewer,
  bobPostRaw,
  erinPostRaw,
  jsonPayload,
  makeExploreSearchPayload,
  resetModerationStore,
  stubFetchUrl,
} from "./moderation-fixtures.ts";

const exploreIds = () => getStoreSnapshot().explore.posts.map((p) => p.card.id);

function seedExplore() {
  setStoreState({
    viewer: aliceViewer,
    route: "Explore",
    feedTab: "latest",
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    exploreLoading: false,
    mutedAccounts: [],
    errorMessage: null,
  });
}

function gateOn(match: (url: string) => boolean, payload: () => unknown) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(jsonPayload({ muted: true }));
    if (match(url)) return gate.then(() => jsonPayload(payload()));
    if (url.startsWith("/api/markets")) return Promise.resolve(jsonPayload({ predictions: [], perps: [] }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  return () => release();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ exploreLoading: false, errorMessage: null, mutedAccounts: [] });
});

it(`Muting an author keeps their posts and account out of Explore when an in-flight search lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedExplore();
  const release = gateOn(
    (url) => url.startsWith("/api/explore"),
    () => ({
      trending: [],
      articles: [],
      search: {
        posts: [bobPostRaw, erinPostRaw],
        accounts: [
          { accountId: "acct-bob", handle: "bob", displayName: "Bob Trader", bio: "", avatarUrl: null, viewerFollows: false },
          { accountId: "acct-erin", handle: "erin", displayName: "Erin Fox", bio: "", avatarUrl: null, viewerFollows: false },
        ],
        actors: [],
        organizations: [],
        tags: [],
      },
    }),
  );
  const inFlight = loadExplore("bob");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const s = getStoreSnapshot();
  expect({
    posts: exploreIds(),
    accounts: s.explore.accounts.map((a) => a.handle),
    loading: s.exploreLoading,
  }).toEqual({
    posts: ["erin-post"],
    accounts: ["erin"],
    loading: false,
  });
});

it(`Muting an author keeps their posts out of Explore when an in-flight trending tag page lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedExplore();
  const release = gateOn(
    (url) => url.startsWith("/api/trending/"),
    () => ({ items: [bobPostRaw, erinPostRaw], nextCursor: null }),
  );
  const inFlight = loadTrendingTag("markets");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const s = getStoreSnapshot();
  expect({ posts: exploreIds(), loading: s.exploreLoading }).toEqual({
    posts: ["erin-post"],
    loading: false,
  });
});

it(`An explore search that lands before any mute keeps the author's posts (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedExplore();
  stubFetchUrl((url) => {
    if (url.startsWith("/api/explore")) {
      return Promise.resolve(jsonPayload(makeExploreSearchPayload(bobPostRaw, "bob")));
    }
    if (url.startsWith("/api/markets")) return Promise.resolve(jsonPayload({ predictions: [], perps: [] }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  await loadExplore("bob");
  expect(exploreIds()).toEqual(["bob-post"]);
});
