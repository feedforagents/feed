// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { createPost, openThread } from "../src/web/store-world.ts";
import { createdReplyRaw, jsonPayload, postRaw, resetReplyThreadStore, stubFetch } from "./moderation-fixtures.ts";
const staleThread = {
  post: postRaw({ id: "post-1", replyCount: 1 }),
  parentPost: null,
  ancestors: [],
  replies: [postRaw({ id: "reply-existing", replyToPostId: "post-1" })],
};
const freshThread = {
  post: postRaw({ id: "post-1", replyCount: 2 }),
  parentPost: null,
  ancestors: [],
  replies: [
    postRaw({ id: "reply-new", replyToPostId: "post-1", content: "Fresh reply" }),
    postRaw({ id: "reply-existing", replyToPostId: "post-1" }),
  ],
};

let resolveStaleThread: ((res: Response) => void) | null = null;
let resolveFeed: ((res: Response) => void) | null = null;
let threadCalls = 0;
let refreshFails = true;

beforeEach(() => {
  resolveStaleThread = null;
  resolveFeed = null;
  threadCalls = 0;
  refreshFails = true;
  stubFetch((url, method) => {
    if (url.endsWith("/api/posts") && method === "POST") {
      return Promise.resolve(jsonPayload(createdReplyRaw));
    }
    if (url.includes("/api/posts/post-1?")) {
      threadCalls += 1;
      if (threadCalls === 1) {
        return new Promise<Response>((resolve) => {
          resolveStaleThread = resolve;
        });
      }
      if (refreshFails) return Promise.resolve(jsonPayload({ message: "Thread failed" }, 500));
      return Promise.resolve(jsonPayload(freshThread));
    }
    if (url.includes("/api/feed")) {
      return new Promise<Response>((resolve) => {
        resolveFeed = resolve;
      });
    }
    return Promise.resolve(jsonPayload({}));
  });
  resetReplyThreadStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function postReplyWhileStaleThreadLands(): Promise<void> {
  const staleLoad = openThread("post-1", "newest");
  const posting = createPost("Fresh reply", { replyToPostId: "post-1" });
  await vi.waitFor(() => {
    expect(getStoreSnapshot().activeThread?.replies.map((r) => r.card.id)).toContain("reply-new");
  });
  resolveStaleThread?.(jsonPayload(staleThread));
  await staleLoad;
  resolveFeed?.(jsonPayload({ items: [], nextCursor: null }));
  await posting;
}

function expectReplyKept(): void {
  const s = getStoreSnapshot();
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-new", "reply-existing"]);
  expect(s.activeThread?.post.card.replyCount).toBe(2);
}

it("keeps a posted reply when a thread load started before the post lands after it and the follow-up refresh fails (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  await postReplyWhileStaleThreadLands();
  expectReplyKept();
});

it("keeps the server thread when the follow-up refresh succeeds after a stale thread lands (spec/social/posts.md, \"Story: Create and delete posts with unified replies and attribution\")", async () => {
  refreshFails = false;
  await postReplyWhileStaleThreadLands();
  expectReplyKept();
});
