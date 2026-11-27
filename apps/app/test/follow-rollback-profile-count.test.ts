// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleFollow } from "../src/web/store-world.ts";

function viewerAlice() {
  return {
    accountId: "alice",
    handle: "alice",
    displayName: "Alice Player",
    bio: "",
    avatarUrl: null,
    bannerUrl: null,
    phoneLast2: null,
    phoneVerifiedAt: null,
    emailMasked: null,
    emailVerifiedAt: null,
    uiMode: "game" as const,
    balanceCents: 10_000,
    startingGrantCents: 10_000,
    isAdmin: false,
    isReviewer: false,
    agentGrant: null,
  };
}

function bobBundle() {
  return {
    summary: {
      displayName: "Bob Trader",
      handle: "bob",
      followersCount: 6,
      followingCount: 4,
      isFollowing: false,
      isMuted: false,
      isBlocked: false,
      isOwnProfile: false,
    },
    id: "bob",
    kind: "user" as const,
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
  };
}

function aliceBundle() {
  return {
    summary: {
      displayName: "Alice Player",
      handle: "alice",
      followersCount: 2,
      followingCount: 4,
      isFollowing: false,
      isMuted: false,
      isBlocked: false,
      isOwnProfile: true,
    },
    id: "alice",
    kind: "user" as const,
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
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, profileBundle: null, profileHandle: null, route: "Home" });
});

it('A failed follow rolled back after navigating to the own profile leaves the own Following count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  setStoreState({ viewer: viewerAlice(), profileBundle: bobBundle(), profileHandle: "bob", route: "Profile" });
  let resolveFetch: (res: Response) => void = () => undefined;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveFetch = resolve; }));

  const pending = toggleFollow("bob", false);
  const optimistic = getStoreSnapshot().profileBundle;
  expect(optimistic?.summary.isFollowing).toBe(true);
  expect(optimistic?.summary.followersCount).toBe(7);

  setStoreState({ profileBundle: aliceBundle(), profileHandle: "alice" });
  resolveFetch(Response.json({ message: "Follow failed" }, { status: 500 }));
  await pending;

  const bundle = getStoreSnapshot().profileBundle;
  expect(bundle?.summary.handle).toBe("alice");
  expect(bundle?.summary.followingCount).toBe(4);
  expect(bundle?.summary.followersCount).toBe(2);
});

it('A failed follow rolled back after the same profile reloads leaves the follower count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  setStoreState({ viewer: viewerAlice(), profileBundle: bobBundle(), profileHandle: "bob", route: "Profile" });
  let resolveFetch: (res: Response) => void = () => undefined;
  vi.stubGlobal("fetch", () => new Promise<Response>((resolve) => { resolveFetch = resolve; }));

  const pending = toggleFollow("bob", false);
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);

  setStoreState({ profileBundle: bobBundle(), profileHandle: "bob" });
  resolveFetch(Response.json({ message: "Follow failed" }, { status: 500 }));
  await pending;

  const bundle = getStoreSnapshot().profileBundle;
  expect(bundle?.summary.isFollowing).toBe(false);
  expect(bundle?.summary.followersCount).toBe(6);
});

it('A follow that succeeds after navigating to the own profile resyncs the own Following count (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  setStoreState({ viewer: viewerAlice(), profileBundle: bobBundle(), profileHandle: "bob", route: "Profile" });
  let resolveFollow: (res: Response) => void = () => undefined;
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/follow")) {
      return new Promise<Response>((resolve) => { resolveFollow = resolve; });
    }
    return Promise.resolve(Response.json({
      profile: {
        id: "alice",
        handle: "alice",
        displayName: "Alice Player",
        kind: "user",
        followersCount: 2,
        followingCount: 5,
        postsCount: 0,
        viewerFollows: false,
        viewerFollowedBy: false,
        viewerBlocks: false,
        viewerMutes: false,
      },
      posts: [],
      positions: [],
    }));
  });

  const pending = toggleFollow("bob", false);
  setStoreState({ profileBundle: aliceBundle(), profileHandle: "alice" });
  resolveFollow(Response.json({ following: true }));
  await pending;
  await vi.waitFor(() => {
    expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);
  });
});
