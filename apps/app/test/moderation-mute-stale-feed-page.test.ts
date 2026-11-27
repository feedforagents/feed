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

const bobBlockedEntry = {
  id: "bob",
  handle: "bob",
  displayName: "Bob Trader",
  avatarUrl: null,
  bio: "",
};

const feedIds = () => getStoreSnapshot().feedPosts.map((p) => p.card.id);

function stubFeedFetch(options: {
  readonly gatedItems: ReadonlyArray<Record<string, unknown>>;
  readonly reloadItems?: ReadonlyArray<Record<string, unknown>>;
  readonly muteStatus?: number;
}): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let feedCalls = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.includes("/api/users/bob/mute")) {
      return Promise.resolve(options.muteStatus === undefined
        ? Response.json({ muted: true })
        : Response.json({ message: "Mute unavailable" }, { status: options.muteStatus }));
    }
    if (url.startsWith("/api/feed")) {
      feedCalls += 1;
      if (feedCalls === 1) return gate.then(() => Response.json({ items: options.gatedItems, nextCursor: null }));
      return Promise.resolve(Response.json({ items: options.reloadItems ?? options.gatedItems, nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
  return release;
}

function seedHomeFeed(overrides: Parameters<typeof setStoreState>[0] = {}): void {
  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [bobPostRaw, erinPostRaw].map(decodedPost),
    mutedAccounts: [],
    ...overrides,
  });
}

async function loadMoreMuteUnmute(options: {
  readonly reloadItems: ReadonlyArray<Record<string, unknown>>;
  readonly blocked?: boolean;
}): Promise<void> {
  const releasePage = stubFeedFetch({ gatedItems: [bobOlderRaw], reloadItems: options.reloadItems });
  seedHomeFeed({
    feedNextCursor: "cursor-1",
    feedLoading: false,
    feedLoadingMore: false,
    ...(options.blocked ? { blockedAccounts: [bobBlockedEntry] } : {}),
  });
  const loadingMore = loadMoreFeed();
  await toggleMute("bob", false);
  await toggleMute("bob", true);
  releasePage();
  await loadingMore;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ feedNextCursor: null, feedLoading: false, feedLoadingMore: false, errorMessage: null, mutedAccounts: [] });
});

it('Muting an author keeps their posts out of the Home feed when an in-flight load-more page lands after the mute (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  const releasePage = stubFeedFetch({ gatedItems: [bobOlderRaw] });
  seedHomeFeed({ feedNextCursor: "cursor-1", feedLoading: false, feedLoadingMore: false });

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
  const releaseFeed = stubFeedFetch({ gatedItems: [bobPostRaw, erinPostRaw] });
  seedHomeFeed();

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
  stubFeedFetch({ gatedItems: [], muteStatus: 500 });
  seedHomeFeed({ errorMessage: null });

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

it('Unmuting an author during an in-flight load-more keeps their posts in the Home feed (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  await loadMoreMuteUnmute({ reloadItems: [bobPostRaw, erinPostRaw] });

  expect(feedIds()).toEqual(["bob-post", "erin-post"]);
});

it('Unmuting an author who is still blocked keeps their posts out of the Home feed (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  await loadMoreMuteUnmute({ reloadItems: [erinPostRaw], blocked: true });

  const s = getStoreSnapshot();
  expect({
    feed: feedIds(),
    blocked: s.blockedAccounts.map((a) => a.handle),
  }).toEqual({
    feed: ["erin-post"],
    blocked: ["bob"],
  });
});

it('Resetting the viewer session clears mute hides so a feed load started before the reset keeps the author\'s posts (spec/social/moderation.md, "Muting hides an author\'s feed content without removing follows")', async () => {
  const releaseFeed = stubFeedFetch({ gatedItems: [erinPostRaw, bobPostRaw] });
  seedHomeFeed({ feedLoading: false });

  const reloading = loadFeed();
  await toggleMute("bob", false);
  resetModerationStore();
  seedHomeFeed({ feedPosts: [] });
  expect(feedIds()).toEqual([]);
  releaseFeed();
  await reloading;

  expect(feedIds()).toEqual(["erin-post", "bob-post"]);
});
