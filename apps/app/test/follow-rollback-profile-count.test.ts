// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile, toggleFollow } from "../src/web/store-world.ts";
import { aliceViewer, makeProfileBundle, resetModerationStore, stubFetchUrl } from "./moderation-fixtures.ts";

const bobBundle = () => makeProfileBundle("bob", "Bob Trader", 6, 4, false);
const aliceBundle = () => makeProfileBundle("alice", "Alice Player", 2, 4, true);

function openProfile(profileBundle: ReturnType<typeof makeProfileBundle>, profileHandle: string) {
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

function profileResponse(handle: string, displayName: string, followersCount: number, followingCount: number, viewerFollows: boolean) {
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
  await vi.waitFor(() => {
    const current = getStoreSnapshot().profileBundle;
    expect(current?.summary.isFollowing).toBe(true);
    expect(current?.summary.followersCount).toBe(7);
  });
});
