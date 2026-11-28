// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMarketDetails, toggleMute } from "../src/web/store-world.ts";
import {
  bobPostRaw,
  carolRepostedByBobRaw,
  erinPostRaw,
  jsonPayload,
  resetModerationStore,
  resetWorldFeedStore,
  stubFetchUrl,
} from "./moderation-fixtures.ts";

function stubMarket(handler: (url: string) => Promise<Response>) {
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(jsonPayload({ muted: true }));
    if (url.includes("/history")) return Promise.resolve(jsonPayload([]));
    if (url.includes("/trades")) return Promise.resolve(jsonPayload([]));
    return handler(url);
  });
}

function seedMarket() {
  resetWorldFeedStore({
    route: "Markets",
    marketSocialPosts: [],
    selectedMarketKind: "prediction",
    selectedMarketId: "mkt-1",
  });
  setStoreState({ mutedAccounts: [], errorMessage: null });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ marketSocialPosts: [], errorMessage: null, mutedAccounts: [] });
});

it(`Muting an author keeps their posts out of market social posts that land after the mute and strips their repost credit (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedMarket();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubMarket((url) => {
    if (url.includes("/api/feed")) {
      return gate.then(() => jsonPayload({ items: [bobPostRaw, erinPostRaw, carolRepostedByBobRaw], nextCursor: null }));
    }
    return Promise.resolve(jsonPayload({}, 404));
  });
  const inFlight = loadMarketDetails("prediction", "mkt-1");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const posts = getStoreSnapshot().marketSocialPosts;
  expect(posts.map((p) => p.card.id)).toEqual(["erin-post", "carol-post"]);
  expect(posts[1]?.card.repostedBy).toBeUndefined();
  expect(posts[1]?.card.repostedByHandle).toBeUndefined();
});

it(`Market social posts that land before any mute keep the author's posts (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedMarket();
  stubMarket((url) => {
    if (url.includes("/api/feed")) {
      return Promise.resolve(jsonPayload({ items: [bobPostRaw, erinPostRaw], nextCursor: null }));
    }
    return Promise.resolve(jsonPayload({}, 404));
  });
  await loadMarketDetails("prediction", "mkt-1");
  expect(getStoreSnapshot().marketSocialPosts.map((p) => p.card.id)).toEqual(["bob-post", "erin-post"]);
});
