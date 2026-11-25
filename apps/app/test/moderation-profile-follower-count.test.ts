// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleBlock } from "../src/web/store-world.ts";

function openBobProfile(isFollowing: boolean, viewerFollowedBy: boolean): void {
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
        isFollowing,
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
      viewerFollowedBy,
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

it('Blocking a profile updates both follow counts without a reload (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const cases = [
    { isFollowing: true, viewerFollowedBy: true, succeeds: true },
    { isFollowing: true, viewerFollowedBy: false, succeeds: true },
    { isFollowing: false, viewerFollowedBy: true, succeeds: true },
    { isFollowing: false, viewerFollowedBy: false, succeeds: true },
    { isFollowing: true, viewerFollowedBy: true, succeeds: false },
  ];
  const results = [];
  for (const testCase of cases) {
    openBobProfile(testCase.isFollowing, testCase.viewerFollowedBy);
    vi.stubGlobal("fetch", () => Promise.resolve(testCase.succeeds
      ? Response.json({ blocked: true })
      : Response.json({ message: "Block failed" }, { status: 500 })));
    await toggleBlock("bob", false);
    const bundle = getStoreSnapshot().profileBundle;
    results.push({
      followersCount: bundle?.summary.followersCount,
      followingCount: bundle?.summary.followingCount,
      isFollowing: bundle?.summary.isFollowing,
      isBlocked: bundle?.summary.isBlocked,
      viewerFollowedBy: bundle?.viewerFollowedBy,
    });
    vi.unstubAllGlobals();
  }
  expect(results).toEqual([
    { followersCount: 5, followingCount: 3, isFollowing: false, isBlocked: true, viewerFollowedBy: false },
    { followersCount: 5, followingCount: 4, isFollowing: false, isBlocked: true, viewerFollowedBy: false },
    { followersCount: 6, followingCount: 3, isFollowing: false, isBlocked: true, viewerFollowedBy: false },
    { followersCount: 6, followingCount: 4, isFollowing: false, isBlocked: true, viewerFollowedBy: false },
    { followersCount: 6, followingCount: 4, isFollowing: true, isBlocked: false, viewerFollowedBy: true },
  ]);
});
