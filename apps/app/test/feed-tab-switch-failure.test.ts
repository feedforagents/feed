// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { loadMoreFeed, selectFeedTab } from "../src/web/store-world.ts";
import { decodedPost, jsonPayload, postRaw, resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

const latestPost = decodedPost(postRaw({ id: "post-1" }));
const feedUrls: string[] = [];
let failFeed = false;

beforeEach(() => {
  feedUrls.length = 0;
  failFeed = false;
  stubFetchUrl((url) => {
    if (url.includes("/api/feed")) {
      feedUrls.push(url);
      if (failFeed) return Promise.resolve(jsonPayload({ message: "boom" }, 500));
      return Promise.resolve(jsonPayload({ items: [postRaw({ id: "post-2" })], nextCursor: null }));
    }
    return Promise.resolve(jsonPayload({}));
  });
  resetWorldFeedStore({
    feedPosts: [latestPost],
    feedNextCursor: "111:post-1",
    feedLoadingMore: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectLatestFeedIntact(): void {
  const s = getStoreSnapshot();
  expect(s.feedTab).toBe("latest");
  expect(s.feedPosts.map((p) => p.card.id)).toEqual(["post-1"]);
  expect(s.feedNextCursor).toBe("111:post-1");
}

it("keeps the previous tab and its cursor when switching tabs fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failFeed = true;
  await selectFeedTab("top");
  expectLatestFeedIntact();
  failFeed = false;
  await loadMoreFeed();
  expect(feedUrls.at(-1)).toContain("tab=latest");
  expect(feedUrls.at(-1)).toContain("cursor=111%3Apost-1");
});

it("keeps the current tab when a same-tab refresh fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failFeed = true;
  await selectFeedTab("latest");
  expectLatestFeedIntact();
});
