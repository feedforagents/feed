// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";

export const aliceViewer = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice Player",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
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

export function decodedPost(raw: Record<string, unknown>): AppPost {
  const post = decodePost(raw, "alice");
  if (!post) throw new Error("decode failed");
  return post;
}

export function resetModerationStore(): void {
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
