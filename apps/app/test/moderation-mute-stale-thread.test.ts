// @vitest-environment happy-dom
// spec/social/moderation.md, "Muting hides an author's feed content without removing follows"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { openThread, toggleMute } from "../src/web/store-world.ts";
import {
  bobPostRaw,
  daveQuotingBobRaw,
  erinPostRaw,
  jsonPayload,
  postRaw,
  resetModerationStore,
  resetWorldFeedStore,
  stubFetchUrl,
} from "./moderation-fixtures.ts";

const carolPostRaw = postRaw({ id: "carol-post", content: "Carol parent note", replyCount: 3 });
const bobReplyRaw = postRaw({
  id: "bob-reply",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Trader",
  content: "Bob reply",
  replyToPostId: "carol-post",
});
const erinReplyRaw = postRaw({
  id: "erin-reply",
  authorId: "erin",
  authorHandle: "erin",
  authorDisplayName: "Erin Fox",
  content: "Erin reply",
  replyToPostId: "carol-post",
});
const daveReplyQuotingBobRaw = { ...daveQuotingBobRaw, replyToPostId: "carol-post" };
const erinChildRaw = { ...erinPostRaw, id: "erin-child", replyToPostId: "bob-post" };

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

function seedThread() {
  resetWorldFeedStore({ route: "PostDetail", activeThread: null, activePostId: null, threadLoading: false });
  setStoreState({ mutedAccounts: [], errorMessage: null });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ threadLoading: false, activeThread: null, activePostId: null, errorMessage: null, mutedAccounts: [] });
});

it(`Muting an author keeps their replies out of a thread that lands after the mute and strips their quote from landed replies (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedThread();
  const release = gateOn(
    (url) => url.includes("/api/posts/carol-post"),
    () => ({
      post: carolPostRaw,
      parentPost: null,
      ancestors: [],
      replies: [bobReplyRaw, erinReplyRaw, daveReplyQuotingBobRaw],
    }),
  );
  const inFlight = openThread("carol-post");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const thread = getStoreSnapshot().activeThread;
  expect(thread?.replies.map((r) => r.card.id)).toEqual(["erin-reply", "dave-post"]);
  expect(thread?.replies[1]?.card.quotePost).toBeUndefined();
  expect(getStoreSnapshot().threadLoading).toBe(false);
});

it(`Muting the parent author drops the parent post from a thread that lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedThread();
  const release = gateOn(
    (url) => url.includes("/api/posts/erin-child"),
    () => ({
      post: erinChildRaw,
      parentPost: bobPostRaw,
      ancestors: [],
      replies: [],
    }),
  );
  const inFlight = openThread("erin-child");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const thread = getStoreSnapshot().activeThread;
  expect(thread?.post.card.id).toBe("erin-child");
  expect(thread?.parentPost).toBeNull();
});

it(`Muting the thread author closes a thread that lands after the mute (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedThread();
  const release = gateOn(
    (url) => url.includes("/api/posts/bob-post"),
    () => ({
      post: bobPostRaw,
      parentPost: null,
      ancestors: [],
      replies: [erinReplyRaw],
    }),
  );
  const inFlight = openThread("bob-post");
  await toggleMute("bob", false);
  release();
  await inFlight;
  const s = getStoreSnapshot();
  expect({ thread: s.activeThread, loading: s.threadLoading }).toEqual({ thread: null, loading: false });
});

it(`A thread that lands before any mute keeps the author's replies (spec/social/moderation.md, "Muting hides an author's feed content without removing follows")`, async () => {
  seedThread();
  stubFetchUrl((url) => {
    if (url.includes("/api/posts/carol-post")) {
      return Promise.resolve(jsonPayload({
        post: carolPostRaw,
        parentPost: null,
        ancestors: [],
        replies: [bobReplyRaw, erinReplyRaw],
      }));
    }
    if (url.startsWith("/api/markets")) return Promise.resolve(jsonPayload({ predictions: [], perps: [] }));
    return Promise.resolve(jsonPayload({}, 404));
  });
  await openThread("carol-post");
  expect(getStoreSnapshot().activeThread?.replies.map((r) => r.card.id)).toEqual(["bob-reply", "erin-reply"]);
});
