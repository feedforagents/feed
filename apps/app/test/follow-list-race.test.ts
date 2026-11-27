// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { closeFollowList, loadFollowList } from "../src/web/store-world.ts";
import { navigate } from "../src/web/store.ts";
import { aliceViewer } from "./moderation-fixtures.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

const followingRows = {
  items: [
    { id: "bob", kind: "user", handle: "bob", displayName: "Bob Trader", bio: "", avatarUrl: null, viewerFollows: true, isParody: false },
    { id: "carol", kind: "user", handle: "carol", displayName: "Carol Analyst", bio: "", avatarUrl: null, viewerFollows: true, isParody: false },
  ],
};

const followersRows = {
  items: [
    { id: "dave", kind: "user", handle: "dave", displayName: "Dave Viewer", bio: "", avatarUrl: null, viewerFollows: false, isParody: false },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    followListKind: null,
    followListHandle: null,
    followListItems: [],
    followListLoading: false,
    errorMessage: null,
    toasts: [],
  });
});

describe("follow-list race", () => {
  it('slow Following response must not overwrite a newer Followers dialog (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    const pending = installDeferredFetch();
    const first = loadFollowList("alice", "following");
    const second = loadFollowList("alice", "followers");
    pending.get("GET /api/users/alice/followers")?.resolve(jsonResponse(followersRows));
    await second;
    expect(getStoreSnapshot().followListKind).toBe("followers");
    expect(getStoreSnapshot().followListItems.map((entry) => entry.handle)).toEqual(["dave"]);
    pending.get("GET /api/users/alice/following")?.resolve(jsonResponse(followingRows));
    await first;
    expect(getStoreSnapshot().followListKind).toBe("followers");
    expect(getStoreSnapshot().followListItems.map((entry) => entry.handle)).toEqual(["dave"]);
  });

  it('slow Followers response must not overwrite a newer Following dialog (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    const pending = installDeferredFetch();
    const first = loadFollowList("alice", "followers");
    const second = loadFollowList("alice", "following");
    pending.get("GET /api/users/alice/following")?.resolve(jsonResponse(followingRows));
    await second;
    expect(getStoreSnapshot().followListKind).toBe("following");
    expect(getStoreSnapshot().followListItems.map((entry) => entry.handle)).toEqual(["bob", "carol"]);
    pending.get("GET /api/users/alice/followers")?.resolve(jsonResponse(followersRows));
    await first;
    expect(getStoreSnapshot().followListKind).toBe("following");
    expect(getStoreSnapshot().followListItems.map((entry) => entry.handle)).toEqual(["bob", "carol"]);
  });

  it('a follow list load that fails after the dialog closes stays silent (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    const pending = installDeferredFetch();
    const load = loadFollowList("alice", "followers");
    closeFollowList();
    pending.get("GET /api/users/alice/followers")?.resolve(
      Response.json({ message: "Follow list unavailable due to a block" }, { status: 403 }),
    );
    await load;
    const after = getStoreSnapshot();
    expect(after.followListKind).toBeNull();
    expect(after.followListLoading).toBe(false);
    expect(after.followListItems).toEqual([]);
    expect(after.errorMessage).toBeNull();
    expect(after.toasts.some((t) => t.tone === "destructive")).toBe(false);
  });

  it('a follow list load that succeeds after the dialog closes does not repopulate it (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    const pending = installDeferredFetch();
    const load = loadFollowList("alice", "followers");
    closeFollowList();
    pending.get("GET /api/users/alice/followers")?.resolve(jsonResponse(followersRows));
    await load;
    const after = getStoreSnapshot();
    expect(after.followListKind).toBeNull();
    expect(after.followListHandle).toBeNull();
    expect(after.followListLoading).toBe(false);
    expect(after.followListItems).toEqual([]);
  });

  it('navigating to another profile closes the previous profile follow list (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    const pending = installDeferredFetch();
    setStoreState({
      viewer: aliceViewer,
      route: "Profile",
      profileHandle: "bob",
      followListKind: "followers",
      followListHandle: "bob",
      followListItems: [
        { id: "dave", kind: "user", handle: "dave", displayName: "Dave Viewer", bio: "", avatarUrl: null, viewerFollows: false, isParody: false },
      ],
      followListLoading: false,
    });
    const nav = navigate("/u/carol");
    pending.get("GET /api/users/carol")?.resolve(jsonResponse({
      profile: {
        id: "carol",
        handle: "carol",
        displayName: "Carol Analyst",
        kind: "user",
        followersCount: 1,
        followingCount: 1,
        postsCount: 0,
        viewerFollows: false,
        viewerFollowedBy: false,
        viewerBlocks: false,
        viewerMutes: false,
      },
      posts: [],
      positions: [],
    }));
    await nav;
    const after = getStoreSnapshot();
    expect(after.profileHandle).toBe("carol");
    expect(after.followListKind).toBeNull();
    expect(after.followListHandle).toBeNull();
    expect(after.followListItems).toEqual([]);
  });
});
