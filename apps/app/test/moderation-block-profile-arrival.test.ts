// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile, toggleBlock } from "../src/web/store-world.ts";
import { makeRawProfileBundle } from "./app-test-helpers.tsx";
import {
  aliceViewer,
  bobPostRaw,
  decodedPost,
  jsonPayload,
  makeProfileBundle,
  postRaw,
  resetModerationStore,
  stubFetchUrl,
} from "./moderation-fixtures.ts";

const createdAt = Date.now() - 60_000;

const bobSecondRaw = postRaw({
  id: "bob-post-2",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob second call",
});

function seedBobProfile(): void {
  setStoreState({
    viewer: aliceViewer,
    route: "Profile",
    feedTab: "latest",
    profileHandle: "bob",
    profileBundle: {
      ...makeProfileBundle("bob", "Bob Trader", 0, 0, false),
      postsCount: 2,
      posts: [decodedPost(bobPostRaw), decodedPost(bobSecondRaw)],
      postsNextCursor: "cursor-1",
    },
    profileReplies: [],
    profileLikes: [],
    blockedAccounts: [],
    errorMessage: null,
  });
}

function staleBobBundle(): Record<string, unknown> {
  return {
    ...makeRawProfileBundle({
      handle: "bob",
      displayName: "Bob Trader",
      createdAt,
      postsCount: 2,
      posts: [bobPostRaw, bobSecondRaw],
    }),
    nextCursor: "cursor-1",
  };
}

function arrivalState() {
  const bundle = getStoreSnapshot().profileBundle;
  return {
    postIds: bundle?.posts.map((p) => p.card.id),
    postsCount: bundle?.postsCount,
    postsNextCursor: bundle?.postsNextCursor,
    isBlocked: bundle?.summary.isBlocked,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ profileLoading: false, errorMessage: null, blockedAccounts: [] });
});

it('Blocking a profile owner clears the post count and load-more cursor on the arrival profile (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  seedBobProfile();
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/block")) return Promise.resolve(jsonPayload({ blocked: true }));
    if (url.startsWith("/api/notifications")) return Promise.resolve(jsonPayload({ items: [], unreadCount: 0 }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  await toggleBlock("bob", false);
  expect(arrivalState()).toEqual({ postIds: [], postsCount: 0, postsNextCursor: null, isBlocked: true });
});

it('Blocking a profile owner keeps the blocked arrival state when a profile load started before the block lands after it (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  seedBobProfile();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetchUrl(async (url) => {
    if (url.includes("/api/users/bob/block")) return jsonPayload({ blocked: true });
    if (url.includes("/api/users/bob")) {
      await gate;
      return jsonPayload(staleBobBundle());
    }
    if (url.startsWith("/api/notifications")) return jsonPayload({ items: [], unreadCount: 0 });
    return jsonPayload({}, 404);
  });
  const inFlight = loadProfile("bob");
  await toggleBlock("bob", false);
  release();
  await inFlight;
  expect(arrivalState()).toEqual({ postIds: [], postsCount: 0, postsNextCursor: null, isBlocked: true });
});

it('A failed block request keeps the original profile posts, count, and cursor (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  seedBobProfile();
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/block")) return Promise.resolve(jsonPayload({ message: "Block failed" }, 500));
    return Promise.resolve(jsonPayload({}, 404));
  });
  await toggleBlock("bob", false);
  expect(arrivalState()).toEqual({
    postIds: ["bob-post", "bob-post-2"],
    postsCount: 2,
    postsNextCursor: "cursor-1",
    isBlocked: false,
  });
});
