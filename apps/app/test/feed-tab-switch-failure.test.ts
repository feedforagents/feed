// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMoreFeed, selectFeedTab } from "../src/web/store-world.ts";
import { decodePost } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { postRaw } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();

function decoded(raw: Record<string, unknown>) {
  const post = decodePost(raw, "alice");
  if (post === null) throw new Error("test fixture must decode");
  return post;
}

const latestPost = decoded(postRaw({ id: "post-1" }));
const feedUrls: string[] = [];
let failFeed = false;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  feedUrls.length = 0;
  failFeed = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/feed")) {
      feedUrls.push(url);
      if (failFeed) return Promise.resolve(jsonResponse({ message: "boom" }, 500));
      return Promise.resolve(jsonResponse({ items: [postRaw({ id: "post-2" })], nextCursor: null }));
    }
    return Promise.resolve(jsonResponse({}));
  }));
  setStoreState({
    viewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [latestPost],
    feedNextCursor: "111:post-1",
    feedLoading: false,
    feedLoadingMore: false,
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    marketSocialPosts: [],
    activeThread: null,
    activePostId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps the previous tab and its cursor when switching tabs fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failFeed = true;
  await selectFeedTab("top");
  const s = getStoreSnapshot();
  expect(s.feedTab).toBe("latest");
  expect(s.feedPosts.map((p) => p.card.id)).toEqual(["post-1"]);
  expect(s.feedNextCursor).toBe("111:post-1");
  failFeed = false;
  await loadMoreFeed();
  expect(feedUrls.at(-1)).toContain("tab=latest");
  expect(feedUrls.at(-1)).toContain("cursor=111%3Apost-1");
});

it("keeps the current tab when a same-tab refresh fails (spec/app/navigation.md, \"Story: Browse public world content without a login wall\")", async () => {
  failFeed = true;
  await selectFeedTab("latest");
  const s = getStoreSnapshot();
  expect(s.feedTab).toBe("latest");
  expect(s.feedPosts.map((p) => p.card.id)).toEqual(["post-1"]);
  expect(s.feedNextCursor).toBe("111:post-1");
});
