// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { clearNotifications, loadNotifications, markAllNotificationsRead, markNotificationRead } from "../src/web/store-world.ts";
import { decodeNotifications } from "../src/web/types.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";

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

function seedUnreadNotifications() {
  const pending = installDeferredFetch();
  const seeded = decodeNotifications(unreadPayload);
  setStoreState({ viewer, notifications: seeded.items, unreadNotifications: 1 });
  return pending;
}

function expectAllRead() {
  expect(getStoreSnapshot().notifications[0]?.item.read).toBe(true);
  expect(getStoreSnapshot().unreadNotifications).toBe(0);
}

function notificationsSummary(): string {
  const s = getStoreSnapshot();
  return `${s.notifications.map((n) => `${n.item.id}:${n.item.read ? "r" : "u"}`).join(",")} unread=${s.unreadNotifications}`;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const notificationMutations = {
  single: { run: () => markNotificationRead("notif-1"), request: "POST /api/notifications/read", reply: { unreadCount: 0 } },
  all: { run: () => markAllNotificationsRead(), request: "POST /api/notifications/read", reply: {} },
  clear: { run: () => clearNotifications(), request: "DELETE /api/notifications", reply: {} },
} as const;

type NotificationMutationKind = keyof typeof notificationMutations;

async function expectNewItemSurvivesWindow(
  kind: NotificationMutationKind,
  refetchPayload: unknown,
  expected: string,
  reloadPayload: unknown,
): Promise<void> {
  const mutation = notificationMutations[kind];
  const pending = seedUnreadNotifications();
  const running = mutation.run();
  const loading = loadNotifications();
  pending.get(mutation.request)?.resolve(jsonResponse(mutation.reply));
  await running;
  pending.get("GET /api/notifications")?.resolve(jsonResponse(refetchPayload));
  await loading;
  expect(notificationsSummary()).toBe(expected);
  pending.get("GET /api/notifications")?.resolve(jsonResponse(reloadPayload));
  await flushMicrotasks();
  expect(notificationsSummary()).toBe(expected);
}

async function expectRefetchAfterReplyApplies(
  kind: NotificationMutationKind,
  refetchPayload: unknown,
  expected: string,
): Promise<void> {
  const mutation = notificationMutations[kind];
  const pending = seedUnreadNotifications();
  const running = mutation.run();
  pending.get(mutation.request)?.resolve(jsonResponse(mutation.reply));
  await running;
  const loading = loadNotifications();
  pending.get("GET /api/notifications")?.resolve(jsonResponse(refetchPayload));
  await loading;
  expect(notificationsSummary()).toBe(expected);
}

const newItem = {
  id: "notif-2",
  kind: "follow",
  actorHandle: "carol",
  actorName: "Carol",
  title: "Carol followed you",
  read: false,
  createdAt: Date.now(),
};

const newItemReadPayload = {
  notifications: [newItem, { ...unreadPayload.notifications[0], read: true }],
  unreadCount: 1,
};

const newItemUnreadTargetPayload = {
  notifications: [newItem, unreadPayload.notifications[0]],
  unreadCount: 2,
};

const newItemOnlyPayload = {
  notifications: [newItem],
  unreadCount: 1,
};

describe("notifications mark-read race", () => {
  it('stale refetch must not undo mark-all-read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = seedUnreadNotifications();
    const marking = markAllNotificationsRead();
    const loading = loadNotifications();
    pending.get("POST /api/notifications/read")?.resolve(jsonResponse({}));
    await marking;
    expectAllRead();
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expectAllRead();
  });

  it('stale refetch must not undo a single mark-read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = seedUnreadNotifications();
    const marking = markNotificationRead("notif-1");
    const loading = loadNotifications();
    pending.get("POST /api/notifications/read")?.resolve(jsonResponse({ unreadCount: 0 }));
    await marking;
    expectAllRead();
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expectAllRead();
  });

  it('stale refetch must not resurrect cleared notifications (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = seedUnreadNotifications();
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

  it('a notification created during a single mark-read still shows (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectNewItemSurvivesWindow("single", newItemReadPayload, "notif-2:u,notif-1:r unread=1", newItemReadPayload);
  });

  it('a notification created during a single mark-read still shows when the refetch predates the read (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectNewItemSurvivesWindow("single", newItemUnreadTargetPayload, "notif-2:u,notif-1:r unread=1", newItemReadPayload);
  });

  it('a notification created during mark-all-read still shows (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectNewItemSurvivesWindow("all", newItemReadPayload, "notif-2:u,notif-1:r unread=1", newItemReadPayload);
  });

  it('a notification created during clear-all still shows (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectNewItemSurvivesWindow("clear", newItemOnlyPayload, "notif-2:u unread=1", newItemOnlyPayload);
  });

  it('a refetch that lands before the single mark-read reply does not leave the item unread with a zero badge (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    const pending = seedUnreadNotifications();
    const marking = markNotificationRead("notif-1");
    const loading = loadNotifications();
    pending.get("GET /api/notifications")?.resolve(jsonResponse(unreadPayload));
    await loading;
    expect(notificationsSummary()).toBe("notif-1:u unread=1");
    pending.get("POST /api/notifications/read")?.resolve(jsonResponse({ unreadCount: 0 }));
    await marking;
    expect(notificationsSummary()).toBe("notif-1:r unread=0");
  });

  it('a refetch that starts after a single mark-read reply still applies (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectRefetchAfterReplyApplies("single", newItemReadPayload, "notif-2:u,notif-1:r unread=1");
  });

  it('a refetch that starts after a clear-all reply still applies (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectRefetchAfterReplyApplies("clear", newItemOnlyPayload, "notif-2:u unread=1");
  });

  it('a refetch that starts after a mark-all-read reply still applies (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
    await expectRefetchAfterReplyApplies("all", newItemReadPayload, "notif-2:u,notif-1:r unread=1");
  });
});
