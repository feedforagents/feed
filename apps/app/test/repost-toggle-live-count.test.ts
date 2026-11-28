// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { loadFeed, repostPost } from "../src/web/store-world.ts";
import { eventSources, installStubEventSource } from "./app-test-helpers.tsx";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const basePost = decodedPost(postRaw({ id: "post-1", repostCount: 3, repostedByViewer: false }));

let releaseRepost: ((response: Response) => void) | null = null;
let releaseFeed: ((response: Response) => void) | null = null;

beforeEach(() => {
  releaseRepost = null;
  eventSources.length = 0;
  installStubEventSource(eventSources);
  stubFetchUrl((url) => {
    if (url.includes("/api/posts/post-1/repost")) return new Promise<Response>((resolve) => { releaseRepost = resolve; });
    if (url.includes("/api/feed")) return new Promise<Response>((resolve) => { releaseFeed = resolve; });
    return Promise.resolve(jsonPayload({}));
  });
  resetWorldFeedStore({ feedPosts: [basePost], errorMessage: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  eventSources.length = 0;
});

it("keeps a live repost count that landed while the repost request was in flight when the repost then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  reconnectRealtime();
  const toggle = repostPost("post-1");
  eventSources.at(-1)?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "repost", likeCount: 0, repostCount: 7 }),
    }),
  );
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  releaseRepost?.(jsonPayload({ message: "Repost failed" }, 500));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});

it("restores the pre-click repost count when the repost fails with no live engagement in between (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = repostPost("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(4);
  releaseRepost?.(jsonPayload({ message: "Repost failed" }, 500));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(3);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});

function dispatchRepostEngagement(accountId: string, kind: string, repostCount: number): void {
  eventSources.at(-1)?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind, accountId, likeCount: 0, repostCount }),
    }),
  );
}

async function expectServerRepostCountAfterLiveReposts(ownEvent: { kind: string; repostCount: number } | null): Promise<void> {
  reconnectRealtime();
  const toggle = repostPost("post-1");
  dispatchRepostEngagement("bob", "repost", 5);
  if (ownEvent === null) expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(5);
  else dispatchRepostEngagement("alice", ownEvent.kind, ownEvent.repostCount);
  releaseRepost?.(jsonPayload({ postId: "post-1", reposted: true, repostCount: 6 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(6);
}

it("shows the server repost count when live reposts land before the repost commits (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  await expectServerRepostCountAfterLiveReposts(null);
});

it("shows the server repost count when live reposts land before the repost commits and the own event follows (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  await expectServerRepostCountAfterLiveReposts({ kind: "repost", repostCount: 6 });
});

it("shows the server repost count when an own like event lands before the repost commits (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  await expectServerRepostCountAfterLiveReposts({ kind: "like", repostCount: 5 });
});

it("keeps a live repost count that landed after the own repost event while the request was in flight (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  reconnectRealtime();
  const toggle = repostPost("post-1");
  dispatchRepostEngagement("alice", "repost", 4);
  dispatchRepostEngagement("bob", "repost", 5);
  releaseRepost?.(jsonPayload({ postId: "post-1", reposted: true, repostCount: 4 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(5);
});

it("shows the server repost count when a live repost lands before the unrepost commits (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const repostedPost = decodedPost(postRaw({ id: "post-1", repostCount: 5, repostedByViewer: true }));
  resetWorldFeedStore({ feedPosts: [repostedPost], errorMessage: null });
  reconnectRealtime();
  const toggle = repostPost("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(4);
  dispatchRepostEngagement("bob", "repost", 6);
  releaseRepost?.(jsonPayload({ postId: "post-1", reposted: false, repostCount: 5 }));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(5);
});

it("keeps each copy's server repost count when a feed refresh lands and the repost then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const detailPost = decodedPost(postRaw({ id: "post-1", repostCount: 5, repostedByViewer: false }));
  setStoreState({ route: "PostDetail", activePostId: "post-1", activeThread: { post: detailPost, parentPost: null, ancestors: [], replies: [] } });
  const repostCopies = () => [getStoreSnapshot().feedPosts[0], getStoreSnapshot().activeThread?.post].map((p) => [p?.card.reposted, p?.card.repostCount]);
  const toggle = repostPost("post-1");
  expect(repostCopies()).toEqual([[true, 4], [true, 6]]);
  const refresh = loadFeed();
  releaseFeed?.(jsonPayload({ items: [postRaw({ id: "post-1", repostCount: 5, repostedByViewer: false })], nextCursor: null }));
  await refresh;
  releaseRepost?.(jsonPayload({ message: "Repost failed" }, 500));
  await toggle;
  expect(repostCopies()).toEqual([[false, 5], [false, 5]]);
});
