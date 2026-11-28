// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { loadMarketDetails, toggleLike } from "../src/web/store-world.ts";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const preLikePost = postRaw({ id: "post-1", likeCount: 5, likedByViewer: false });

let releaseSocial: ((response: Response) => void) | null = null;

function seedMarketSocial() {
  releaseSocial = null;
  resetWorldFeedStore({
    route: "Markets",
    selectedMarketKind: "prediction",
    selectedMarketId: "mkt-1",
    marketSocialPosts: [decodedPost(preLikePost)],
  });
  stubFetchUrl((url) => {
    if (url.includes("/api/posts/post-1/like")) {
      return Promise.resolve(jsonPayload({ postId: "post-1", liked: true, likeCount: 6 }));
    }
    if (url.includes("/api/feed")) {
      return new Promise<Response>((resolve) => {
        releaseSocial = resolve;
      });
    }
    if (url.includes("/history") || url.includes("/trades")) {
      return Promise.resolve(jsonPayload([]));
    }
    return Promise.resolve(jsonPayload({}));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps a like committed while the market page loads when its social posts land with a pre-like snapshot (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  seedMarketSocial();
  const load = loadMarketDetails("prediction", "mkt-1");
  await toggleLike("post-1");
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.likeCount).toBe(6);
  releaseSocial?.(jsonPayload({ items: [preLikePost], nextCursor: null }));
  await load;
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.liked).toBe(true);
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.likeCount).toBe(6);
});

it("applies the landed social snapshot when no engagement intervened (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  seedMarketSocial();
  const load = loadMarketDetails("prediction", "mkt-1");
  releaseSocial?.(jsonPayload({ items: [postRaw({ id: "post-1", likeCount: 9, likedByViewer: false })], nextCursor: null }));
  await load;
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.liked).toBe(false);
  expect(getStoreSnapshot().marketSocialPosts[0]?.card.likeCount).toBe(9);
});
