// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { updateOwnProfile } from "../src/web/store-world.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

function openOwnProfile(): void {
  setStoreState({
    viewer: {
      accountId: "alice",
      handle: "alice",
      displayName: "Alice Player",
      bio: "Old bio",
      avatarUrl: "https://example.com/old-avatar.png",
      bannerUrl: "https://example.com/old-banner.png",
      phoneLast2: null,
      phoneVerifiedAt: null,
      emailMasked: null,
      emailVerifiedAt: null,
      uiMode: "game",
      balanceCents: 10_000,
      startingGrantCents: 10_000,
      isAdmin: false,
      isReviewer: false,
      agentGrant: null,
    },
    route: "Profile",
    profileHandle: "alice",
    profileBundle: {
      summary: {
        displayName: "Alice Player",
        handle: "alice",
        bio: "Old bio",
        avatarUrl: "https://example.com/old-avatar.png",
        bannerUrl: "https://example.com/old-banner.png",
        followersCount: 3,
        followingCount: 2,
        isFollowing: false,
        isMuted: false,
        isBlocked: false,
        isOwnProfile: true,
      },
      id: "alice",
      kind: "user",
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
    },
  });
}

async function saveWhile(
  changed: () => void,
  patchResponse: Response = jsonResponse({
    accountId: "alice",
    handle: "alice",
    displayName: "Alice Renamed",
    bio: "New bio",
    avatarUrl: null,
    bannerUrl: null,
  }),
): Promise<boolean> {
  openOwnProfile();
  const pending = installDeferredFetch();
  const saving = updateOwnProfile({
    displayName: "Alice Renamed",
    bio: "New bio",
    avatarUrl: null,
    bannerUrl: null,
  });
  changed();
  pending.get("PATCH /api/users/me")?.resolve(patchResponse);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  for (const [key, held] of pending) {
    if (key.startsWith("GET /api/users/alice")) held.resolve(Response.json({ message: "Profile load failed" }, { status: 500 }));
  }
  return saving;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, profileBundle: null, profileHandle: null, toasts: [] });
});

describe("profile edit save", () => {
  it('a saved profile stays on screen when the follow-up profile reload fails (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    openOwnProfile();
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(raw, "https://feed.fun").pathname;
      if (path === "/api/users/me" && init?.method === "PATCH") {
        return Promise.resolve(Response.json({
          accountId: "alice",
          handle: "alice",
          displayName: "Alice Renamed",
          bio: "New bio",
          avatarUrl: null,
          bannerUrl: null,
        }));
      }
      return Promise.resolve(Response.json({ message: "Profile load failed" }, { status: 500 }));
    });

    const ok = await updateOwnProfile({
      displayName: "Alice Renamed",
      bio: "New bio",
      avatarUrl: null,
      bannerUrl: null,
    });

    expect(ok).toBe(true);
    const summary = getStoreSnapshot().profileBundle?.summary;
    expect(summary?.displayName).toBe("Alice Renamed");
    expect(summary?.bio).toBe("New bio");
    expect(summary?.avatarUrl).toBeUndefined();
    expect(summary?.bannerUrl).toBeUndefined();
  });

  it('a failed save leaves the displayed profile untouched (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    openOwnProfile();
    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({ message: "Save failed" }, { status: 500 })));

    const ok = await updateOwnProfile({
      displayName: "Alice Renamed",
      bio: "New bio",
      avatarUrl: null,
      bannerUrl: null,
    });

    expect(ok).toBe(false);
    const summary = getStoreSnapshot().profileBundle?.summary;
    expect(summary?.displayName).toBe("Alice Player");
    expect(summary?.bio).toBe("Old bio");
    expect(getStoreSnapshot().viewer?.displayName).toBe("Alice Player");
  });

  it('a save that lands after sign-out does not restore the signed-out viewer (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
    const ok = await saveWhile(() => {
      setStoreState({ viewer: null, profileBundle: null, profileHandle: null, route: "Home" });
    });

    expect(ok).toBe(false);
    expect(getStoreSnapshot().viewer).toBeNull();
    expect(getStoreSnapshot().toasts.some((t) => t.message === "Profile updated.")).toBe(false);
  });

  it('a save that lands after an account switch leaves the new viewer untouched (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
    const ok = await saveWhile(() => {
      const bob = { ...getStoreSnapshot().viewer!, accountId: "bob", handle: "bob", displayName: "Bob Player" };
      setStoreState({ viewer: bob, profileBundle: null, profileHandle: null, route: "Home" });
    });

    expect(ok).toBe(false);
    expect(getStoreSnapshot().viewer?.accountId).toBe("bob");
    expect(getStoreSnapshot().viewer?.displayName).toBe("Bob Player");
  });

  it('a save keeps viewer fields that changed while it was in flight (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
    const ok = await saveWhile(() => {
      setStoreState({ viewer: { ...getStoreSnapshot().viewer!, balanceCents: 7_777 } });
    });

    expect(ok).toBe(true);
    expect(getStoreSnapshot().viewer?.displayName).toBe("Alice Renamed");
    expect(getStoreSnapshot().viewer?.balanceCents).toBe(7_777);
  });

  it('a save that fails after sign-out shows no error notice (spec/auth/phone.md, "Story: Onboard once, change phone, sign out everywhere, or delete after cooldown")', async () => {
    const ok = await saveWhile(
      () => {
        setStoreState({ viewer: null, profileBundle: null, profileHandle: null, route: "Home" });
      },
      Response.json({ message: "Save failed" }, { status: 500 }),
    );

    expect(ok).toBe(false);
    expect(getStoreSnapshot().viewer).toBeNull();
    expect(getStoreSnapshot().toasts).toHaveLength(0);
  });
});
