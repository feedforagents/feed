// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadProfileLikes, loadProfileReplies, loadProfileTrades } from "../src/web/store-world.ts";
import { aliceViewer, expectFailureNotice, makeProfileBundle, postRaw, resetModerationStore, stubFetchUrl } from "./moderation-fixtures.ts";

function openBobProfile() {
  setStoreState({
    viewer: aliceViewer,
    profileBundle: makeProfileBundle("bob", "Bob Trader", 6, 4, false),
    profileHandle: "bob",
    route: "Profile",
    errorMessage: null,
    toasts: [],
  });
}

function failedResponse(message: string) {
  return Promise.resolve(Response.json({ message }, { status: 500 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ errorMessage: null, toasts: [], profileLikes: [], profileTrades: [] });
});

it('A failed Replies tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetchUrl(() => failedResponse("Replies unavailable"));

  await loadProfileReplies("bob");

  expect(getStoreSnapshot().profileRepliesLoading).toBe(false);
  expect(getStoreSnapshot().profileReplies).toEqual([]);
  expectFailureNotice("Replies unavailable");
});

it('A failed Likes tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetchUrl(() => failedResponse("Likes unavailable"));

  await loadProfileLikes("bob");

  expect(getStoreSnapshot().profileLikesLoading).toBe(false);
  expect(getStoreSnapshot().profileLikes).toEqual([]);
  expectFailureNotice("Likes unavailable");
});

it('A failed Trades tab load reports the failure instead of presenting an empty list (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetchUrl(() => failedResponse("Trades unavailable"));

  await loadProfileTrades("bob");

  expect(getStoreSnapshot().profileTradesLoading).toBe(false);
  expect(getStoreSnapshot().profileTrades).toEqual([]);
  expectFailureNotice("Trades unavailable");
});

it('A successful Replies tab load shows the replies with no failure notice (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  openBobProfile();
  stubFetchUrl(() => Promise.resolve(Response.json({
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
  stubFetchUrl(() => new Promise<Response>((settle) => { resolveFetch = settle; }));

  const pending = loadProfileReplies("bob");
  setStoreState({ route: "Home", profileHandle: null, profileBundle: null });
  resolveFetch(Response.json({ message: "Replies unavailable" }, { status: 500 }));
  await pending;

  expect(getStoreSnapshot().errorMessage).toBeNull();
});
