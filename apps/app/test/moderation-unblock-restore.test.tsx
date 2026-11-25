// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile, toggleBlock } from "../src/web/store-world.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";

const createdAt = Date.now() - 60_000;

function rawPost(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "post-x",
    authorId: "carol",
    authorKind: "user",
    authorHandle: "carol",
    authorDisplayName: "Carol Analyst",
    content: "Carol market note",
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

function decoded(raw: Record<string, unknown>): AppPost {
  const post = decodePost(raw, "alice");
  if (!post) throw new Error("decode failed");
  return post;
}

const bobRaw = rawPost({
  id: "bob-post",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob alpha call",
});
const carolRaw = rawPost({
  id: "carol-post",
  repostedByHandle: "bob",
  repostedByName: "Bob Trader",
});
const daveRaw = rawPost({
  id: "dave-post",
  authorId: "dave",
  authorHandle: "dave",
  authorDisplayName: "Dave Quant",
  content: "Dave quoting Bob",
  quotePostId: "bob-post",
  quotePost: {
    id: "bob-post",
    authorHandle: "bob",
    authorDisplayName: "Bob Trader",
    content: "Bob alpha call",
  },
});
const erinRaw = rawPost({
  id: "erin-post",
  authorId: "erin",
  authorHandle: "erin",
  authorDisplayName: "Erin Fox",
  content: "Erin unrelated note",
});
const fullFeedRaw = [bobRaw, carolRaw, daveRaw, erinRaw];

function profileRaw(blocked: boolean): Record<string, unknown> {
  return {
    profile: {
      id: "bob",
      kind: "user",
      handle: "bob",
      displayName: "Bob Trader",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt,
      followersCount: 0,
      followingCount: 0,
      postsCount: 2,
      viewerFollows: false,
      viewerFollowedBy: false,
      viewerBlocks: blocked,
      viewerBlockedBy: false,
      viewerMutes: false,
      isParody: false,
    },
    posts: blocked ? [] : [bobRaw, carolRaw],
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    viewer: null,
    route: "Home",
    feedTab: "latest",
    feedPosts: [],
    profileBundle: null,
    profileHandle: null,
    profileReplies: [],
    blockedAccounts: [],
  });
});

it('Unblocking an author restores their posts, repost attribution, and quoted content in the loaded feed and profile (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  let serverBlocked = false;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/users/bob/block")) {
      serverBlocked = method !== "DELETE";
      return Promise.resolve(Response.json({ blocked: serverBlocked }));
    }
    if (url.startsWith("/api/feed")) {
      return Promise.resolve(Response.json({ items: serverBlocked ? [erinRaw] : fullFeedRaw, nextCursor: null }));
    }
    if (url.startsWith("/api/users/bob")) {
      return Promise.resolve(Response.json(profileRaw(serverBlocked)));
    }
    if (url.startsWith("/api/posts")) {
      return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: {
      accountId: "alice",
      handle: "alice",
      displayName: "Alice Player",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      phoneLast2: null,
      uiMode: "game",
      balanceCents: 10_000,
      startingGrantCents: 10_000,
      isAdmin: false,
      isReviewer: false,
      agentGrant: null,
    },
    route: "Home",
    feedTab: "latest",
    feedPosts: fullFeedRaw.map(decoded),
    blockedAccounts: [],
  });

  await toggleBlock("bob", false);
  setStoreState({ route: "Profile", profileHandle: "bob" });
  await loadProfile("bob");
  await toggleBlock("bob", true);

  const after = getStoreSnapshot();
  expect({
    feedIds: after.feedPosts.map((p) => p.card.id),
    carolReposter: after.feedPosts.find((p) => p.card.id === "carol-post")?.card.repostedByHandle ?? null,
    daveQuoteAuthor: after.feedPosts.find((p) => p.card.id === "dave-post")?.card.quotePost?.authorHandle ?? null,
    profilePostIds: after.profileBundle?.posts.map((p) => p.card.id) ?? null,
    profileBlocked: after.profileBundle?.summary.isBlocked ?? null,
  }).toEqual({
    feedIds: ["bob-post", "carol-post", "dave-post", "erin-post"],
    carolReposter: "bob",
    daveQuoteAuthor: "bob",
    profilePostIds: ["bob-post", "carol-post"],
    profileBlocked: false,
  });
});
