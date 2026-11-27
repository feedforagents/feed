// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { decodePost } from "../src/web/types.ts";
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
const parentPost = decodePost(parentRaw);
if (parentPost === null) {
  throw new Error("test fixture must decode");
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

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({}))));
  vi.stubGlobal("EventSource", StubEventSource);
  setStoreState({
    viewer,
    route: "Home",
    feedPosts: [parentPost],
    explore: { trending: [], articles: [], posts: [parentPost], accounts: [], actors: [], organizations: [], tags: [] },
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    marketSocialPosts: [parentPost],
    activeThread: null,
  });
  reconnectRealtime();
});

afterEach(() => {
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

it("sets the parent card reply count from a personalized post.created event (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", () => {
  expect(getStoreSnapshot().feedPosts[0]?.card.replyCount).toBe(1);
  dispatchCreated({ parentReplyCount: 2 });
  expect(getStoreSnapshot().feedPosts[0]?.card.replyCount).toBe(2);
  expect(getStoreSnapshot().explore.posts[0]?.card.replyCount).toBe(2);
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.replyCount).toBe(2);
});

it("does not bump the parent count when post.created has no personalized parentReplyCount (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", () => {
  dispatchCreated({});
  expect(getStoreSnapshot().feedPosts[0]?.card.replyCount).toBe(1);
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
  expect(getStoreSnapshot().feedPosts[0]?.card.replyCount).toBe(1);
});
