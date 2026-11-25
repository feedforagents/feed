// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { deletePost, loadProfile, removePostAcrossStore } from "../src/web/store-world.ts";

const createdAt = Date.now() - 60_000;

function rawPost(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "post-x",
    authorId: "alice",
    authorKind: "user",
    authorHandle: "alice",
    authorDisplayName: "Alice Player",
    content: "Alice market note",
    replyToPostId: null,
    quotePostId: null,
    quotePost: null,
    repostedByHandle: null,
    repostedByName: null,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt,
    ...overrides,
  };
}

const firstRaw = rawPost({ id: "alice-post-1", content: "Alice first call" });
const secondRaw = rawPost({ id: "alice-post-2", content: "Alice second call" });

function profileRaw(postsCount: number, posts: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return {
    profile: {
      id: "alice",
      kind: "user",
      handle: "alice",
      displayName: "Alice Player",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt,
      followersCount: 0,
      followingCount: 0,
      postsCount,
      viewerFollows: false,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerBlockedBy: false,
      viewerMutes: false,
      isParody: false,
    },
    posts,
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    viewer: null,
    route: "Home",
    feedPosts: [],
    profileBundle: null,
    profileHandle: null,
    profileReplies: [],
  });
});

it('Deleting an own post from the profile drops the header post count with the list (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/posts/alice-post-1") && method === "DELETE") {
      return Promise.resolve(Response.json({ postId: "alice-post-1", deleted: true, replyToPostId: null, parentReplyCount: null }));
    }
    if (url.startsWith("/api/users/alice")) {
      return Promise.resolve(Response.json(profileRaw(2, [firstRaw, secondRaw])));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: {
      accountId: "alice",
      handle: "alice",
      displayName: "Alice Player",
      bio: "",
      avatarUrl: null,
      phoneLast2: null,
      uiMode: "game",
      balanceCents: 0,
      startingGrantCents: 0,
      purchasedCents: 0,
      isAdmin: false,
      isReviewer: false,
      agentGrant: null,
    },
    route: "Profile",
    profileHandle: "alice",
  });
  await loadProfile("alice");
  const before = getStoreSnapshot().profileBundle;
  expect(before?.postsCount).toBe(2);
  expect(before?.posts.map((p) => p.card.id)).toEqual(["alice-post-1", "alice-post-2"]);

  await deletePost("alice-post-1");

  const afterDelete = getStoreSnapshot().profileBundle;
  expect(afterDelete?.posts.map((p) => p.card.id)).toEqual(["alice-post-2"]);
  expect(afterDelete?.postsCount).toBe(1);

  removePostAcrossStore("alice-post-1", { replyToPostId: null, parentReplyCount: null });
  const afterDuplicateSignal = getStoreSnapshot().profileBundle;
  expect(afterDuplicateSignal?.posts.map((p) => p.card.id)).toEqual(["alice-post-2"]);
  expect(afterDuplicateSignal?.postsCount).toBe(1);
});

it('Removing another author\'s reposted post from the profile list leaves the header post count unchanged (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const carolRaw = rawPost({
    id: "carol-post-1",
    authorId: "carol",
    authorHandle: "carol",
    authorDisplayName: "Carol Analyst",
    content: "Carol market note",
    repostedByHandle: "alice",
    repostedByName: "Alice Player",
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.startsWith("/api/users/alice")) {
      return Promise.resolve(Response.json(profileRaw(1, [carolRaw])));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: {
      accountId: "alice",
      handle: "alice",
      displayName: "Alice Player",
      bio: "",
      avatarUrl: null,
      phoneLast2: null,
      uiMode: "game",
      balanceCents: 0,
      startingGrantCents: 0,
      purchasedCents: 0,
      isAdmin: false,
      isReviewer: false,
      agentGrant: null,
    },
    route: "Profile",
    profileHandle: "alice",
  });
  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(1);

  removePostAcrossStore("carol-post-1", { replyToPostId: null, parentReplyCount: null });

  const after = getStoreSnapshot().profileBundle;
  expect(after?.posts).toHaveLength(0);
  expect(after?.postsCount).toBe(1);
});
