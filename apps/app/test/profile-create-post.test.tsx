// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { createPost, loadProfile } from "../src/web/store-world.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

const createdAt = Date.now() - 60_000;

function rawPost(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "post-x",
    authorId: "alice",
    authorKind: "user",
    authorHandle: "alice",
    authorDisplayName: "Alice Player",
    content: "Alice market note",
    replyToPostId: null,
    quotePostId: null,
    quotePost: null,
    repostedByHandle: null,
    repostedByName: null,
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt,
    ...overrides,
  };
}

const firstRaw = rawPost({ id: "alice-post-1", content: "Alice first call" });
const secondRaw = rawPost({ id: "alice-post-2", content: "Alice second call" });
const freshRaw = rawPost({ id: "alice-post-3", content: "Alice fresh call", createdAt: Date.now() });

function profileRaw(handle: string, postsCount: number, posts: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
  return {
    profile: {
      id: handle,
      kind: "user",
      handle,
      displayName: handle === "alice" ? "Alice Player" : "Bob Builder",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt,
      followersCount: 0,
      followingCount: 0,
      postsCount,
      viewerFollows: false,
      viewerFollowedBy: false,
      viewerBlocks: false,
      viewerBlockedBy: false,
      viewerMutes: false,
      isParody: false,
    },
    posts,
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  };
}

const aliceViewer = makeViewerSession();

function stubFetch(profileHandle: string): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/posts") && method === "POST") {
      return Promise.resolve(Response.json(freshRaw));
    }
    if (url.startsWith(`/api/users/${profileHandle}`)) {
      return Promise.resolve(
        Response.json(
          profileHandle === "alice"
            ? profileRaw("alice", 2, [firstRaw, secondRaw])
            : profileRaw("bob", 1, [rawPost({ id: "bob-post-1", authorId: "bob", authorHandle: "bob", authorDisplayName: "Bob Builder" })]),
        ),
      );
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
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
    profileLikes: [],
  });
});

it('Publishing a post from the own profile shows it in the profile post list and header count (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  stubFetch("alice");
  setStoreState({ viewer: aliceViewer, route: "Profile", profileHandle: "alice" });
  await loadProfile("alice");
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(2);

  const ok = await createPost("Alice fresh call");
  expect(ok).toBe(true);

  const after = getStoreSnapshot().profileBundle;
  expect(after?.posts.map((p) => p.card.id)).toEqual(["alice-post-3", "alice-post-1", "alice-post-2"]);
  expect(after?.postsCount).toBe(3);
});

it('Publishing a post while viewing another profile leaves that profile list and count unchanged (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  stubFetch("bob");
  setStoreState({ viewer: aliceViewer, route: "Profile", profileHandle: "bob" });
  await loadProfile("bob");
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(1);

  const ok = await createPost("Alice fresh call");
  expect(ok).toBe(true);

  const after = getStoreSnapshot().profileBundle;
  expect(after?.posts.map((p) => p.card.id)).toEqual(["bob-post-1"]);
  expect(after?.postsCount).toBe(1);
});
