// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadModerationLists } from "../src/web/store-world.ts";
import { aliceViewer, resetModerationStore } from "./moderation-fixtures.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  resetModerationStore();
  setStoreState({ mutedAccounts: [], moderationLoading: false, errorMessage: null });
});

it('A failed blocked and muted list load in Settings keeps the loaded lists and reports the failure (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.startsWith("/api/moderation/blocks")) {
      return Promise.resolve(Response.json({ message: "Blocks unavailable" }, { status: 500 }));
    }
    if (url.startsWith("/api/moderation/mutes")) {
      return Promise.resolve(Response.json({ message: "Mutes unavailable" }, { status: 500 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });

  setStoreState({
    viewer: aliceViewer,
    route: "Settings",
    blockedAccounts: [{ id: "bob", handle: "bob", displayName: "Bob Trader", avatarUrl: null, bio: "" }],
    mutedAccounts: [{ id: "carol", handle: "carol", displayName: "Carol Analyst", avatarUrl: null, bio: "" }],
    moderationLoading: false,
    errorMessage: null,
  });

  await loadModerationLists();

  const after = getStoreSnapshot();
  expect({
    blocked: after.blockedAccounts.map((a) => a.handle),
    muted: after.mutedAccounts.map((a) => a.handle),
    loading: after.moderationLoading,
    error: after.errorMessage,
  }).toEqual({
    blocked: ["bob"],
    muted: ["carol"],
    loading: false,
    error: "Blocks unavailable",
  });
});
