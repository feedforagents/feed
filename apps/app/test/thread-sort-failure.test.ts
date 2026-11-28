// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { openThread } from "../src/web/store-world.ts";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const threadPost = decodedPost(postRaw({ id: "post-1" }));
const popularReply = decodedPost(postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }));
const newestReply = decodedPost(postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }));

let failThread = false;

beforeEach(() => {
  failThread = false;
  stubFetchUrl((url) => {
    if (url.includes("/api/posts/post-1?")) {
      if (failThread) return Promise.resolve(jsonPayload({ message: "Thread failed" }, 500));
      return Promise.resolve(jsonPayload({
        post: postRaw({ id: "post-1" }),
        parentPost: null,
        ancestors: [],
        replies: [
          postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }),
          postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }),
        ],
      }));
    }
    return Promise.resolve(jsonPayload({}));
  });
  resetWorldFeedStore({
    route: "PostDetail",
    feedPosts: [threadPost],
    activeThread: { post: threadPost, parentPost: null, ancestors: [], replies: [popularReply, newestReply] },
    activePostId: "post-1",
    threadSort: "popular",
    threadLoading: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectPopularThreadFailure(): void {
  const s = getStoreSnapshot();
  expect(s.threadSort).toBe("popular");
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-popular", "reply-newest"]);
  expect(s.errorMessage).toBe("Thread failed");
}

it("keeps the previous reply sort when switching sorts fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failThread = true;
  await openThread("post-1", "newest");
  expectPopularThreadFailure();
});

it("applies the new reply sort when switching sorts succeeds (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  await openThread("post-1", "newest");
  const s = getStoreSnapshot();
  expect(s.threadSort).toBe("newest");
  expect(s.activeThread?.replies.map((r) => r.card.id)).toEqual(["reply-newest", "reply-popular"]);
});

it("keeps the current reply sort when a same-sort refresh fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failThread = true;
  await openThread("post-1", "popular");
  expectPopularThreadFailure();
});

it("keeps the displayed reply sort when a second sort switch fails while the first is still loading (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  let releaseNewest: (res: Response) => void = () => {};
  const newestGate = new Promise<Response>((resolve) => {
    releaseNewest = resolve;
  });
  stubFetchUrl((url) => {
    if (url.includes("sort=newest")) return newestGate;
    if (url.includes("sort=oldest")) return Promise.resolve(jsonPayload({ message: "Thread failed" }, 500));
    if (url.includes("/api/posts/post-1?")) {
      return Promise.resolve(jsonPayload({
        post: postRaw({ id: "post-1" }),
        parentPost: null,
        ancestors: [],
        replies: [
          postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }),
          postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }),
        ],
      }));
    }
    return Promise.resolve(jsonPayload({}));
  });
  await openThread("post-1", "popular");
  const firstSwitch = openThread("post-1", "newest");
  await openThread("post-1", "oldest");
  expectPopularThreadFailure();
  releaseNewest(jsonPayload({
    post: postRaw({ id: "post-1" }),
    parentPost: null,
    ancestors: [],
    replies: [
      postRaw({ id: "reply-newest", replyToPostId: "post-1", likeCount: 0 }),
      postRaw({ id: "reply-popular", replyToPostId: "post-1", likeCount: 9 }),
    ],
  }));
  await firstSwitch;
  expectPopularThreadFailure();
});
