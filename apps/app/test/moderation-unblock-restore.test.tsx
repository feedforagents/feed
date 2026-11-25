// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfile, toggleBlock } from "../src/web/store-world.ts";
import {
  aliceViewer,
  bobPostRaw as bobRaw,
  carolRepostedByBobRaw as carolRaw,
  daveQuotingBobRaw as daveRaw,
  decodedPost,
  erinPostRaw as erinRaw,
  postRaw,
  resetModerationStore,
} from "./moderation-fixtures.ts";

const bobReplyRaw = postRaw({
  id: "bob-reply",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob reply",
  replyToPostId: "carol-post",
});
const fullFeedRaw = [bobRaw, carolRaw, daveRaw, erinRaw];

function profileRaw(handle: string, blocked: boolean): Record<string, unknown> {
  return {
    profile: {
      id: handle,
      kind: "user",
      handle,
      displayName: handle === "bob" ? "Bob Trader" : "Carol Analyst",
      bio: "",
      avatarUrl: null,
      bannerUrl: null,
      createdAt: Date.now() - 60_000,
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
    posts: blocked ? [] : handle === "bob" ? [bobRaw, carolRaw] : [carolRaw],
    nextCursor: null,
    positions: { predictionPositions: [], perpPositions: [] },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
});

it('Unblocking an author restores their posts, repost attribution, and quoted content in the loaded feed and profile (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  let serverBlocked = false;
  let feedGate: Promise<void> | null = null;
  let releaseFeed: () => void = () => {};
  let bobProfileRequests = 0;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/users/bob/block")) {
      serverBlocked = method !== "DELETE";
      return Promise.resolve(Response.json({ blocked: serverBlocked }));
    }
    if (url.startsWith("/api/feed")) {
      const respond = () => Response.json({ items: serverBlocked ? [erinRaw] : fullFeedRaw, nextCursor: null });
      return feedGate ? feedGate.then(respond) : Promise.resolve(respond());
    }
    if (url.startsWith("/api/users/bob")) {
      bobProfileRequests += 1;
      return Promise.resolve(Response.json(profileRaw("bob", serverBlocked)));
    }
    if (url.startsWith("/api/users/carol")) {
      return Promise.resolve(Response.json(profileRaw("carol", false)));
    }
    if (url.startsWith("/api/posts")) {
      return Promise.resolve(Response.json({ items: serverBlocked ? [] : [bobReplyRaw], nextCursor: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: aliceViewer,
    route: "Home",
    feedTab: "latest",
    feedPosts: fullFeedRaw.map(decodedPost),
    blockedAccounts: [],
  });

  await toggleBlock("bob", false);
  setStoreState({ route: "Profile", profileHandle: "bob" });
  await loadProfile("bob");
  await toggleBlock("bob", true);

  const restored = getStoreSnapshot();
  await toggleBlock("bob", false);
  feedGate = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  const unblock = toggleBlock("bob", true);
  await loadProfile("carol");
  releaseFeed();
  await unblock;

  const after = getStoreSnapshot();
  setStoreState({ route: "Settings", profileHandle: "bob" });
  const bobRequestsBeforeSettingsUnblock = bobProfileRequests;
  await toggleBlock("bob", false);
  await toggleBlock("bob", true);
  const settingsUnblockBobRequests = bobProfileRequests - bobRequestsBeforeSettingsUnblock;
  expect({
    feedIds: restored.feedPosts.map((p) => p.card.id),
    carolReposter: restored.feedPosts.find((p) => p.card.id === "carol-post")?.card.repostedByHandle ?? null,
    daveQuoteAuthor: restored.feedPosts.find((p) => p.card.id === "dave-post")?.card.quotePost?.authorHandle ?? null,
    profilePostIds: restored.profileBundle?.posts.map((p) => p.card.id) ?? null,
    profileReplyIds: restored.profileReplies.map((p) => p.card.id),
    profileBlocked: restored.profileBundle?.summary.isBlocked ?? null,
    navigatedProfileHandle: after.profileHandle,
    navigatedProfile: after.profileBundle?.summary.handle ?? null,
    navigatedFeedIds: after.feedPosts.map((p) => p.card.id),
    settingsUnblockBobRequests,
  }).toEqual({
    feedIds: ["bob-post", "carol-post", "dave-post", "erin-post"],
    carolReposter: "bob",
    daveQuoteAuthor: "bob",
    profilePostIds: ["bob-post", "carol-post"],
    profileReplyIds: ["bob-reply"],
    profileBlocked: false,
    navigatedProfileHandle: "carol",
    navigatedProfile: "carol",
    navigatedFeedIds: ["bob-post", "carol-post", "dave-post", "erin-post"],
    settingsUnblockBobRequests: 0,
  });
});
