// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { updateOwnProfile } from "../src/web/store-world.ts";

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
});
