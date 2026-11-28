// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { deletePost, loadProfile, loadProfileReplies, removePostAcrossStore } from "../src/web/store-world.ts";
import { decodePost } from "../src/web/types.ts";
import { makeRawPost, makeRawProfileBundle, makeViewerSession } from "./app-test-helpers.tsx";

const createdAt = Date.now() - 60_000;
const firstRaw = makeRawPost(createdAt, { id: "alice-post-1", content: "Alice first call" });
const secondRaw = makeRawPost(createdAt, { id: "alice-post-2", content: "Alice second call" });

function profileRaw(postsCount: number, posts: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return makeRawProfileBundle({ handle: "alice", displayName: "Alice Player", createdAt, postsCount, posts });
}

const aliceViewer = makeViewerSession();

function signInAsAlice(): void {
  setStoreState({
    viewer: aliceViewer,
    route: "Profile",
    profileHandle: "alice",
  });
}

function fetchPath(input: RequestInfo | URL): string {
  return input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
}

function deletePostResponse(postId: string, replyToPostId: string | null = null, parentReplyCount: number | null = null): Promise<Response> {
  return Promise.resolve(Response.json({ postId, deleted: true, replyToPostId, parentReplyCount }));
}

function isDeletePost(input: RequestInfo | URL, init: RequestInit | undefined, postId: string): boolean {
  return fetchPath(input).includes(`/api/posts/${postId}`) && (init?.method ?? "GET") === "DELETE";
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
    const url = fetchPath(input);
    if (isDeletePost(input, init, "alice-post-1")) return deletePostResponse("alice-post-1");
    if (url.startsWith("/api/users/alice")) {
      return Promise.resolve(Response.json(profileRaw(2, [firstRaw, secondRaw])));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  signInAsAlice();
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
  const carolRaw = makeRawPost(createdAt, {
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

  signInAsAlice();
  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(1);

  removePostAcrossStore("carol-post-1", { replyToPostId: null, parentReplyCount: null });

  const after = getStoreSnapshot().profileBundle;
  expect(after?.posts).toHaveLength(0);
  expect(after?.postsCount).toBe(1);
});

it('Deleting an own reply from the profile replies tab drops the header post count with the reply list (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const replyRaw = makeRawPost(createdAt, {
    id: "alice-reply-1",
    content: "Alice reply note",
    replyToPostId: "carol-post-9",
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/posts/alice-reply-1") && method === "DELETE") {
      return Promise.resolve(Response.json({ postId: "alice-reply-1", deleted: true, replyToPostId: "carol-post-9", parentReplyCount: 0 }));
    }
    if (url.includes("filter=replies")) {
      return Promise.resolve(Response.json({ items: [replyRaw], nextCursor: null }));
    }
    if (url.startsWith("/api/users/alice")) {
      return Promise.resolve(Response.json(profileRaw(2, [firstRaw])));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  signInAsAlice();
  await loadProfile("alice");
  await loadProfileReplies("alice");
  expect(getStoreSnapshot().profileReplies.map((p) => p.card.id)).toEqual(["alice-reply-1"]);
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["alice-post-1"]);
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(2);

  await deletePost("alice-reply-1");

  expect(getStoreSnapshot().profileReplies).toHaveLength(0);
  const afterDelete = getStoreSnapshot().profileBundle;
  expect(afterDelete?.posts.map((p) => p.card.id)).toEqual(["alice-post-1"]);
  expect(afterDelete?.postsCount).toBe(1);

  removePostAcrossStore("alice-reply-1", { replyToPostId: "carol-post-9", parentReplyCount: 0 });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(1);
});

it('Deleting an own post from the feed drops the loaded profile header count even when the post is outside the loaded profile page (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const decodedFirst = decodePost(firstRaw, "alice");
  if (decodedFirst === null) throw new Error("test fixtures must decode");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = fetchPath(input);
    if (isDeletePost(input, init, "alice-post-1")) return deletePostResponse("alice-post-1");
    if (url.startsWith("/api/users/alice")) {
      return Promise.resolve(Response.json(profileRaw(3, [secondRaw])));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  signInAsAlice();
  await loadProfile("alice");
  setStoreState({ feedPosts: [decodedFirst] });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(3);
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["alice-post-2"]);

  await deletePost("alice-post-1");

  expect(getStoreSnapshot().feedPosts).toHaveLength(0);
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(2);

  removePostAcrossStore("alice-post-1", { replyToPostId: null, parentReplyCount: null });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(2);
});

it('Deleting an own post turns its quote embeds unavailable in the same lists (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const quotingRaw = makeRawPost(createdAt, {
    id: "carol-quote-1",
    authorId: "carol",
    authorHandle: "carol",
    authorDisplayName: "Carol Analyst",
    content: "Carol quoting Alice",
    quotePostId: "alice-post-1",
    quotePost: {
      id: "alice-post-1",
      authorId: "alice",
      authorHandle: "alice",
      authorDisplayName: "Alice Player",
      content: "Alice first call",
      createdAt,
    },
  });
  const decodedTarget = decodePost(firstRaw, "alice");
  const decodedQuoting = decodePost(quotingRaw, "alice");
  if (decodedTarget === null || decodedQuoting === null) throw new Error("test fixtures must decode");
  expect(decodedQuoting.card.quotePost?.content).toBe("Alice first call");

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (isDeletePost(input, init, "alice-post-1")) return deletePostResponse("alice-post-1");
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  signInAsAlice();
  setStoreState({ feedPosts: [decodedQuoting, decodedTarget] });

  await deletePost("alice-post-1");

  const feedAfter = getStoreSnapshot().feedPosts;
  expect(feedAfter.map((p) => p.card.id)).toEqual(["carol-quote-1"]);
  expect(feedAfter[0]?.card.quotePost?.deleted).toBe(true);
  expect(feedAfter[0]?.card.quotePost?.content).toBe("");
});
