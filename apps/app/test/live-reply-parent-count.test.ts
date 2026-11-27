// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { decodePost, decodeProfileBundle } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { postRaw } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();
const parentRaw = postRaw({
  id: "parent-post",
  authorId: "carol",
  authorHandle: "carol",
  authorDisplayName: "Carol Analyst",
  content: "Carol market note",
  replyCount: 1,
});
const otherRaw = postRaw({
  id: "other-post",
  authorId: "dave",
  authorHandle: "dave",
  authorDisplayName: "Dave",
  content: "Unrelated post",
  replyCount: 5,
});
const parentPost = decodePost(parentRaw);
const otherPost = decodePost(otherRaw);
if (parentPost === null || otherPost === null) {
  throw new Error("test fixture must decode");
}

const profileBundle = decodeProfileBundle(
  {
    profile: {
      id: "carol",
      kind: "user",
      handle: "carol",
      displayName: "Carol Analyst",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt: Date.now() - 60_000,
      followersCount: 0,
      followingCount: 0,
      postsCount: 1,
      viewerFollows: false,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerBlockedBy: false,
      viewerMutes: false,
      isParody: false,
    },
    posts: [parentRaw],
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  },
  viewer.accountId,
);
if (profileBundle === null) {
  throw new Error("profile fixture must decode");
}

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

function dispatchCreated(payload: Record<string, unknown>): void {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.created", {
      data: JSON.stringify({
        type: "post.created",
        postId: "reply-post",
        authorId: "bob",
        authorKind: "user",
        replyToPostId: "parent-post",
        quotePostId: null,
        createdAt: Date.now(),
        ...payload,
      }),
    }),
  );
}

function parentReplyCounts(): {
  home: number | undefined;
  other: number | undefined;
  explore: number | undefined;
  market: number | undefined;
  profile: number | undefined;
  thread: number | undefined;
} {
  const s = getStoreSnapshot();
  const id = "parent-post";
  return {
    home: s.feedPosts.find((p) => p.card.id === id)?.card.replyCount,
    other: s.feedPosts.find((p) => p.card.id === "other-post")?.card.replyCount,
    explore: s.explore.posts.find((p) => p.card.id === id)?.card.replyCount,
    market: s.marketSocialPosts.find((p) => p.card.id === id)?.card.replyCount,
    profile: s.profileBundle?.posts.find((p) => p.card.id === id)?.card.replyCount,
    thread: s.activeThread?.post.card.id === id ? s.activeThread.post.card.replyCount : undefined,
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}))));
  vi.stubGlobal("EventSource", StubEventSource);
  setStoreState({
    viewer,
    route: "Home",
    feedPosts: [parentPost, otherPost],
    explore: { trending: [], articles: [], posts: [parentPost], accounts: [], actors: [], organizations: [], tags: [] },
    profileBundle,
    profileReplies: [],
    profileLikes: [],
    marketSocialPosts: [parentPost],
    activeThread: {
      post: parentPost,
      parentPost: null,
      ancestors: [],
      replies: [],
    },
  });
  reconnectRealtime();
});

afterEach(() => {
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

it("sets the parent card reply count from a personalized post.created event (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", () => {
  expect(parentReplyCounts()).toEqual({
    home: 1,
    other: 5,
    explore: 1,
    market: 1,
    profile: 1,
    thread: 1,
  });
  dispatchCreated({ parentReplyCount: 2 });
  expect(parentReplyCounts()).toEqual({
    home: 2,
    other: 5,
    explore: 2,
    market: 2,
    profile: 2,
    thread: 2,
  });
  dispatchCreated({ parentReplyCount: 2 });
  expect(parentReplyCounts()).toEqual({
    home: 2,
    other: 5,
    explore: 2,
    market: 2,
    profile: 2,
    thread: 2,
  });
});

it("does not bump the parent count when post.created has no personalized parentReplyCount (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", () => {
  dispatchCreated({});
  expect(parentReplyCounts()).toEqual({
    home: 1,
    other: 5,
    explore: 1,
    market: 1,
    profile: 1,
    thread: 1,
  });
});

it("does not change a parent count for a top-level post.created event (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", () => {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.created", {
      data: JSON.stringify({
        type: "post.created",
        postId: "new-root",
        authorId: "bob",
        authorKind: "user",
        replyToPostId: null,
        quotePostId: null,
        createdAt: Date.now(),
        parentReplyCount: 99,
      }),
    }),
  );
  expect(parentReplyCounts()).toEqual({
    home: 1,
    other: 5,
    explore: 1,
    market: 1,
    profile: 1,
    thread: 1,
  });
});
