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
  jsonPayload,
  makeProfileBundle,
  postRaw,
  resetModerationStore,
  stubFetchUrl,
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

function gateOn(match: (url: string) => boolean, payload: () => unknown) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/bob/mute")) return Promise.resolve(jsonPayload({ muted: true }));
    if (match(url)) return gate.then(() => jsonPayload(payload()));
    if (url.startsWith("/api/markets")) return Promise.resolve(jsonPayload({ predictions: [], perps: [] }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  return () => release();
}

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

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ profileLoading: false, profileLoadingMore: false, profileRepliesLoading: false, profileLikesLoading: false, errorMessage: null, mutedAccounts: [] });
});

it(`Muting a profile owner keeps their posts out of the profile when an in-flight profile load lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("bob");
  const release = gateOn(
    (url) => url.includes("/api/users/bob") && !url.includes("cursor"),
    () =>
      makeRawProfileBundle({
        handle: "bob",
        displayName: "Bob Trader",
        createdAt,
        postsCount: 2,
        posts: [bobPostRaw, bobSecondRaw],
      }),
  );
  const inFlight = loadProfile("bob");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const bundle = getStoreSnapshot().profileBundle;
  expect({ posts: bundle?.posts.map((p) => p.card.id), loading: getStoreSnapshot().profileLoading }).toEqual({
    posts: [],
    loading: false,
  });
});

it(`Muting an author strips their quote from profile replies that land after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("erin");
  setStoreState({ profileBundle: { ...makeProfileBundle("erin", "Erin Fox", 0, 0, false) } });
  const release = gateOn(
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
  const release = gateOn(
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
  const release = gateOn(
    (url) => url.includes("/api/users/bob") && url.includes("cursor="),
    () =>
      makeRawProfileBundle({
        handle: "bob",
        displayName: "Bob Trader",
        createdAt,
        postsCount: 2,
        posts: [bobSecondRaw],
      }),
  );
  const inFlight = loadMoreProfilePosts();
  await toggleMute("bob", false);
  release();
  await inFlight;
  const s = getStoreSnapshot();
  expect({ posts: s.profileBundle?.posts.map((p) => p.card.id), loadingMore: s.profileLoadingMore }).toEqual({
    posts: [],
    loadingMore: false,
  });
});

it(`Profile likes that land before any mute keep the author's posts (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedProfile("erin");
  setStoreState({ profileBundle: { ...makeProfileBundle("erin", "Erin Fox", 0, 0, false) } });
  stubFetchUrl((url) => {
    if (url.includes("/api/users/erin/likes")) {
      return Promise.resolve(jsonPayload({ items: [bobPostRaw, erinPostRaw], nextCursor: null }));
    }
    if (url.startsWith("/api/markets")) return Promise.resolve(jsonPayload({ predictions: [], perps: [] }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  await loadProfileLikes("erin");
  expect(getStoreSnapshot().profileLikes.map((p) => p.card.id)).toEqual(["bob-post", "erin-post"]);
});
