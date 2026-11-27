// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { loadFollowList } from "../src/web/store-world.ts";
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
});
