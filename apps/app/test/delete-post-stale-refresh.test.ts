// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { deletePost, loadFeed, loadProfile, openThread } from "../src/web/store-world.ts";
import { makeRawPost, makeRawProfileBundle } from "./app-test-helpers.tsx";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore } from "./moderation-fixtures.ts";

const createdAt = Date.now() - 60_000;
const aliceFirstRaw = makeRawPost(createdAt, { id: "alice-post-1", content: "Alice first call" });
const aliceSecondRaw = makeRawPost(createdAt, { id: "alice-post-2", content: "Alice second call" });
const aliceReplyRaw = makeRawPost(createdAt, {
  id: "alice-reply-1",
  content: "Alice reply note",
  replyToPostId: "carol-post-9",
});
const carolParentRaw = postRaw({ id: "carol-post-9", content: "Carol parent note", replyCount: 1 });

let releaseFeed: ((response: Response) => void) | null = null;
let releaseThread: ((response: Response) => void) | null = null;
let releaseProfile: ((response: Response) => void) | null = null;

beforeEach(() => {
  releaseFeed = null;
  releaseThread = null;
  releaseProfile = null;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (method === "DELETE" && url.includes("/api/posts/alice-post-1")) {
      return Promise.resolve(jsonPayload({ postId: "alice-post-1", deleted: true, replyToPostId: null, parentReplyCount: null }));
    }
    if (method === "DELETE" && url.includes("/api/posts/alice-reply-1")) {
      return Promise.resolve(jsonPayload({ postId: "alice-reply-1", deleted: true, replyToPostId: "carol-post-9", parentReplyCount: 0 }));
    }
    if (url.includes("/api/posts/carol-post-9")) {
      return new Promise<Response>((resolve) => { releaseThread = resolve; });
    }
    if (url.includes("/api/users/alice")) {
      return new Promise<Response>((resolve) => { releaseProfile = resolve; });
    }
    if (url.includes("/api/feed")) {
      return new Promise<Response>((resolve) => { releaseFeed = resolve; });
    }
    return Promise.resolve(jsonPayload({}, 404));
  });
  resetWorldFeedStore({
    feedPosts: [decodedPost(aliceFirstRaw), decodedPost(aliceSecondRaw)],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps a deleted own post out of the feed when an earlier feed refresh resolves with a pre-delete snapshot (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const refresh = loadFeed();
  await deletePost("alice-post-1");
  expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["alice-post-2"]);

  releaseFeed?.(jsonPayload({ items: [aliceFirstRaw, aliceSecondRaw], nextCursor: null }));
  await refresh;

  expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["alice-post-2"]);
});

it('applies a feed refresh snapshot when no delete intervened (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const refresh = loadFeed();
  releaseFeed?.(jsonPayload({ items: [aliceSecondRaw, aliceFirstRaw], nextCursor: null }));
  await refresh;

  expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["alice-post-2", "alice-post-1"]);
});

it('keeps a deleted own reply out of the thread when an earlier thread refresh resolves with a pre-delete snapshot (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const parent = decodedPost(carolParentRaw);
  const reply = decodedPost(aliceReplyRaw);
  setStoreState({
    route: "PostDetail",
    activePostId: "carol-post-9",
    activeThread: { post: parent, parentPost: null, ancestors: [], replies: [reply] },
  });

  const refresh = openThread("carol-post-9");
  await deletePost("alice-reply-1");
  expect(getStoreSnapshot().activeThread?.replies).toEqual([]);
  expect(getStoreSnapshot().activeThread?.post.card.replyCount).toBe(0);

  releaseThread?.(jsonPayload({
    post: carolParentRaw,
    parentPost: null,
    ancestors: [],
    replies: [aliceReplyRaw],
  }));
  await refresh;

  expect(getStoreSnapshot().activeThread?.replies).toEqual([]);
  expect(getStoreSnapshot().activeThread?.post.card.replyCount).toBe(0);
});

it('keeps a deleted own post out of the profile list and header count when an earlier profile refresh resolves with a pre-delete snapshot (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  setStoreState({ route: "Profile", profileHandle: "alice" });

  const refresh = loadProfile("alice");
  await deletePost("alice-post-1");
  expect(getStoreSnapshot().feedPosts.map((p) => p.card.id)).toEqual(["alice-post-2"]);

  releaseProfile?.(jsonPayload(makeRawProfileBundle({
    handle: "alice",
    displayName: "Alice Player",
    createdAt,
    postsCount: 2,
    posts: [aliceFirstRaw, aliceSecondRaw],
  })));
  await refresh;

  const bundle = getStoreSnapshot().profileBundle;
  expect(bundle?.posts.map((p) => p.card.id)).toEqual(["alice-post-2"]);
  expect(bundle?.postsCount).toBe(1);
});
