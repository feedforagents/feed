// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { loadMoreProfilePosts, repostPost } from "../src/web/store-world.ts";
import { makeRawProfileBundle } from "./app-test-helpers.tsx";
import { decodedPost, jsonPayload, makeProfileBundle, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const createdAt = Date.now() - 60_000;
const detailPost = decodedPost(postRaw({ id: "post-1", repostCount: 3, repostedByViewer: false }));

let releaseLoadMore: ((response: Response) => void) | null = null;

function stalePage(): Response {
  return jsonPayload({
    ...makeRawProfileBundle({
      handle: "carol",
      displayName: "Carol Analyst",
      createdAt,
      postsCount: 2,
      posts: [postRaw({ id: "post-1", repostCount: 3, repostedByViewer: false, createdAt })],
    }),
    nextCursor: null,
  });
}

function profileCopy() {
  return getStoreSnapshot().profileBundle?.posts.find((p) => p.card.id === "post-1");
}

beforeEach(() => {
  releaseLoadMore = null;
  stubFetchUrl((url) => {
    if (url.includes("/api/users/carol")) {
      return new Promise<Response>((resolve) => { releaseLoadMore = resolve; });
    }
    if (url.includes("/api/posts/post-1/repost")) {
      return Promise.resolve(jsonPayload({ postId: "post-1", reposted: true, repostCount: 4 }));
    }
    return Promise.resolve(jsonPayload({}));
  });
  resetWorldFeedStore({
    route: "PostDetail",
    activePostId: "post-1",
    activeThread: { post: detailPost, parentPost: null, ancestors: [], replies: [] },
    profileBundle: {
      ...makeProfileBundle("carol", "Carol Analyst", 0, 0, false),
      posts: [decodedPost(postRaw({ id: "post-0", createdAt }))],
      postsNextCursor: "cursor-1",
    },
    profileLoadingMore: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps a committed repost when a profile page load that started before it lands after it (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const loadMore = loadMoreProfilePosts();
  await repostPost("post-1");
  expect(getStoreSnapshot().activeThread?.post.card.reposted).toBe(true);
  expect(getStoreSnapshot().activeThread?.post.card.repostCount).toBe(4);
  releaseLoadMore?.(stalePage());
  await loadMore;
  expect(profileCopy()?.card.reposted).toBe(true);
  expect(profileCopy()?.card.repostCount).toBe(4);
});

it("shows the repost on the profile list when the page lands before the repost (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const loadMore = loadMoreProfilePosts();
  releaseLoadMore?.(stalePage());
  await loadMore;
  expect(profileCopy()?.card.reposted).toBe(false);
  await repostPost("post-1");
  expect(profileCopy()?.card.reposted).toBe(true);
  expect(profileCopy()?.card.repostCount).toBe(4);
});
