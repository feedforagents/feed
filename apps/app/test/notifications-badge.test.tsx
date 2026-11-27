// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { decodeNotifications } from "../src/web/types.ts";
import { eventSources, flush, installAppTestLifecycle, installMockNetwork, makeViewerSession, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  mockState.uiMode = "game";
  mockState.notificationsOverride = null;
  mockState.markReadCalls = 0;
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
};

function respond(path: string): unknown {
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

it('notification badge follows a mode change through a refetch and shows the server total past one page (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
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

it('opening a perp liquidation notification lands on its perp market (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();

  const seeded = decodeNotifications({
    notifications: [
      {
        id: "notif-liq",
        kind: "perp_liquidated",
        ticker: "BTC",
        isGameOnly: true,
        title: "$BTC Long position liquidated",
        body: "Your 5x $BTC Long position was liquidated at 100.00 pts.",
        read: false,
        createdAt: Date.now() - 60_000,
      },
    ],
    unreadCount: 1,
  });
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

  expect(container.textContent).toContain("$BTC Long position liquidated");

  const pressTab = async (label: string) => {
    const tab = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.trim() === label,
    );
    await act(() =>
      Promise.resolve(tab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))),
    );
    await flush();
  };
  await pressTab("Mentions");
  expect(container.textContent).not.toContain("$BTC Long position liquidated");

  await pressTab("All");

  const titleButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.includes("$BTC Long position liquidated"),
  );
  expect(titleButton).toBeDefined();
  await act(() => Promise.resolve(titleButton?.click()));
  await flush();

  expect(mockState.markReadCalls).toBe(1);
  expect(getStoreSnapshot().route).toBe("Markets");
  expect(getStoreSnapshot().selectedTicker).toBe("BTC");
});
