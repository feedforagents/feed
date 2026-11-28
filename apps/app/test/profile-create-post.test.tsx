// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { createPost, loadProfile } from "../src/web/store-world.ts";
import { makeRawPost, makeRawProfileBundle, makeViewerSession } from "./app-test-helpers.tsx";

const createdAt = Date.now() - 60_000;
const freshRaw = makeRawPost(Date.now(), { id: "alice-post-3", content: "Alice fresh call" });

const aliceViewer = makeViewerSession();

function stubFetch(profileHandle: string): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.endsWith("/api/posts") && method === "POST") {
      return Promise.resolve(Response.json(freshRaw));
    }
    if (url.startsWith(`/api/users/${profileHandle}`)) {
      const bundle =
        profileHandle === "alice"
          ? makeRawProfileBundle({
              handle: "alice",
              displayName: "Alice Player",
              createdAt,
              postsCount: 2,
              posts: [
                makeRawPost(createdAt, { id: "alice-post-1", content: "Alice first call" }),
                makeRawPost(createdAt, { id: "alice-post-2", content: "Alice second call" }),
              ],
            })
          : makeRawProfileBundle({
              handle: "bob",
              displayName: "Bob Builder",
              createdAt,
              postsCount: 1,
              posts: [makeRawPost(createdAt, { id: "bob-post-1", authorId: "bob", authorHandle: "bob", authorDisplayName: "Bob Builder" })],
            });
      return Promise.resolve(Response.json(bundle));
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

async function publishOnProfile(handle: string, expectedInitialCount: number) {
  stubFetch(handle);
  setStoreState({ viewer: aliceViewer, route: "Profile", profileHandle: handle });
  await loadProfile(handle);
  expect(getStoreSnapshot().profileBundle?.postsCount).toBe(expectedInitialCount);
  expect((await createPost("Alice fresh call")).kind).toBe("published");
  return getStoreSnapshot().profileBundle;
}

it('Publishing a post from the own profile shows it in the profile post list and header count (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const after = await publishOnProfile("alice", 2);
  expect(after?.posts.map((p) => p.card.id)).toEqual(["alice-post-3", "alice-post-1", "alice-post-2"]);
  expect(after?.postsCount).toBe(3);
});

it('Publishing a post while viewing another profile leaves that profile list and count unchanged (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const after = await publishOnProfile("bob", 1);
  expect(after?.posts.map((p) => p.card.id)).toEqual(["bob-post-1"]);
  expect(after?.postsCount).toBe(1);
});
