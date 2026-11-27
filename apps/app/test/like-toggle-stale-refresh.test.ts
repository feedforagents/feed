// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { loadFeed, openThread, toggleLike } from "../src/web/store-world.ts";
import { decodePost } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { postRaw } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();

function decoded(raw: Record<string, unknown>) {
  const post = decodePost(raw, "alice");
  if (post === null) throw new Error("test fixture must decode");
  return post;
}

const basePost = decoded(postRaw({ id: "post-1", likeCount: 5, likedByViewer: false }));

let releaseFeed: ((response: Response) => void) | null = null;
let releaseThread: ((response: Response) => void) | null = null;
let releaseLike: ((response: Response) => void) | null = null;
let gateLike = false;

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  releaseFeed = null;
  releaseThread = null;
  releaseLike = null;
  gateLike = false;
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/posts/post-1/like")) {
      if (gateLike) return new Promise<Response>((resolve) => { releaseLike = resolve; });
      return Promise.resolve(jsonResponse({ postId: "post-1", liked: true, likeCount: 6 }));
    }
    if (url.includes("/api/posts/post-1?")) {
      return new Promise<Response>((resolve) => { releaseThread = resolve; });
    }
    if (url.includes("/api/feed")) {
      return new Promise<Response>((resolve) => { releaseFeed = resolve; });
    }
    return Promise.resolve(jsonResponse({}));
  }));
  setStoreState({
    viewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [basePost],
    feedLoading: false,
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    marketSocialPosts: [],
    activeThread: null,
    activePostId: null,
  });
});

afterEach(() => {
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

it("keeps a completed like when an earlier feed refresh resolves with a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const refresh = loadFeed();
  await toggleLike("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
  releaseFeed?.(jsonResponse({ items: [postRaw({ id: "post-1", likeCount: 5, likedByViewer: false })], nextCursor: null }));
  await refresh;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
});

it("applies a feed refresh snapshot when no like intervened (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const refresh = loadFeed();
  releaseFeed?.(jsonResponse({ items: [postRaw({ id: "post-1", likeCount: 9, likedByViewer: false })], nextCursor: null }));
  await refresh;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(9);
});

it("keeps a completed like when an earlier thread refresh resolves with a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  setStoreState({
    route: "PostDetail",
    activePostId: "post-1",
    activeThread: { post: basePost, parentPost: null, ancestors: [], replies: [] },
  });
  const refresh = openThread("post-1");
  await toggleLike("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(true);
  releaseThread?.(jsonResponse({
    post: postRaw({ id: "post-1", likeCount: 5, likedByViewer: false }),
    parentPost: null,
    ancestors: [],
    replies: [],
  }));
  await refresh;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(true);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(6);
});

it("keeps a live engagement count that landed while the like request was in flight (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  gateLike = true;
  reconnectRealtime();
  const toggle = toggleLike("post-1");
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "like", likeCount: 7, repostCount: 0 }),
    }),
  );
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
  releaseLike?.(jsonResponse({ postId: "post-1", liked: true, likeCount: 6 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
});

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

it("keeps a live engagement count that landed while the like request was in flight when the like then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  gateLike = true;
  reconnectRealtime();
  const toggle = toggleLike("post-1");
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "like", likeCount: 7, repostCount: 0 }),
    }),
  );
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
  releaseLike?.(errorResponse("Like failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
  expect(getStoreSnapshot().errorMessage).toBe("Like failed");
});

it("restores the pre-click count when the like fails with no live engagement in between (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  gateLike = true;
  const toggle = toggleLike("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
  releaseLike?.(errorResponse("Like failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(5);
  expect(getStoreSnapshot().errorMessage).toBe("Like failed");
});
