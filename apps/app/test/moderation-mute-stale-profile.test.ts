// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMoreProfilePosts, loadProfile, loadProfileLikes, loadProfileReplies, toggleMute } from "../src/web/store-world.ts";
import { makeRawProfileBundle } from "./app-test-helpers.tsx";
import {
  aliceViewer,
  bobPostRaw,
  carolRepostedByBobRaw,
  decodedPost,
  erinPostRaw,
  gateFetchOn,
  makeProfileBundle,
  postRaw,
  resetModerationStore,
  stubFetchOn,
} from "./moderation-fixtures.ts";

const createdAt = Date.now() - 60_000;

const bobSecondRaw = postRaw({
  id: "bob-post-2",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob second call",
});

const erinReplyQuotingBobRaw = postRaw({
  id: "erin-reply-quote",
  authorId: "erin",
  authorHandle: "erin",
  authorDisplayName: "Erin Fox",
  content: "Erin replying with a quote",
  replyToPostId: "carol-post",
  quotePostId: "bob-post",
  quotePost: {
    id: "bob-post",
    authorHandle: "bob",
    authorDisplayName: "Bob Trader",
    content: "Bob alpha call",
  },
});

const erinReplyRaw = postRaw({
  id: "erin-reply",
  authorId: "erin",
  authorHandle: "erin",
  authorDisplayName: "Erin Fox",
  content: "Erin plain reply",
  replyToPostId: "carol-post",
});

function seedProfile(handle: string) {
  setStoreState({
    viewer: aliceViewer,
    route: "Profile",
    feedTab: "latest",
    profileHandle: handle,
    profileBundle: null,
    profileReplies: [],
    profileLikes: [],
    mutedAccounts: [],
    errorMessage: null,
  });
}

function bobProfileBundle(posts: ReadonlyArray<Record<string, unknown>>) {
  return makeRawProfileBundle({
    handle: "bob",
    displayName: "Bob Trader",
    createdAt,
    postsCount: 2,
    posts,
  });
}

async function muteBobWhileInFlight(
  match: (url: string) => boolean,
  payload: () => unknown,
  startRequest: () => Promise<void>,
): Promise<void> {
  const release = gateFetchOn(match, payload);
  const inFlight = startRequest();
  await toggleMute("bob", false);
  release();
  await inFlight;
}

function expectProfilePosts(ids: ReadonlyArray<string>, loading: boolean): void {
  const bundle = getStoreSnapshot().profileBundle;
  expect({ posts: bundle?.posts.map((p) => p.card.id), loading: getStoreSnapshot().profileLoading }).toEqual({
    posts: ids,
    loading,
  });
}

function expectProfilePostsLoadingMore(ids: ReadonlyArray<string>, loadingMore: boolean): void {
  const s = getStoreSnapshot();
  expect({ posts: s.profileBundle?.posts.map((p) => p.card.id), loadingMore: s.profileLoadingMore }).toEqual({
    posts: ids,
    loadingMore,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ profileLoading: false, profileLoadingMore: false, profileRepliesLoading: false, profileLikesLoading: false, errorMessage: null, mutedAccounts: [] });
});

it(`Muting a profile owner keeps their posts out of the profile when an in-flight profile load lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("bob");
  await muteBobWhileInFlight(
    (url) => url.includes("/api/users/bob") && !url.includes("cursor"),
    () => bobProfileBundle([bobPostRaw, bobSecondRaw]),
    () => loadProfile("bob"),
  );
  expectProfilePosts([], false);
});

it(`Muting a profile owner drops a post they reposted when an in-flight profile load lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("bob");
  await muteBobWhileInFlight(
    (url) => url.includes("/api/users/bob") && !url.includes("cursor"),
    () => bobProfileBundle([carolRepostedByBobRaw, erinPostRaw]),
    () => loadProfile("bob"),
  );
  expectProfilePosts(["erin-post"], false);
});

it(`Muting an author strips their quote from profile replies that land after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("erin");
  setStoreState({ profileBundle: { ...makeProfileBundle("erin", "Erin Fox", 0, 0, false) } });
  const release = gateFetchOn(
    (url) => url.includes("filter=replies"),
    () => ({ items: [erinReplyQuotingBobRaw, erinReplyRaw], nextCursor: null }),
  );
  const inFlight = loadProfileReplies("erin");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const replies = getStoreSnapshot().profileReplies;
  expect(replies.map((p) => p.card.id)).toEqual(["erin-reply-quote", "erin-reply"]);
  expect(replies[0]?.card.quotePost).toBeUndefined();
});

it(`Muting an author keeps their posts out of profile likes that land after the mute and strips their repost credit (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("erin");
  setStoreState({ profileBundle: { ...makeProfileBundle("erin", "Erin Fox", 0, 0, false) } });
  const release = gateFetchOn(
    (url) => url.includes("/api/users/erin/likes"),
    () => ({ items: [bobPostRaw, carolRepostedByBobRaw, erinPostRaw], nextCursor: null }),
  );
  const inFlight = loadProfileLikes("erin");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const likes = getStoreSnapshot().profileLikes;
  expect(likes.map((p) => p.card.id)).toEqual(["carol-post", "erin-post"]);
  expect(likes[0]?.card.repostedBy).toBeUndefined();
  expect(likes[0]?.card.repostedByHandle).toBeUndefined();
});

it(`Muting a profile owner keeps the next page out when an in-flight load-more lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("bob");
  setStoreState({
    profileBundle: {
      ...makeProfileBundle("bob", "Bob Trader", 0, 0, false),
      posts: [decodedPost(bobPostRaw)],
      postsNextCursor: "cursor-2",
    },
  });
  await muteBobWhileInFlight(
    (url) => url.includes("/api/users/bob") && url.includes("cursor="),
    () => bobProfileBundle([bobSecondRaw]),
    () => loadMoreProfilePosts(),
  );
  expectProfilePostsLoadingMore([], false);
});

it(`Muting a profile owner drops a post they reposted when an in-flight load-more lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("bob");
  setStoreState({
    profileBundle: {
      ...makeProfileBundle("bob", "Bob Trader", 0, 0, false),
      posts: [decodedPost(erinPostRaw)],
      postsNextCursor: "cursor-2",
    },
  });
  await muteBobWhileInFlight(
    (url) => url.includes("/api/users/bob") && url.includes("cursor="),
    () => bobProfileBundle([carolRepostedByBobRaw, bobSecondRaw]),
    () => loadMoreProfilePosts(),
  );
  expectProfilePostsLoadingMore(["erin-post"], false);
});

it(`Profile likes that land before any mute keep the author's posts (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("erin");
  setStoreState({ profileBundle: { ...makeProfileBundle("erin", "Erin Fox", 0, 0, false) } });
  stubFetchOn(
    (url) => url.includes("/api/users/erin/likes"),
    () => ({ items: [bobPostRaw, erinPostRaw], nextCursor: null }),
  );
  await loadProfileLikes("erin");
  expect(getStoreSnapshot().profileLikes.map((p) => p.card.id)).toEqual(["bob-post", "erin-post"]);
});
