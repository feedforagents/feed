// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleBlock } from "../src/web/store-world.ts";

function openBobProfile(): void {
  setStoreState({
    viewer: {
      accountId: "alice",
      handle: "alice",
      displayName: "Alice Player",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      phoneLast2: null,
      uiMode: "game",
      balanceCents: 10_000,
      startingGrantCents: 10_000,
      isAdmin: false,
      isReviewer: false,
      agentGrant: null,
    },
    profileBundle: {
      summary: {
        displayName: "Bob Trader",
        handle: "bob",
        followersCount: 6,
        followingCount: 4,
        isFollowing: true,
        isMuted: false,
        isBlocked: false,
        isOwnProfile: false,
      },
      id: "bob",
      kind: "user",
      postsCount: 0,
      createdAtMs: 0,
      actorMeta: null,
      orgMeta: null,
      viewerFollowedBy: false,
      viewerBlockedBy: false,
      tradeCount: null,
      openPositionCount: null,
      posts: [],
      postsNextCursor: null,
      positions: [],
    },
    blockedAccounts: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, profileBundle: null, blockedAccounts: [] });
});

it('Blocking a followed profile updates its follower count without a reload (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  openBobProfile();
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ blocked: true })));

  await toggleBlock("bob", false);

  const summary = getStoreSnapshot().profileBundle?.summary;
  expect({
    followersCount: summary?.followersCount,
    isFollowing: summary?.isFollowing,
    isBlocked: summary?.isBlocked,
  }).toEqual({ followersCount: 5, isFollowing: false, isBlocked: true });
});

it('Blocking a profile the viewer does not follow leaves its follower count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  openBobProfile();
  const bundle = getStoreSnapshot().profileBundle;
  if (!bundle) throw new Error("profile missing");
  setStoreState({ profileBundle: { ...bundle, summary: { ...bundle.summary, isFollowing: false } } });
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ blocked: true })));

  await toggleBlock("bob", false);

  const summary = getStoreSnapshot().profileBundle?.summary;
  expect({
    followersCount: summary?.followersCount,
    isFollowing: summary?.isFollowing,
    isBlocked: summary?.isBlocked,
  }).toEqual({ followersCount: 6, isFollowing: false, isBlocked: true });
});

it('A failed block leaves the followed profile follower count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  openBobProfile();
  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ message: "Block failed" }, { status: 500 })));

  await toggleBlock("bob", false);

  const summary = getStoreSnapshot().profileBundle?.summary;
  expect({
    followersCount: summary?.followersCount,
    isFollowing: summary?.isFollowing,
    isBlocked: summary?.isBlocked,
  }).toEqual({ followersCount: 6, isFollowing: true, isBlocked: false });
});
