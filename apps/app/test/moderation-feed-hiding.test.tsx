// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { toggleBlock } from "../src/web/store-world.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

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

const aliceViewer = makeViewerSession({ balanceCents: 10_000, startingGrantCents: 10_000 });

function moderationPosts() {
  return {
    bobPost: rawPost({
      id: "bob-post",
      authorId: "bob",
      authorHandle: "bob",
      authorDisplayName: "Bob Trader",
      content: "Bob alpha call",
    }),
    carolRepostedByBob: rawPost({
      id: "carol-post",
      repostedByHandle: "bob",
      repostedByName: "Bob Trader",
    }),
    daveQuotingBob: rawPost({
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
    }),
    unrelated: rawPost({
      id: "erin-post",
      authorId: "erin",
      authorHandle: "erin",
      authorDisplayName: "Erin Fox",
      content: "Erin unrelated note",
    }),
  };
}

const ids = (list: ReadonlyArray<AppPost>) => list.map((p) => p.card.id);
const reposterOf = (list: ReadonlyArray<AppPost>, id: string) =>
  list.find((p) => p.card.id === id)?.card.repostedByHandle ?? null;
const quoteAuthorOf = (list: ReadonlyArray<AppPost>, id: string) =>
  list.find((p) => p.card.id === id)?.card.quotePost?.authorHandle ?? null;

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
  const { bobPost, carolRepostedByBob, daveQuotingBob, unrelated } = moderationPosts();

  setStoreState({
    viewer: aliceViewer,
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

  let feedCalls = 0;
  let resolveFeed: ((response: Response) => void) | undefined;
  vi.stubGlobal("fetch", (url: string) => {
    if (!url.includes("/api/feed")) return Promise.resolve(Response.json({ blocked: true }));
    feedCalls += 1;
    return new Promise<Response>((resolve) => {
      resolveFeed = resolve;
    });
  });

  await toggleBlock("bob", false);
  const beforeReload = getStoreSnapshot();
  expect({
    feed: ids(beforeReload.feedPosts),
    feedCarolReposter: reposterOf(beforeReload.feedPosts, "carol-post"),
    feedDaveQuoteAuthor: quoteAuthorOf(beforeReload.feedPosts, "dave-post"),
    feedCalls,
  }).toEqual({
    feed: ["carol-post", "dave-post", "erin-post"],
    feedCarolReposter: null,
    feedDaveQuoteAuthor: null,
    feedCalls: 1,
  });
  if (!resolveFeed) throw new Error("feed reload did not start");
  resolveFeed(Response.json({
    items: [
      { id: "carol-post", authorId: "carol", authorHandle: "carol", authorDisplayName: "Carol Analyst", content: "Carol market note", createdAt: Date.now() - 60_000 },
      { id: "erin-post", authorId: "erin", authorHandle: "erin", authorDisplayName: "Erin Fox", content: "Erin unrelated note", createdAt: Date.now() - 60_000 },
    ],
    nextCursor: null,
  }));
  await vi.waitFor(() => expect(getStoreSnapshot().feedLoading).toBe(false));

  const s = getStoreSnapshot();
  expect({
    feed: ids(s.feedPosts),
    feedCalls,
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
    feedCalls: 1,
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

it('Blocking an author on Latest cleans the Home feed without a reload and clears the blocked author profile and thread (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  const { bobPost, carolRepostedByBob, daveQuotingBob, unrelated } = moderationPosts();

  setStoreState({
    viewer: aliceViewer,
    feedTab: "latest",
    feedPosts: [bobPost, carolRepostedByBob, daveQuotingBob, unrelated],
    profileBundle: {
      summary: { displayName: "Bob Trader", handle: "bob", followersCount: 1, followingCount: 1 },
      id: "bob",
      kind: "user",
      postsCount: 2,
      createdAtMs: 0,
      actorMeta: null,
      orgMeta: null,
      viewerFollowedBy: false,
      viewerBlockedBy: false,
      tradeCount: null,
      openPositionCount: null,
      posts: [carolRepostedByBob, bobPost],
      postsNextCursor: null,
      positions: [],
    },
    profileReplies: [carolRepostedByBob, bobPost],
    activeThread: {
      post: bobPost,
      parentPost: unrelated,
      ancestors: [unrelated],
      replies: [carolRepostedByBob, daveQuotingBob],
    },
    blockedAccounts: [],
  });

  let feedCalls = 0;
  vi.stubGlobal("fetch", (url: string) => {
    if (url.includes("/api/feed")) feedCalls += 1;
    return Promise.resolve(Response.json({ blocked: true }));
  });

  await toggleBlock("bob", false);

  const s = getStoreSnapshot();
  expect({
    feed: ids(s.feedPosts),
    feedCarolReposter: reposterOf(s.feedPosts, "carol-post"),
    feedDaveQuoteAuthor: quoteAuthorOf(s.feedPosts, "dave-post"),
    feedCalls,
    profile: ids(s.profileBundle?.posts ?? []),
    profileReplies: ids(s.profileReplies),
    activeThread: s.activeThread?.post.card.id ?? null,
  }).toEqual({
    feed: ["carol-post", "dave-post", "erin-post"],
    feedCarolReposter: null,
    feedDaveQuoteAuthor: null,
    feedCalls: 0,
    profile: [],
    profileReplies: [],
    activeThread: null,
  });
});

it('Blocking an author hides their Explore people entries until the next search (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  setStoreState({
    viewer: aliceViewer,
    feedTab: "latest",
    explore: {
      ...getStoreSnapshot().explore,
      accounts: [
        { accountId: "bob", handle: "bob", displayName: "Bob Trader", bio: "", avatarUrl: null, viewerFollows: true },
        { accountId: "erin", handle: "erin", displayName: "Erin Fox", bio: "", avatarUrl: null, viewerFollows: false },
      ],
      actors: [
        { id: "bob", username: "bob", name: "Bob Trader", tier: "npc", description: "", avatarUrl: null, isParody: false, viewerFollows: true },
        { id: "erin", username: "erin", name: "Erin Fox", tier: "npc", description: "", avatarUrl: null, isParody: false, viewerFollows: false },
      ],
    },
    blockedAccounts: [],
  });

  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ blocked: true })));

  await toggleBlock("bob", false);

  const s = getStoreSnapshot();
  expect({
    accounts: s.explore.accounts.map((a) => a.handle),
    actors: s.explore.actors.map((a) => a.username),
  }).toEqual({
    accounts: ["erin"],
    actors: ["erin"],
  });
});
