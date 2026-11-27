// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { updateOwnProfile } from "../src/web/store-world.ts";
import type { AppPost, AppProfileBundle } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

function ownPost(id: string, displayName: string, replyToPostId: string | null): AppPost {
  return {
    card: {
      id,
      authorDisplayName: displayName,
      authorHandle: "alice",
      authorAvatarUrl: null,
      content: "hello",
      createdAtMs: 1,
      likeCount: 0,
      replyCount: 0,
      repostCount: 0,
      viewCount: 0,
      liked: false,
      reposted: false,
      isFollowingAuthor: false,
    } as AppPost["card"],
    authorId: "alice",
    authorKind: "user",
    replyToPostId,
    marketId: null,
    ticker: null,
    createdAtMs: 1,
  };
}

function ownBundle(displayName: string): AppProfileBundle {
  return {
    id: "alice",
    kind: "user",
    postsCount: 2,
    createdAtMs: 0,
    actorMeta: null,
    orgMeta: null,
    viewerFollowedBy: false,
    viewerBlockedBy: false,
    tradeCount: null,
    openPositionCount: null,
    posts: [ownPost("post-1", displayName, null), ownPost("reply-1", displayName, "post-0")],
    postsNextCursor: null,
    positions: [],
    summary: {
      displayName,
      handle: "alice",
      avatarUrl: null,
      followersCount: 0,
      followingCount: 0,
      isFollowing: false,
      isMuted: false,
      isBlocked: false,
      isOwnProfile: true,
    },
  } as AppProfileBundle;
}

function postPayload(id: string, displayName: string, replyToPostId: string | null) {
  return {
    id,
    authorId: "alice",
    authorHandle: "alice",
    authorDisplayName: displayName,
    authorAvatarUrl: null,
    content: "hello",
    createdAt: 1,
    replyToPostId,
  };
}

function profilePayload(displayName: string) {
  return {
    profile: {
      id: "alice",
      handle: "alice",
      displayName,
      avatarUrl: null,
      postsCount: 2,
      followersCount: 0,
      followingCount: 0,
    },
    posts: [postPayload("post-1", displayName, null), postPayload("reply-1", displayName, "post-0")],
    positions: [],
  };
}

function repliesPayload(displayName: string) {
  return { items: [postPayload("reply-1", displayName, "post-0")], nextCursor: null };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, "http://localhost");
      if (url.pathname === "/api/users/me" && init?.method === "PATCH")
        return Promise.resolve(Response.json({ displayName: "Alice Renamed", bio: "", avatarUrl: null, bannerUrl: null }));
      if (url.pathname === "/api/users/alice") return Promise.resolve(Response.json(profilePayload("Alice Renamed")));
      if (url.pathname === "/api/posts" && url.searchParams.get("filter") === "replies")
        return Promise.resolve(Response.json(repliesPayload("Alice Renamed")));
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  setStoreState({
    viewer: makeViewerSession({ displayName: "Alice Player" }),
    route: "Profile",
    profileHandle: "alice",
    profileBundle: ownBundle("Alice Player"),
    profileReplies: [ownPost("reply-1", "Alice Player", "post-0")],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("saving a new display name on the own profile refreshes the already-loaded replies list (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  const ok = await updateOwnProfile({ displayName: "Alice Renamed" });
  expect(ok).toBe(true);

  const afterSave = getStoreSnapshot();
  expect(afterSave.profileBundle?.summary.displayName).toBe("Alice Renamed");
  expect(afterSave.profileReplies[0]?.card.authorDisplayName).toBe("Alice Renamed");
});
