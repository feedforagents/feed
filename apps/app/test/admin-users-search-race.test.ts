// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadAdminUsers } from "../src/web/store-auth.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

const adminViewer = {
  accountId: "admin-1",
  handle: "admin",
  displayName: "Admin",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game" as const,
  balanceCents: 0,
  startingGrantCents: 0,
  isAdmin: true,
  isReviewer: false,
  agentGrant: null,
};

const aliceRows = [{ accountId: "alice-id", handle: "alice", displayName: "Alice Player" }];
const bobRows = [{ accountId: "bob-id", handle: "bob", displayName: "Bob Trader" }];

function seedAdmin(): void {
  setStoreState({ viewer: adminViewer, adminUsers: [], adminTabLoading: false });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, adminUsers: [], adminTabLoading: false });
});

describe("admin users search race", () => {
  it('slow search response must not overwrite a newer search (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const pending = installDeferredFetch();
    const first = loadAdminUsers("alice");
    const second = loadAdminUsers("bob");
    pending.get("GET /api/admin/users?q=bob&limit=50")?.resolve(jsonResponse(bobRows));
    await second;
    expect(getStoreSnapshot().adminUsers.map((u) => u.handle)).toEqual(["bob"]);
    pending.get("GET /api/admin/users?q=alice&limit=50")?.resolve(jsonResponse(aliceRows));
    await first;
    expect(getStoreSnapshot().adminUsers.map((u) => u.handle)).toEqual(["bob"]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });

  it('slow empty-query response must not overwrite a newer search (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
    seedAdmin();
    const pending = installDeferredFetch();
    const first = loadAdminUsers("");
    const second = loadAdminUsers("alice");
    pending.get("GET /api/admin/users?q=alice&limit=50")?.resolve(jsonResponse(aliceRows));
    await second;
    expect(getStoreSnapshot().adminUsers.map((u) => u.handle)).toEqual(["alice"]);
    pending.get("GET /api/admin/users?limit=50")?.resolve(jsonResponse(bobRows));
    await first;
    expect(getStoreSnapshot().adminUsers.map((u) => u.handle)).toEqual(["alice"]);
    expect(getStoreSnapshot().adminTabLoading).toBe(false);
  });
});
