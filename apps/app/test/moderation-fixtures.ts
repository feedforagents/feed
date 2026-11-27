// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { clearAuthorHides } from "../src/web/store-world.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";

export const aliceViewer = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice Player",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game" as const,
  balanceCents: 10_000,
  startingGrantCents: 10_000,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

export function postRaw(overrides: Record<string, unknown>): Record<string, unknown> {
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
    createdAt: Date.now() - 60_000,
    ...overrides,
  };
}

export const bobPostRaw = postRaw({
  id: "bob-post",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob alpha call",
});
export const carolRepostedByBobRaw = postRaw({
  id: "carol-post",
  repostedByHandle: "bob",
  repostedByName: "Bob Trader",
});
export const daveQuotingBobRaw = postRaw({
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
export const erinPostRaw = postRaw({
  id: "erin-post",
  authorId: "erin",
  authorHandle: "erin",
  authorDisplayName: "Erin Fox",
  content: "Erin unrelated note",
});

export function decodedPost(raw: Record<string, unknown>): AppPost {
  const post = decodePost(raw, "alice");
  if (!post) throw new Error("decode failed");
  return post;
}

export function resetModerationStore(): void {
  clearAuthorHides();
  setStoreState({
    viewer: null,
    route: "Home",
    feedTab: "latest",
    feedPosts: [],
    explore: { ...getStoreSnapshot().explore, posts: [] },
    profileBundle: null,
    profileHandle: null,
    profileReplies: [],
    marketSocialPosts: [],
    activeThread: null,
    blockedAccounts: [],
  });
}

export function jsonPayload(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function stubFetchUrl(handler: (url: string) => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }));
}

export function resetWorldFeedStore(
  overrides: Parameters<typeof setStoreState>[0],
): void {
  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: [],
    feedLoading: false,
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [], tags: [] },
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    marketSocialPosts: [],
    activeThread: null,
    activePostId: null,
    ...overrides,
  });
}

export function makeProfileBundle(
  handle: string,
  displayName: string,
  followersCount: number,
  followingCount: number,
  isOwnProfile: boolean,
) {
  return {
    summary: {
      displayName,
      handle,
      followersCount,
      followingCount,
      isFollowing: false,
      isMuted: false,
      isBlocked: false,
      isOwnProfile,
    },
    id: handle,
    kind: "user" as const,
    postsCount: 0,
    createdAtMs: 0,
    actorMeta: null,
    orgMeta: null,
    viewerFollowedBy: false,
    viewerBlockedBy: false,
    tradeCount: null,
    openPositionCount: null,
    posts: [],
    postsNextCursor: null,
    positions: [],
  };
}
