// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadFeed, loadMoreFeed, toggleMute } from "../src/web/store-world.ts";
import { aliceViewer, bobPostRaw, decodedPost, erinPostRaw, postRaw, resetModerationStore } from "./moderation-fixtures.ts";

const bobOlderRaw = postRaw({
  id: "bob-older-post",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob older call",
  createdAt: Date.now() - 3_600_000,
});

const feedIds = () => getStoreSnapshot().feedPosts.map((p) => p.card.id);

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ feedNextCursor: null, feedLoading: false, feedLoadingMore: false, errorMessage: null, mutedAccounts: [] });
});

it('Muting an author keeps their posts out of the Home feed when an in-flight load-more page lands after the mute (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  let releasePage: () => void = () => {};
  const pageGate = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(Response.json({ muted: true }));
    if (url.startsWith("/api/feed")) {
      return pageGate.then(() => Response.json({ items: [bobOlderRaw], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [bobPostRaw, erinPostRaw].map(decodedPost),
    feedNextCursor: "cursor-1",
    feedLoading: false,
    feedLoadingMore: false,
    mutedAccounts: [],
  });

  const loadingMore = loadMoreFeed();
  await toggleMute("bob", false);
  expect(feedIds()).toEqual(["erin-post"]);
  releasePage();
  await loadingMore;

  const s = getStoreSnapshot();
  expect({
    feed: feedIds(),
    loadingMore: s.feedLoadingMore,
  }).toEqual({
    feed: ["erin-post"],
    loadingMore: false,
  });
});

it('Muting an author keeps their posts out of the Home feed when an in-flight feed reload lands after the mute (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  let releaseFeed: () => void = () => {};
  const feedGate = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(Response.json({ muted: true }));
    if (url.startsWith("/api/feed")) {
      return feedGate.then(() => Response.json({ items: [bobPostRaw, erinPostRaw], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [bobPostRaw, erinPostRaw].map(decodedPost),
    mutedAccounts: [],
  });

  const reloading = loadFeed();
  await toggleMute("bob", false);
  expect(feedIds()).toEqual(["erin-post"]);
  releaseFeed();
  await reloading;

  const s = getStoreSnapshot();
  expect({
    feed: feedIds(),
    loading: s.feedLoading,
  }).toEqual({
    feed: ["erin-post"],
    loading: false,
  });
});

it('A failed mute request leaves the Home feed and mute state unchanged (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.includes("/api/users/bob/mute")) {
      return Promise.resolve(Response.json({ message: "Mute unavailable" }, { status: 500 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [bobPostRaw, erinPostRaw].map(decodedPost),
    mutedAccounts: [],
    errorMessage: null,
  });

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
