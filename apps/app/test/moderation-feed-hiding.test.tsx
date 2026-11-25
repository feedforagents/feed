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
  setStoreState({ viewer: null, feedPosts: [], blockedAccounts: [] });
});

it('Blocking an author hides their posts, reposts, and quoted content from the loaded Home feed (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
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
    feedPosts: [bobPost, carolRepostedByBob, daveQuotingBob, unrelated],
    blockedAccounts: [],
  });

  vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ blocked: true })));

  await toggleBlock("bob", false);

  const after = getStoreSnapshot().feedPosts;
  expect({
    ids: after.map((p) => p.card.id),
    daveQuoteAuthor: after.find((p) => p.card.id === "dave-post")?.card.quotePost?.authorHandle ?? null,
  }).toEqual({ ids: ["dave-post", "erin-post"], daveQuoteAuthor: null });
});
