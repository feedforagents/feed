// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { clearNotifications, loadNotifications, markAllNotificationsRead, markNotificationRead } from "../src/web/store-world.ts";
import { decodeNotifications } from "../src/web/types.ts";

type Deferred = { resolve: (value: Response) => void };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installDeferredFetch() {
  const pending = new Map<string, Deferred>();
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, "https://feed.fun").pathname;
    const method = init?.method ?? "GET";
    return new Promise<Response>((resolve) => {
      pending.set(`${method} ${path}`, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

const viewer = {
  accountId: "acct-player-1",
  handle: "alice",
  displayName: "Alice Trader",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: "01",
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game" as const,
  balanceCents: 10500,
  startingGrantCents: 10000,
  isAdmin: false,
  isReviewer: true,
  agentGrant: null,
};

const unreadPayload = {
  notifications: [
    { id: "notif-1", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
  ],
  unreadCount: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notifications mark-read race", () => {
  it('stale refetch must not undo mark-all-read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = installDeferredFetch();
    const seeded = decodeNotifications(unreadPayload);
    setStoreState({ viewer, notifications: seeded.items, unreadNotifications: 1 });
    const marking = markAllNotificationsRead();
    const loading = loadNotifications();
    pending.get("POST /api/notifications/read")?.resolve(jsonResponse({}));
    await marking;
    expect(getStoreSnapshot().notifications[0]?.item.read).toBe(true);
    expect(getStoreSnapshot().unreadNotifications).toBe(0);
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expect(getStoreSnapshot().notifications[0]?.item.read).toBe(true);
    expect(getStoreSnapshot().unreadNotifications).toBe(0);
  });

  it('stale refetch must not undo a single mark-read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = installDeferredFetch();
    const seeded = decodeNotifications(unreadPayload);
    setStoreState({ viewer, notifications: seeded.items, unreadNotifications: 1 });
    const marking = markNotificationRead("notif-1");
    const loading = loadNotifications();
    pending.get("POST /api/notifications/read")?.resolve(jsonResponse({ unreadCount: 0 }));
    await marking;
    expect(getStoreSnapshot().notifications[0]?.item.read).toBe(true);
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expect(getStoreSnapshot().notifications[0]?.item.read).toBe(true);
    expect(getStoreSnapshot().unreadNotifications).toBe(0);
  });

  it('stale refetch must not resurrect cleared notifications (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = installDeferredFetch();
    const seeded = decodeNotifications(unreadPayload);
    setStoreState({ viewer, notifications: seeded.items, unreadNotifications: 1 });
    const clearing = clearNotifications();
    const loading = loadNotifications();
    pending.get("DELETE /api/notifications")?.resolve(jsonResponse({}));
    await clearing;
    expect(getStoreSnapshot().notifications).toEqual([]);
    expect(getStoreSnapshot().unreadNotifications).toBe(0);
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expect(getStoreSnapshot().notifications).toEqual([]);
    expect(getStoreSnapshot().unreadNotifications).toBe(0);
  });
});
