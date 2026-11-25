// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleBlock } from "../src/web/store-world.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";

function rawPost(overrides: Record<string, unknown>): AppPost {
  const post = decodePost({
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
  }, "alice");
  if (!post) throw new Error("decode failed");
  return post;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({
    viewer: null,
    feedTab: "latest",
    feedPosts: [],
    explore: { ...getStoreSnapshot().explore, posts: [] },
    profileBundle: null,
    profileReplies: [],
    marketSocialPosts: [],
    activeThread: null,
    blockedAccounts: [],
  });
});

it('Blocking an author hides their posts, reposts, and quoted content from loaded feeds, profile, thread, and market lists (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const bobPost = rawPost({
    id: "bob-post",
    authorId: "bob",
    authorHandle: "bob",
    authorDisplayName: "Bob Trader",
    content: "Bob alpha call",
  });
  const carolRepostedByBob = rawPost({
    id: "carol-post",
    repostedByHandle: "bob",
    repostedByName: "Bob Trader",
  });
  const daveQuotingBob = rawPost({
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
  const unrelated = rawPost({
    id: "erin-post",
    authorId: "erin",
    authorHandle: "erin",
    authorDisplayName: "Erin Fox",
    content: "Erin unrelated note",
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
    feedTab: "following",
    feedPosts: [bobPost, carolRepostedByBob, daveQuotingBob, unrelated],
    explore: { ...getStoreSnapshot().explore, posts: [bobPost, carolRepostedByBob, daveQuotingBob, unrelated] },
    profileBundle: {
      summary: { displayName: "Carol Analyst", handle: "carol", followersCount: 1, followingCount: 1 },
      id: "carol",
      kind: "user",
      postsCount: 3,
      createdAtMs: 0,
      actorMeta: null,
      orgMeta: null,
      viewerFollowedBy: false,
      viewerBlockedBy: false,
      tradeCount: null,
      openPositionCount: null,
      posts: [bobPost, carolRepostedByBob, daveQuotingBob],
      postsNextCursor: null,
      positions: [],
    },
    profileReplies: [bobPost, daveQuotingBob],
    marketSocialPosts: [bobPost, carolRepostedByBob, unrelated],
    activeThread: {
      post: daveQuotingBob,
      parentPost: bobPost,
      ancestors: [bobPost, unrelated],
      replies: [bobPost, daveQuotingBob, unrelated],
    },
    blockedAccounts: [],
  });

  vi.stubGlobal("fetch", (url: string) =>
    Promise.resolve(url.includes("/api/feed")
      ? Response.json({
          items: [
            { id: "carol-post", authorId: "carol", authorHandle: "carol", authorDisplayName: "Carol Analyst", content: "Carol market note", createdAt: Date.now() - 60_000 },
            { id: "erin-post", authorId: "erin", authorHandle: "erin", authorDisplayName: "Erin Fox", content: "Erin unrelated note", createdAt: Date.now() - 60_000 },
          ],
          nextCursor: null,
        })
      : Response.json({ blocked: true })));

  await toggleBlock("bob", false);
  await vi.waitFor(() => expect(getStoreSnapshot().feedLoading).toBe(false));

  const s = getStoreSnapshot();
  const ids = (list: ReadonlyArray<AppPost>) => list.map((p) => p.card.id);
  const reposterOf = (list: ReadonlyArray<AppPost>, id: string) =>
    list.find((p) => p.card.id === id)?.card.repostedByHandle ?? null;
  const quoteAuthorOf = (list: ReadonlyArray<AppPost>, id: string) =>
    list.find((p) => p.card.id === id)?.card.quotePost?.authorHandle ?? null;
  expect({
    feed: ids(s.feedPosts),
    explore: ids(s.explore.posts),
    exploreCarolReposter: reposterOf(s.explore.posts, "carol-post"),
    exploreDaveQuoteAuthor: quoteAuthorOf(s.explore.posts, "dave-post"),
    profile: ids(s.profileBundle?.posts ?? []),
    profileReplies: ids(s.profileReplies),
    market: ids(s.marketSocialPosts),
    marketCarolReposter: reposterOf(s.marketSocialPosts, "carol-post"),
    threadRootQuoteAuthor: s.activeThread?.post.card.quotePost?.authorHandle ?? null,
    threadParent: s.activeThread?.parentPost?.card.id ?? null,
    ancestors: ids(s.activeThread?.ancestors ?? []),
    replies: ids(s.activeThread?.replies ?? []),
    repliesDaveQuoteAuthor: quoteAuthorOf(s.activeThread?.replies ?? [], "dave-post"),
  }).toEqual({
    feed: ["carol-post", "erin-post"],
    explore: ["carol-post", "dave-post", "erin-post"],
    exploreCarolReposter: null,
    exploreDaveQuoteAuthor: null,
    profile: ["carol-post", "dave-post"],
    profileReplies: ["dave-post"],
    market: ["carol-post", "erin-post"],
    marketCarolReposter: null,
    threadRootQuoteAuthor: null,
    threadParent: null,
    ancestors: ["erin-post"],
    replies: ["dave-post", "erin-post"],
    repliesDaveQuoteAuthor: null,
  });
});
