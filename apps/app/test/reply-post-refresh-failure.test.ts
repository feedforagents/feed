// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { createPost } from "../src/web/store-world.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore } from "./moderation-fixtures.ts";

const threadPost = decodedPost(postRaw({ id: "post-1", replyCount: 1 }));
const existingReply = decodedPost(postRaw({ id: "reply-existing", replyToPostId: "post-1" }));
const createdRaw = postRaw({ id: "reply-new", replyToPostId: "post-1", content: "Fresh reply" });

let threadFails = true;

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

beforeEach(() => {
  threadFails = true;
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/posts") && method === "POST") {
      return Promise.resolve(jsonPayload(createdRaw));
    }
    if (url.includes("/api/posts/post-1?")) {
      if (threadFails) return Promise.resolve(jsonPayload({ message: "Thread failed" }, 500));
      return Promise.resolve(jsonPayload({
        post: postRaw({ id: "post-1", replyCount: 2 }),
        parentPost: null,
        ancestors: [],
        replies: [
          postRaw({ id: "reply-existing", replyToPostId: "post-1" }),
          postRaw({ id: "reply-new", replyToPostId: "post-1", content: "Fresh reply" }),
        ],
      }));
    }
    if (url.includes("/api/feed")) {
      return Promise.resolve(jsonPayload({ items: [], nextCursor: null }));
    }
    return Promise.resolve(jsonPayload({}));
  }));
  resetWorldFeedStore({
    route: "PostDetail",
    feedPosts: [threadPost],
    activeThread: { post: threadPost, parentPost: null, ancestors: [], replies: [existingReply] },
    activePostId: "post-1",
    threadSort: "oldest",
    threadLoading: false,
  });
  reconnectRealtime();
});

afterEach(() => {
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

async function expectReplyShownOnce() {
  expect(await createPost("Fresh reply", { replyToPostId: "post-1" })).toBe(true);
  const s = getStoreSnapshot();
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-existing", "reply-new"]);
  expect(s.activeThread?.post.card.replyCount).toBe(2);
}

it("shows a posted reply in the thread when the follow-up thread refresh fails (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  await expectReplyShownOnce();
});

it("does not double-count a posted reply whose live count already landed when the refresh fails (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.created", {
      data: JSON.stringify({
        type: "post.created",
        postId: "reply-new",
        authorId: "alice",
        authorKind: "user",
        replyToPostId: "post-1",
        quotePostId: null,
        createdAt: Date.now(),
        parentReplyCount: 2,
      }),
    }),
  );
  await expectReplyShownOnce();
});

it("keeps the server thread when the follow-up refresh succeeds (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  threadFails = false;
  await expectReplyShownOnce();
});
