// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { reconnectRealtime } from "../src/web/store.ts";
import { repostPost } from "../src/web/store-world.ts";
import { decodePost } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { postRaw } from "./moderation-fixtures.ts";

const viewer = makeViewerSession();

function decoded(raw: Record<string, unknown>) {
  const post = decodePost(raw, "alice");
  if (post === null) throw new Error("test fixture must decode");
  return post;
}

const basePost = decoded(postRaw({ id: "post-1", repostCount: 3, repostedByViewer: false }));

let releaseRepost: ((response: Response) => void) | null = null;

class StubEventSource extends EventTarget {
  static latest: StubEventSource | null = null;
  constructor() {
    super();
    StubEventSource.latest = this;
  }
  close() {}
}

function errorResponse(message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  releaseRepost = null;
  vi.stubGlobal("EventSource", StubEventSource);
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/api/posts/post-1/repost")) {
      return new Promise<Response>((resolve) => { releaseRepost = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }));
  }));
  setStoreState({
    viewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [basePost],
    feedLoading: false,
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
  StubEventSource.latest?.close();
  StubEventSource.latest = null;
  vi.unstubAllGlobals();
});

it("keeps a live repost count that landed while the repost request was in flight when the repost then fails (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  reconnectRealtime();
  const toggle = repostPost("post-1");
  StubEventSource.latest?.dispatchEvent(
    new MessageEvent("post.engagement", {
      data: JSON.stringify({ type: "post.engagement", postId: "post-1", kind: "repost", likeCount: 0, repostCount: 7 }),
    }),
  );
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  releaseRepost?.(errorResponse("Repost failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(7);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});

it("restores the pre-click repost count when the repost fails with no live engagement in between (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const toggle = repostPost("post-1");
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(true);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(4);
  releaseRepost?.(errorResponse("Repost failed"));
  await toggle;
  expect(getStoreSnapshot().feedPosts[0]?.card.reposted).toBe(false);
  expect(getStoreSnapshot().feedPosts[0]?.card.repostCount).toBe(3);
  expect(getStoreSnapshot().errorMessage).toBe("Repost failed");
});
