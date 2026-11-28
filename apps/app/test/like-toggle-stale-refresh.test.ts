// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { closeThread, loadFeed, loadMoreFeed, openThread, repostPost, toggleLike } from "../src/web/store-world.ts";
import { eventSources, installStubEventSource } from "./app-test-helpers.tsx";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const basePost = decodedPost(postRaw({ id: "post-1", likeCount: 5, likedByViewer: false }));

let releaseFeed: ((response: Response) => void) | null = null;
let releaseThread: ((response: Response) => void) | null = null;
let releaseLike: ((response: Response) => void) | null = null;
let releaseRepost: ((response: Response) => void) | null = null;
let gateLike = false;

beforeEach(() => {
  releaseFeed = null;
  releaseThread = null;
  releaseLike = null;
  releaseRepost = null;
  gateLike = false;
  eventSources.length = 0;
  installStubEventSource(eventSources);
  stubFetchUrl((url) => {
    if (url.includes("/api/posts/post-1/like")) {
      if (gateLike) return new Promise<Response>((resolve) => { releaseLike = resolve; });
      return Promise.resolve(jsonPayload({ postId: "post-1", liked: true, likeCount: 6 }));
    }
    if (url.includes("/api/posts/post-1/repost")) {
      return new Promise<Response>((resolve) => { releaseRepost = resolve; });
    }
    if (url.includes("/api/posts/post-1?")) {
      return new Promise<Response>((resolve) => { releaseThread = resolve; });
    }
    if (url.includes("/api/feed")) {
      return new Promise<Response>((resolve) => { releaseFeed = resolve; });
    }
    return Promise.resolve(jsonPayload({}));
  });
  resetWorldFeedStore({ feedPosts: [basePost] });
});

afterEach(() => {
  eventSources.length = 0;
  vi.unstubAllGlobals();
});

function dispatchEngagement(accountId: string, kind: string, likeCount: number): void {
  eventSources.at(-1)?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind, accountId, likeCount, repostCount: 0 }),
    }),
  );
}

function startGatedLikeWithLiveEvent(likeCount: number): Promise<void> {
  gateLike = true;
  reconnectRealtime();
  const toggle = toggleLike("post-1");
  dispatchEngagement("bob", "like", likeCount);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(likeCount);
  return toggle;
}

it("keeps a completed like when an earlier feed refresh resolves with a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const refresh = loadFeed();
  await toggleLike("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
  releaseFeed?.(jsonPayload({ items: [postRaw({ id: "post-1", likeCount: 5, likedByViewer: false })], nextCursor: null }));
  await refresh;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
});

it("applies a feed refresh snapshot when no like intervened (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const refresh = loadFeed();
  releaseFeed?.(jsonPayload({ items: [postRaw({ id: "post-1", likeCount: 9, likedByViewer: false })], nextCursor: null }));
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
  releaseThread?.(jsonPayload({
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
  dispatchEngagement("alice", "like", 6);
  dispatchEngagement("bob", "like", 7);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
  releaseLike?.(jsonPayload({ postId: "post-1", liked: true, likeCount: 6 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(7);
});

async function expectServerCountAfterLiveLikes(ownEventCount: number | null): Promise<void> {
  const toggle = startGatedLikeWithLiveEvent(7);
  if (ownEventCount !== null) dispatchEngagement("alice", "like", ownEventCount);
  releaseLike?.(jsonPayload({ postId: "post-1", liked: true, likeCount: 8 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(8);
}

it("shows the server count when live likes land before the like commits (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  await expectServerCountAfterLiveLikes(null);
});

it("shows the server count when live likes land before the like commits and the own event follows (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  await expectServerCountAfterLiveLikes(8);
});

it("shows the server count in post detail when a live like lands before the unlike commits (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const likedPost = decodedPost(postRaw({ id: "post-1", likeCount: 5, likedByViewer: true }));
  resetWorldFeedStore({ feedPosts: [likedPost] });
  setStoreState({
    route: "PostDetail",
    activePostId: "post-1",
    activeThread: { post: likedPost, parentPost: null, ancestors: [], replies: [] },
  });
  gateLike = true;
  reconnectRealtime();
  const toggle = toggleLike("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(4);
  dispatchEngagement("bob", "like", 6);
  releaseLike?.(jsonPayload({ postId: "post-1", liked: false, likeCount: 5 }));
  await toggle;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(5);
});

it("keeps a live engagement count that landed while the like request was in flight when the like then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = startGatedLikeWithLiveEvent(7);
  releaseLike?.(jsonPayload({ message: "Like failed" }, 500));
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
  releaseLike?.(jsonPayload({ message: "Like failed" }, 500));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(5);
  expect(getStoreSnapshot().errorMessage).toBe("Like failed");
});

function releaseThreadPost(overrides: Record<string, unknown>): void {
  releaseThread?.(jsonPayload({
    post: postRaw({ id: "post-1", ...overrides }),
    parentPost: null,
    ancestors: [],
    replies: [],
  }));
}

function releaseStaleThread(): void {
  releaseThreadPost({ likeCount: 5, likedByViewer: false });
}

function openDetailPost(post: typeof basePost, feedNextCursor: string | null = null): void {
  resetWorldFeedStore({ feedPosts: [], feedNextCursor });
  setStoreState({
    route: "PostDetail",
    activePostId: "post-1",
    activeThread: { post, parentPost: null, ancestors: [], replies: [] },
  });
}

function startDetailLikeThenLeave(feedNextCursor: string | null = null): Promise<void> {
  openDetailPost(basePost, feedNextCursor);
  gateLike = true;
  const toggle = toggleLike("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(true);
  closeThread();
  return toggle;
}

it("keeps a like that committed while the post was out of the store when a reopened thread resolves with a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = startDetailLikeThenLeave();
  const reopen = openThread("post-1");
  releaseLike?.(jsonPayload({ postId: "post-1", liked: true, likeCount: 6 }));
  await toggle;
  releaseStaleThread();
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(true);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(6);
});

it("keeps a like that committed while the post was out of the store when a feed page appends a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = startDetailLikeThenLeave("cursor-1");
  setStoreState({ route: "Home" });
  const more = loadMoreFeed();
  releaseLike?.(jsonPayload({ postId: "post-1", liked: true, likeCount: 6 }));
  await toggle;
  releaseFeed?.(jsonPayload({ items: [postRaw({ id: "post-1", likeCount: 5, likedByViewer: false })], nextCursor: null }));
  await more;
  expect(getStoreSnapshot().feedPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.likeCount).toBe(6);
});

it("restores the pre-click like state when a like fails while the post is out of the store and a reopened thread resolves (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = startDetailLikeThenLeave();
  const reopen = openThread("post-1");
  releaseLike?.(jsonPayload({ message: "Like failed" }, 500));
  await toggle;
  releaseStaleThread();
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(5);
  expect(getStoreSnapshot().errorMessage).toBe("Like failed");
});

it("keeps the snapshot like count when a like fails while the post is out of the store and other likes landed meanwhile (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = startDetailLikeThenLeave();
  const reopen = openThread("post-1");
  releaseLike?.(jsonPayload({ message: "Like failed" }, 500));
  await toggle;
  releaseThreadPost({ likeCount: 8, likedByViewer: false });
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(8);
  expect(getStoreSnapshot().errorMessage).toBe("Like failed");
});

it("keeps the snapshot repost count when a repost fails while the post is out of the store and other reposts landed meanwhile (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  openDetailPost(decodedPost(postRaw({ id: "post-1", likeCount: 5, repostCount: 2 })));
  const toggle = repostPost("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.reposted).toBe(true);
  expect(getStoreSnapshot().activeThread?.post.card.repostCount).toBe(3);
  closeThread();
  const reopen = openThread("post-1");
  releaseRepost?.(jsonPayload({ message: "Repost failed" }, 500));
  await toggle;
  releaseThreadPost({ likeCount: 5, repostCount: 4, repostedByViewer: false });
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.reposted).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.repostCount).toBe(4);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});

it("lets a newer snapshot own like state win when a live count arrives for a post that is out of the store (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  openDetailPost(basePost);
  reconnectRealtime();
  await toggleLike("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(true);
  closeThread();
  const reopen = openThread("post-1");
  dispatchEngagement("bob", "like", 6);
  releaseThreadPost({ likeCount: 5, likedByViewer: false });
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.liked).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.likeCount).toBe(6);
});

it("lets a newer snapshot own repost state win when a live count arrives for a post that is out of the store (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  openDetailPost(decodedPost(postRaw({ id: "post-1", likeCount: 5, repostCount: 2 })));
  reconnectRealtime();
  const toggle = repostPost("post-1");
  releaseRepost?.(jsonPayload({ postId: "post-1", reposted: true, repostCount: 3 }));
  await toggle;
  expect(getStoreSnapshot().activeThread?.post.card.reposted).toBe(true);
  closeThread();
  const reopen = openThread("post-1");
  eventSources.at(-1)?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "repost", accountId: "bob", likeCount: 5, repostCount: 3 }),
    }),
  );
  releaseThreadPost({ likeCount: 5, repostCount: 2, repostedByViewer: false });
  await reopen;
  expect(getStoreSnapshot().activeThread?.post.card.reposted).toBe(false);
  expect(getStoreSnapshot().activeThread?.post.card.repostCount).toBe(3);
});
