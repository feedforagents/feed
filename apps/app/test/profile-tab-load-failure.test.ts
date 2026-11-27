// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfileLikes, loadProfileReplies, loadProfileTrades } from "../src/web/store-world.ts";
import { aliceViewer, postRaw, resetModerationStore } from "./moderation-fixtures.ts";

function bobBundle() {
  return {
    summary: {
      displayName: "Bob Trader",
      handle: "bob",
      followersCount: 6,
      followingCount: 4,
      isFollowing: false,
      isMuted: false,
      isBlocked: false,
      isOwnProfile: false,
    },
    id: "bob",
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

function openBobProfile() {
  setStoreState({
    viewer: aliceViewer,
    profileBundle: bobBundle(),
    profileHandle: "bob",
    route: "Profile",
    errorMessage: null,
    toasts: [],
  });
}

function stubFetch(handler: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url);
  });
}

function failedResponse(message: string) {
  return Promise.resolve(Response.json({ message }, { status: 500 }));
}

function expectFailureNotice(message: string): void {
  const current = getStoreSnapshot();
  expect(current.errorMessage).toBe(message);
  expect(current.toasts.some((t) => t.tone === "destructive" && t.message === message)).toBe(true);
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ errorMessage: null, toasts: [], profileLikes: [], profileTrades: [] });
});

it('A failed Replies tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetch(() => failedResponse("Replies unavailable"));

  await loadProfileReplies("bob");

  expect(getStoreSnapshot().profileRepliesLoading).toBe(false);
  expect(getStoreSnapshot().profileReplies).toEqual([]);
  expectFailureNotice("Replies unavailable");
});

it('A failed Likes tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetch(() => failedResponse("Likes unavailable"));

  await loadProfileLikes("bob");

  expect(getStoreSnapshot().profileLikesLoading).toBe(false);
  expect(getStoreSnapshot().profileLikes).toEqual([]);
  expectFailureNotice("Likes unavailable");
});

it('A failed Trades tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetch(() => failedResponse("Trades unavailable"));

  await loadProfileTrades("bob");

  expect(getStoreSnapshot().profileTradesLoading).toBe(false);
  expect(getStoreSnapshot().profileTrades).toEqual([]);
  expectFailureNotice("Trades unavailable");
});

it('A successful Replies tab load shows the replies with no failure notice (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetch(() => Promise.resolve(Response.json({
    items: [postRaw({ id: "bob-reply", authorId: "bob", authorHandle: "bob", authorDisplayName: "Bob Trader", replyToPostId: "post-x" })],
    nextCursor: null,
  })));

  await loadProfileReplies("bob");

  expect(getStoreSnapshot().profileReplies.map((p) => p.card.id)).toEqual(["bob-reply"]);
  expect(getStoreSnapshot().errorMessage).toBeNull();
});

it('A Replies load that fails after leaving the profile stays silent (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  let resolveFetch: (res: Response) => void = () => undefined;
  stubFetch(() => new Promise<Response>((settle) => { resolveFetch = settle; }));

  const pending = loadProfileReplies("bob");
  setStoreState({ route: "Home", profileHandle: null, profileBundle: null });
  resolveFetch(Response.json({ message: "Replies unavailable" }, { status: 500 }));
  await pending;

  expect(getStoreSnapshot().errorMessage).toBeNull();
});
