// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadFeed, loadMoreFeed, toggleMute } from "../src/web/store-world.ts";
import { aliceViewer, bobPostRaw, decodedPost, erinPostRaw, postRaw, resetModerationStore, stubFetchUrl } from "./moderation-fixtures.ts";

const bobOlderRaw = postRaw({
  id: "bob-older-post",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob older call",
  createdAt: Date.now() - 3_600_000,
});

const feedIds = () => getStoreSnapshot().feedPosts.map((p) => p.card.id);

function seedHomeFeed(nextCursor: string | null = null) {
  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [bobPostRaw, erinPostRaw].map(decodedPost),
    feedNextCursor: nextCursor,
    feedLoading: false,
    feedLoadingMore: false,
    mutedAccounts: [],
    errorMessage: null,
  });
}

async function runMuteWhileFeedInFlight(
  feedItems: ReadonlyArray<Record<string, unknown>>,
  nextCursor: string | null,
  startRequest: () => Promise<void>,
) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(Response.json({ muted: true }));
    if (url.startsWith("/api/feed")) {
      return gate.then(() => Response.json({ items: feedItems, nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
  seedHomeFeed(nextCursor);
  const inFlight = startRequest();
  await toggleMute("bob", false);
  expect(feedIds()).toEqual(["erin-post"]);
  release();
  await inFlight;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ feedNextCursor: null, feedLoading: false, feedLoadingMore: false, errorMessage: null, mutedAccounts: [] });
});

it(`Muting an author keeps their posts out of the Home feed when an in-flight load-more page lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  await runMuteWhileFeedInFlight([bobOlderRaw], "cursor-1", () => loadMoreFeed());
  const s = getStoreSnapshot();
  expect({ feed: feedIds(), loadingMore: s.feedLoadingMore }).toEqual({
    feed: ["erin-post"],
    loadingMore: false,
  });
});

it(`Muting an author keeps their posts out of the Home feed when an in-flight feed reload lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  await runMuteWhileFeedInFlight([bobPostRaw, erinPostRaw], null, () => loadFeed());
  const s = getStoreSnapshot();
  expect({ feed: feedIds(), loading: s.feedLoading }).toEqual({
    feed: ["erin-post"],
    loading: false,
  });
});

it(`A failed mute request leaves the Home feed and mute state unchanged (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) {
      return Promise.resolve(Response.json({ message: "Mute unavailable" }, { status: 500 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
  seedHomeFeed();
  await toggleMute("bob", false);
  const s = getStoreSnapshot();
  expect({
    feed: feedIds(),
    muted: s.mutedAccounts.map((a) => a.handle),
    error: s.errorMessage,
  }).toEqual({
    feed: ["bob-post", "erin-post"],
    muted: [],
    error: "Mute unavailable",
  });
});
