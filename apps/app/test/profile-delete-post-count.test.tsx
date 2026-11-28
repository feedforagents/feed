// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { deletePost, loadProfile, loadProfileReplies, removePostAcrossStore } from "../src/web/store-world.ts";
import { decodePost } from "../src/web/types.ts";
import { makeRawPost, makeRawProfileBundle, makeViewerSession } from "./app-test-helpers.tsx";

const createdAt = Date.now() - 60_000;
const firstRaw = makeRawPost(createdAt, { id: "alice-post-1", content: "Alice first call" });
const secondRaw = makeRawPost(createdAt, { id: "alice-post-2", content: "Alice second call" });
const thirdRaw = makeRawPost(createdAt, { id: "alice-post-3", content: "Alice third call" });
const replyRaw = makeRawPost(createdAt, { id: "alice-reply-1", content: "Alice reply note", replyToPostId: "carol-post-9" });
const bobAuthor = { authorId: "bob", authorHandle: "bob", authorDisplayName: "Bob Trader" };
const bobFirstRaw = makeRawPost(createdAt, { id: "bob-post-1", content: "Bob first call", ...bobAuthor });
const bobSecondRaw = makeRawPost(createdAt, { id: "bob-post-2", content: "Bob second call", ...bobAuthor });
const bobThirdRaw = makeRawPost(createdAt, { id: "bob-post-3", content: "Bob third call", ...bobAuthor });

function profileRaw(postsCount: number, posts: ReadonlyArray<Record<string, unknown>>, nextCursor: string | null = null): Record<string, unknown> {
  return makeRawProfileBundle({ handle: "alice", displayName: "Alice Player", createdAt, postsCount, posts, nextCursor });
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

function decodedPost(raw: Record<string, unknown>, viewerHandle = "alice") {
  const decoded = decodePost(raw, viewerHandle);
  if (decoded === null) throw new Error("test fixtures must decode");
  return decoded;
}

type FeedDeleteCase = {
  readonly feedRaw: Record<string, unknown>;
  readonly postId: string;
  readonly profile: Record<string, unknown>;
  readonly replyToPostId?: string | null;
  readonly parentReplyCount?: number | null;
  readonly countAfterLoad: number;
  readonly countAfterDelete: number;
};

function stubDeleteAndProfileFetch(testCase: FeedDeleteCase, deleteFetch: () => Promise<Response>): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (isDeletePost(input, init, testCase.postId)) return deleteFetch();
    if (fetchPath(input).startsWith("/api/users/alice")) return Promise.resolve(Response.json(testCase.profile));
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

function expectFeedClearedWithCount(count: number): void {
  expect(getStoreSnapshot().feedPosts).toHaveLength(0);
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(count);
}

function expectDeleteSettled(testCase: FeedDeleteCase): void {
  expectFeedClearedWithCount(testCase.countAfterDelete);
  removePostAcrossStore(testCase.postId, { replyToPostId: testCase.replyToPostId ?? null, parentReplyCount: testCase.parentReplyCount ?? null });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(testCase.countAfterDelete);
}

async function deleteFeedPostAgainstLoadedProfile(testCase: FeedDeleteCase): Promise<void> {
  stubDeleteAndProfileFetch(testCase, () => deletePostResponse(testCase.postId, testCase.replyToPostId ?? null, testCase.parentReplyCount ?? null));
  signInAsAlice();
  await loadProfile("alice");
  setStoreState({ feedPosts: [decodedPost(testCase.feedRaw)] });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(testCase.countAfterLoad);

  await deletePost(testCase.postId);

  expectDeleteSettled(testCase);
}

async function deleteFeedPostWithReloadDuringRoundTrip(testCase: FeedDeleteCase): Promise<void> {
  const deleteGate: { release: ((response: Response) => void) | null } = { release: null };
  stubDeleteAndProfileFetch(testCase, () => new Promise<Response>((resolve) => { deleteGate.release = resolve; }));
  signInAsAlice();
  setStoreState({ feedPosts: [decodedPost(testCase.feedRaw)] });

  const pendingDelete = deletePost(testCase.postId);
  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(testCase.countAfterLoad);

  deleteGate.release?.(await deletePostResponse(testCase.postId, testCase.replyToPostId ?? null, testCase.parentReplyCount ?? null));
  await pendingDelete;

  expectDeleteSettled(testCase);
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
  await deleteFeedPostAgainstLoadedProfile({
    feedRaw: firstRaw,
    postId: "alice-post-1",
    profile: profileRaw(3, [secondRaw], "more"),
    countAfterLoad: 3,
    countAfterDelete: 2,
  });
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["alice-post-2"]);
});

it('A profile reload that lands after the server delete keeps its count when the delete signal arrives (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  await deleteFeedPostAgainstLoadedProfile({
    feedRaw: firstRaw,
    postId: "alice-post-1",
    profile: profileRaw(2, [secondRaw, thirdRaw]),
    countAfterLoad: 2,
    countAfterDelete: 2,
  });
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["alice-post-2", "alice-post-3"]);
});

it('Deleting an own reply outside the loaded profile lists drops the header count once on a complete page (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  await deleteFeedPostAgainstLoadedProfile({
    feedRaw: replyRaw,
    postId: "alice-reply-1",
    profile: profileRaw(2, [firstRaw]),
    replyToPostId: "carol-post-9",
    parentReplyCount: 0,
    countAfterLoad: 2,
    countAfterDelete: 1,
  });
});

it('A profile reload during the delete round trip keeps its count when more profile pages remain (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  await deleteFeedPostWithReloadDuringRoundTrip({
    feedRaw: firstRaw,
    postId: "alice-post-1",
    profile: profileRaw(2, [secondRaw, thirdRaw], "more"),
    countAfterLoad: 2,
    countAfterDelete: 2,
  });
});

it('A profile reload during a reply delete round trip keeps its count on a complete page (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  await deleteFeedPostWithReloadDuringRoundTrip({
    feedRaw: replyRaw,
    postId: "alice-reply-1",
    profile: profileRaw(2, [firstRaw]),
    replyToPostId: "carol-post-9",
    parentReplyCount: 0,
    countAfterLoad: 2,
    countAfterDelete: 2,
  });
});

it('A live delete event for a post outside the loaded profile page keeps a count loaded after the server delete (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    if (fetchPath(input).startsWith("/api/users/bob")) {
      return Promise.resolve(Response.json(makeRawProfileBundle({
        handle: "bob",
        displayName: "Bob Trader",
        createdAt,
        postsCount: 4,
        posts: [bobSecondRaw, bobThirdRaw],
        nextCursor: "more",
      })));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  signInAsAlice();
  setStoreState({ profileHandle: "bob" });
  await loadProfile("bob");
  setStoreState({ feedPosts: [decodedPost(bobFirstRaw)] });
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(4);

  removePostAcrossStore("bob-post-1", { replyToPostId: null, parentReplyCount: null });

  expectFeedClearedWithCount(4);
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
