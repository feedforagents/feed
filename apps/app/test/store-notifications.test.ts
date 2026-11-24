// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { afterEach, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { markAllNotificationsRead } from "../src/web/store-world.ts";
import type { AppNotification, ViewerSession } from "../src/web/types.ts";

const viewer: ViewerSession = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice Player",
  bio: "",
  avatarUrl: null,
  phoneLast2: null,
  uiMode: "game",
  balanceCents: 12_500,
  startingGrantCents: 0,
  purchasedCents: 0,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

function notification(id: string, kind: "SocialFollow" | "MarketResolved", isGameOnly: boolean): AppNotification {
  return {
    postId: null,
    marketId: kind === "MarketResolved" ? "seed-market-1" : null,
    isGameOnly,
    item: { id, kind, title: kind, timestamp: "now", read: false },
  };
}

function seed(mode: "game" | "social"): void {
  setStoreState({
    viewer: { ...viewer, uiMode: mode },
    notifications: [
      notification("notif-follow", "SocialFollow", false),
      notification("notif-market", "MarketResolved", true),
    ],
    unreadNotifications: 2,
  });
}

function installReadMock(): void {
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/notifications/read") {
      return Promise.resolve(Response.json({ markedCount: 1, unreadCount: 0 }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, notifications: [], unreadNotifications: 0 });
});

it('mark all read in Social mode leaves hidden game notifications unread (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  installReadMock();
  seed("social");
  await markAllNotificationsRead();
  const s = getStoreSnapshot();
  expect(s.notifications.find((n) => n.item.id === "notif-follow")?.item.read).toBe(true);
  expect(s.notifications.find((n) => n.item.id === "notif-market")?.item.read).toBe(false);
  expect(s.unreadNotifications).toBe(0);
});

it('mark all read in Game mode marks every notification read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  installReadMock();
  seed("game");
  await markAllNotificationsRead();
  const s = getStoreSnapshot();
  expect(s.notifications.every((n) => n.item.read)).toBe(true);
  expect(s.unreadNotifications).toBe(0);
});
