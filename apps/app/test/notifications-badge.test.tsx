// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadChatMessages, toggleBlock } from "../src/web/store-world.ts";
import { decodeNotifications } from "../src/web/types.ts";
import { eventSources, flush, installAppTestLifecycle, installMockNetwork, makeViewerSession, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  mockState.uiMode = "game";
  mockState.notificationsOverride = null;
  mockState.markReadCalls = 0;
  mockState.server = null;
  setStoreState({ viewer: null, notifications: [], unreadNotifications: 0, route: "Home" });
});

const viewer = (uiMode: "game" | "social") => ({
  accountId: "acct-player-1",
  handle: "alice",
  displayName: "Alice Trader",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: "01",
  uiMode,
  balanceCents: 10500,
  startingGrantCents: 10000,
  isAdmin: false,
  isReviewer: true,
  agentGrant: null,
});

const gameNotifications = {
  notifications: [
    { id: "notif-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
    { id: "notif-market", kind: "market_resolved", marketId: "seed-market-1", title: "Market resolved", read: false, createdAt: Date.now() - 30_000 },
    { id: "notif-follow-read", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: true, createdAt: Date.now() - 120_000 },
  ],
  unreadCount: 2,
};

const socialNotifications = {
  notifications: [
    { id: "notif-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
    { id: "notif-follow-read", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: true, createdAt: Date.now() - 120_000 },
  ],
  unreadCount: 1,
};

const mockState = {
  uiMode: "game" as "game" | "social",
  notificationsOverride: null as { notifications: unknown[]; unreadCount: number } | null,
  markReadCalls: 0,
  server: null as { rows: ServerRow[]; bobBlocked: boolean } | null,
};

interface ServerRow {
  readonly id: string;
  readonly kind: string;
  readonly actorHandle: string;
  readonly chatId?: string;
  read: boolean;
}

function serverRows(count: number, kind: string, chatId?: string): ServerRow[] {
  return [
    ...Array.from({ length: count }, (_, i) => ({ id: `bob-${kind}-${i}`, kind, actorHandle: "bob", chatId, read: false })),
    { id: "carol-follow", kind: "follow", actorHandle: "carol", read: false },
  ];
}

function respondFromServer(path: string, method: string): unknown {
  const server = mockState.server;
  if (!server) return undefined;
  const visible = server.rows.filter((row) => !(server.bobBlocked && row.actorHandle === "bob"));
  if (path === "/api/notifications") {
    return {
      notifications: visible.slice(0, 50).map((row) => ({ ...row, actorName: row.actorHandle, title: row.kind, createdAt: 1 })),
      unreadCount: visible.filter((row) => !row.read).length,
    };
  }
  if (path === "/api/chats/chat-1/messages") {
    return { messages: [{ id: "m1", senderId: "bob", senderKind: "user", senderHandle: "bob", senderDisplayName: "Bob", content: "hi", createdAt: 2, reactions: [] }] };
  }
  if (path === "/api/chats/chat-1/read") {
    for (const row of server.rows) if (row.chatId === "chat-1") row.read = true;
    return { chatId: "chat-1", accountId: "acct-player-1", lastReadAt: 2, unreadCount: 0 };
  }
  if (path === "/api/users/bob/block") {
    server.bobBlocked = method !== "DELETE";
    return { blocked: server.bobBlocked };
  }
  return undefined;
}

function respond(path: string, _url?: URL, init?: RequestInit): unknown {
  const fromServer = respondFromServer(path, init?.method ?? "GET");
  if (fromServer !== undefined) return fromServer;
  if (path === "/api/auth/me") {
    return {
      authenticated: true,
      viewer: viewer(mockState.uiMode),
      acceptedCountries: ["+1", "+44"],
      publicAppUrl: window.location.origin,
      devSmsCodeEnabled: true,
    };
  }
  if (path === "/api/notifications") {
    return mockState.notificationsOverride ?? (mockState.uiMode === "game" ? gameNotifications : socialNotifications);
  }
  if (path === "/api/notifications/read") {
    mockState.markReadCalls += 1;
    return { markedCount: 1, unreadCount: 0 };
  }
  return undefined;
}

function notificationBadgeText(container: HTMLElement): string | null {
  const buttons = [...container.querySelectorAll("button")].filter((button) =>
    button.textContent?.includes("Notifications"),
  );
  for (const button of buttons) {
    const badge = [...button.querySelectorAll("span")].find((span) => /^\d+\+?$/.test(span.textContent?.trim() ?? ""));
    if (badge?.textContent) return badge.textContent.trim();
  }
  return null;
}

function unreadRowCount(container: HTMLElement): number {
  return [...container.querySelectorAll("span.sr-only")].filter((span) => span.textContent === "Unread").length;
}

function markAllReadButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("Mark all read"),
  );
}

async function emitSse(type: string): Promise<void> {
  act(() => {
    eventSources.at(-1)?.dispatchEvent(new MessageEvent(type, { data: {} }));
  });
  await flush();
}

it('notification badge follows a mode change through a refetch and shows the server total past one page, also after a chat read and a block (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();

  const before = getStoreSnapshot();
  expect(before.viewer?.uiMode).toBe("game");
  expect(before.notifications).toHaveLength(3);
  expect(before.unreadNotifications).toBe(2);
  expect(notificationBadgeText(container)).toBe("2");

  await act(() => Promise.resolve(setStoreState({ route: "Notifications" })));
  await flush();

  expect(container.querySelector("h1")?.textContent).toBe("Notifications");
  expect(container.textContent).toContain("Market resolved");
  expect(unreadRowCount(container)).toBe(2);
  expect(notificationBadgeText(container)).toBe("2");

  mockState.uiMode = "social";
  await emitSse("world.tick");

  const after = getStoreSnapshot();
  expect(after.viewer?.uiMode).toBe("social");
  expect(after.notifications).toHaveLength(2);
  expect(after.unreadNotifications).toBe(1);
  expect(container.textContent).not.toContain("Market resolved");
  expect(unreadRowCount(container)).toBe(1);
  expect(notificationBadgeText(container)).toBe("1");

  mockState.notificationsOverride = {
    notifications: Array.from({ length: 50 }, (_, i) => ({
      id: `notif-follow-${i}`,
      kind: "follow",
      actorHandle: "bob",
      actorName: "Bob",
      title: "Bob followed you",
      read: false,
      createdAt: Date.now() - 60_000 - i,
    })),
    unreadCount: 150,
  };
  await emitSse("notification.created");

  const paged = getStoreSnapshot();
  expect(paged.notifications).toHaveLength(50);
  expect(paged.unreadNotifications).toBe(150);
  expect(notificationBadgeText(container)).toBe("99+");

  const expectBadge = (count: number) => {
    expect(getStoreSnapshot().unreadNotifications).toBe(count);
    expect(notificationBadgeText(container)).toBe(String(count));
  };

  mockState.server = { rows: serverRows(60, "chat_message", "chat-1"), bobBlocked: false };
  await emitSse("notification.created");
  expectBadge(61);
  await act(() => Promise.resolve(setStoreState({ selectedChatId: "chat-1" })));
  await act(() => loadChatMessages("chat-1"));
  await flush();
  expectBadge(1);

  mockState.server = { rows: serverRows(60, "like"), bobBlocked: false };
  await emitSse("notification.created");
  expectBadge(61);
  await act(() => toggleBlock("bob", false));
  await flush();
  expectBadge(1);
  await act(() => toggleBlock("bob", true));
  await flush();
  expectBadge(61);
});

it('mark all read stays available while an unread notification sits past the loaded page (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  mockState.notificationsOverride = {
    notifications: Array.from({ length: 50 }, (_, i) => ({
      id: `notif-follow-${i}`,
      kind: "follow",
      actorHandle: "bob",
      actorName: "Bob",
      title: "Bob followed you",
      read: true,
      createdAt: Date.now() - 60_000 - i,
    })),
    unreadCount: 1,
  };
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();

  const seeded = decodeNotifications(mockState.notificationsOverride);
  await act(() =>
    Promise.resolve(
      setStoreState({
        viewer: makeViewerSession(),
        notifications: seeded.items,
        unreadNotifications: seeded.unreadCount,
        route: "Notifications",
      }),
    ),
  );
  await flush();

  expect(getStoreSnapshot().notifications).toHaveLength(50);
  expect(getStoreSnapshot().unreadNotifications).toBe(1);
  expect(notificationBadgeText(container)).toBe("1");
  expect(unreadRowCount(container)).toBe(0);

  const button = markAllReadButton(container);
  expect(button?.disabled).toBe(false);

  await act(() => Promise.resolve(button?.click()));
  await flush();

  expect(mockState.markReadCalls).toBe(1);
  expect(getStoreSnapshot().unreadNotifications).toBe(0);
  expect(notificationBadgeText(container)).toBeNull();
  expect(markAllReadButton(container)?.disabled).toBe(true);
});
