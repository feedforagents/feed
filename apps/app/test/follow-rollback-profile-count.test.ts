// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile, toggleFollow } from "../src/web/store-world.ts";
import type { AppProfileBundle } from "../src/web/types.ts";
import { aliceViewer, bobPostRaw, makeProfileBundle, resetModerationStore, stubFetchUrl } from "./moderation-fixtures.ts";

const bobBundle = () => makeProfileBundle("bob", "Bob Trader", 6, 4, false);
const aliceBundle = () => makeProfileBundle("alice", "Alice Player", 2, 4, true);

function openProfile(profileBundle: AppProfileBundle, profileHandle: string) {
  setStoreState({ viewer: aliceViewer, profileBundle, profileHandle, route: "Profile" });
}

function pendingResponse() {
  let resolve: (res: Response) => void = () => undefined;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  return { promise, resolve: (res: Response) => resolve(res) };
}

function beginFollow(profileBundle = bobBundle(), profileHandle = "bob") {
  openProfile(profileBundle, profileHandle);
  const follow = pendingResponse();
  stubFetchUrl(() => follow.promise);
  return { follow, pending: toggleFollow("bob", false) };
}

function beginFollowWithProfileResponse(response: Response) {
  openProfile(bobBundle(), "bob");
  const follow = pendingResponse();
  stubFetchUrl((url) => url.includes("/follow") ? follow.promise : Promise.resolve(response));
  return { follow, pending: toggleFollow("bob", false) };
}

async function failFollow(follow: ReturnType<typeof pendingResponse>, pending: ReturnType<typeof toggleFollow>): Promise<void> {
  follow.resolve(Response.json({ message: "Follow failed" }, { status: 500 }));
  await pending;
}

function expectBobRolledBack(): void {
  const current = getStoreSnapshot().profileBundle;
  expect(current?.summary.isFollowing).toBe(false);
  expect(current?.summary.followersCount).toBe(6);
}

async function expectProfileFollowing(followersCount: number): Promise<void> {
  await vi.waitFor(() => {
    const current = getStoreSnapshot().profileBundle;
    expect(current?.summary.isFollowing).toBe(true);
    expect(current?.summary.followersCount).toBe(followersCount);
  });
}

function profileResponse(handle: string, displayName: string, followersCount: number, followingCount: number, viewerFollows: boolean, posts: unknown[] = []) {
  return Response.json({
    profile: {
      id: handle,
      handle,
      displayName,
      kind: "user",
      followersCount,
      followingCount,
      postsCount: 0,
      viewerFollows,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerMutes: false,
    },
    posts,
    positions: [],
  });
}

function orgProfileResponse(followersCount: number, viewerFollows: boolean) {
  return Response.json({
    profile: {
      id: "airk-invest",
      handle: "airk",
      displayName: "Airk",
      kind: "organization",
      orgMeta: { ticker: "AIRK", orgType: "organization" },
      followersCount,
      followingCount: 0,
      postsCount: 0,
      viewerFollows,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerMutes: false,
    },
    posts: [],
    positions: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
});

it('A failed follow rolled back after navigating to the own profile leaves the own Following count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollow();
  const optimistic = getStoreSnapshot().profileBundle;
  expect(optimistic?.summary.isFollowing).toBe(true);
  expect(optimistic?.summary.followersCount).toBe(7);

  setStoreState({ profileBundle: aliceBundle(), profileHandle: "alice" });
  await failFollow(follow, pending);

  const current = getStoreSnapshot().profileBundle;
  expect(current?.summary.handle).toBe("alice");
  expect(current?.summary.followingCount).toBe(4);
  expect(current?.summary.followersCount).toBe(2);
});

it('A failed follow rolled back after the same profile reloads leaves the follower count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollow();
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);

  setStoreState({ profileBundle: bobBundle(), profileHandle: "bob" });
  await failFollow(follow, pending);

  expectBobRolledBack();
});

it('A follow that succeeds after navigating to the own profile resyncs the own Following count (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollowWithProfileResponse(profileResponse("alice", "Alice Player", 2, 5, false));
  setStoreState({ profileBundle: aliceBundle(), profileHandle: "alice" });
  follow.resolve(Response.json({ following: true }));
  await pending;
  await vi.waitFor(() => {
    expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);
  });
});

it('A failed follow with no navigation rolls the follower count and follow state back (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollow();
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);

  await failFollow(follow, pending);

  expectBobRolledBack();
});

it('A failed follow from the own profile rolls the own Following count back (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollow(aliceBundle(), "alice");
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);

  await failFollow(follow, pending);

  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(4);
});

it('A failed follow rolled back after the own profile reloads leaves the own Following count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  openProfile(aliceBundle(), "alice");
  const follow = pendingResponse();
  stubFetchUrl((url) => url.includes("/follow") ? follow.promise : Promise.resolve(profileResponse("alice", "Alice Player", 2, 4, false)));
  const pending = toggleFollow("bob", false);
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);

  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(4);
  await failFollow(follow, pending);

  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(4);
  expect(getStoreSnapshot().errorMessage).toBe("Follow failed");
});

it('A failed unfollow rolled back after the own profile reloads leaves the own Following count unchanged (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const alice = makeProfileBundle("alice", "Alice Player", 2, 5, true);
  openProfile(alice, "alice");
  const follow = pendingResponse();
  stubFetchUrl((url) => url.includes("/follow") ? follow.promise : Promise.resolve(profileResponse("alice", "Alice Player", 2, 5, false)));
  const pending = toggleFollow("bob", true);
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(4);

  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);
  await failFollow(follow, pending);

  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);
});

it('A failed unfollow with no navigation rolls the follower count and follow state back (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const bob = makeProfileBundle("bob", "Bob Trader", 7, 4, false);
  openProfile({ ...bob, summary: { ...bob.summary, isFollowing: true } }, "bob");
  const follow = pendingResponse();
  stubFetchUrl(() => follow.promise);
  const pending = toggleFollow("bob", true);
  expect(getStoreSnapshot().profileBundle?.summary.isFollowing).toBe(false);
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(6);

  await failFollow(follow, pending);

  expect(getStoreSnapshot().profileBundle?.summary.isFollowing).toBe(true);
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);
  expect(getStoreSnapshot().errorMessage).toBe("Follow failed");
});

it('A follow that succeeds after the same profile refreshes resyncs the follower count (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, pending } = beginFollowWithProfileResponse(profileResponse("bob", "Bob Trader", 7, 4, true));
  setStoreState({ profileBundle: bobBundle(), profileHandle: "bob" });
  follow.resolve(Response.json({ following: true }));
  await pending;
  await expectProfileFollowing(7);
});

function bobFollowingBundle() {
  const bundle = makeProfileBundle("bob", "Bob Trader", 7, 4, false);
  return { ...bundle, summary: { ...bundle.summary, isFollowing: true } };
}

function beginRefreshRace(profileBundle: AppProfileBundle, profileHandle: string, currentlyFollowing: boolean, freshProfile: Response, followHandle = "bob") {
  openProfile(profileBundle, profileHandle);
  const follow = pendingResponse();
  const staleProfile = pendingResponse();
  let profileGets = 0;
  stubFetchUrl((url) => {
    if (url.includes("/follow")) return follow.promise;
    profileGets += 1;
    return profileGets === 1 ? staleProfile.promise : Promise.resolve(freshProfile);
  });
  const refresh = loadProfile(profileHandle);
  const pending = toggleFollow(followHandle, currentlyFollowing);
  return { follow, staleProfile, refresh, pending };
}

it('A follow that commits while a profile refresh is in flight keeps the Following state and follower count when the stale refresh lands (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, staleProfile, refresh, pending } = beginRefreshRace(bobBundle(), "bob", false, profileResponse("bob", "Bob Trader", 7, 4, true));
  expect(getStoreSnapshot().profileBundle?.summary.isFollowing).toBe(true);
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);

  follow.resolve(Response.json({ following: true }));
  await pending;

  staleProfile.resolve(profileResponse("bob", "Bob Trader", 6, 4, false, [bobPostRaw]));
  await refresh;
  await expectProfileFollowing(7);
  expect(getStoreSnapshot().profileBundle?.posts[0]?.card.isFollowingAuthor).toBe(true);
});

it('An unfollow that commits while a profile refresh is in flight keeps the Follow state and follower count when the stale refresh lands (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, staleProfile, refresh, pending } = beginRefreshRace(bobFollowingBundle(), "bob", true, profileResponse("bob", "Bob Trader", 6, 4, false));
  expect(getStoreSnapshot().profileBundle?.summary.isFollowing).toBe(false);
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(6);

  follow.resolve(Response.json({ following: false }));
  await pending;

  staleProfile.resolve(profileResponse("bob", "Bob Trader", 7, 4, true));
  await refresh;
  await vi.waitFor(() => {
    const current = getStoreSnapshot().profileBundle;
    expect(current?.summary.isFollowing).toBe(false);
    expect(current?.summary.followersCount).toBe(6);
  });
});

it('A follow from the own profile that commits while an own-profile refresh is in flight keeps the Following count when the stale refresh lands (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, staleProfile, refresh, pending } = beginRefreshRace(aliceBundle(), "alice", false, profileResponse("alice", "Alice Player", 2, 5, false));
  expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);

  follow.resolve(Response.json({ following: true }));
  await pending;

  staleProfile.resolve(profileResponse("alice", "Alice Player", 2, 4, false));
  await refresh;
  await vi.waitFor(() => {
    expect(getStoreSnapshot().profileBundle?.summary.followingCount).toBe(5);
  });
});

it('A failed follow while a profile refresh is in flight still rolls back when the refresh lands (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { follow, staleProfile, refresh, pending } = beginRefreshRace(bobBundle(), "bob", false, profileResponse("bob", "Bob Trader", 6, 4, false));
  expect(getStoreSnapshot().profileBundle?.summary.followersCount).toBe(7);

  await failFollow(follow, pending);

  staleProfile.resolve(profileResponse("bob", "Bob Trader", 6, 4, false));
  await refresh;

  expectBobRolledBack();
});

it('A follow that commits while an organization profile opened by id refreshes keeps the Following state when the stale refresh lands (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const orgBundle: AppProfileBundle = {
    ...makeProfileBundle("airk", "Airk", 6, 0, false),
    id: "airk-invest",
    kind: "organization",
    orgMeta: { ticker: "AIRK", orgType: "organization" },
  };
  const { follow, staleProfile, refresh, pending } = beginRefreshRace(orgBundle, "airk-invest", false, orgProfileResponse(7, true), "airk");
  expect(getStoreSnapshot().profileBundle?.summary.isFollowing).toBe(true);

  follow.resolve(Response.json({ following: true }));
  await pending;

  staleProfile.resolve(orgProfileResponse(6, false));
  await refresh;
  await expectProfileFollowing(7);
});
