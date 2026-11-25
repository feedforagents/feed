// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/web/App.tsx";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
const opened: Root[] = [];

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  vi.unstubAllGlobals();
  setStoreState({ viewer: null, notifications: [], unreadNotifications: 0, route: "Home" });
  window.history.replaceState(null, "", "/");
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

function installMockNetwork(): void {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: true,
        viewer: {
          accountId: "acct-player-1",
          handle: "alice",
          displayName: "Alice Trader",
          bio: "",
          avatarUrl: null,
          bannerUrl: null,
          phoneLast2: "01",
          uiMode: "social",
          balanceCents: 10500,
          startingGrantCents: 10000,
          isAdmin: false,
          isReviewer: true,
          agentGrant: null,
        },
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
        devSmsCodeEnabled: true,
      });
    }
    if (path === "/api/notifications") {
      return json({
        notifications: [
          { id: "notif-follow", kind: "follow", actorHandle: "bob", actorName: "Bob", title: "Bob followed you", read: false, createdAt: Date.now() - 60_000 },
          { id: "notif-market", kind: "market_resolved", marketId: "seed-market-1", title: "Market resolved", read: false, createdAt: Date.now() - 30_000 },
        ],
        unreadCount: 2,
      });
    }
    if (path === "/api/feed" || path === "/api/posts") return json({ items: [], nextCursor: null });
    if (path === "/api/trending") return json({ trending: [] });
    if (path === "/api/articles") return json({ articles: [] });
    if (path === "/api/markets") return json({ predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } });
    if (path === "/api/world/status") {
      return json({
        currentDay: 3,
        currentHour: 14,
        phase: "active",
        gameRunning: true,
        lastTickAt: Date.now(),
        activeMarketsCount: 0,
        totalPostsCount: 0,
        activeActorsCount: 5,
      });
    }
    if (path === "/api/chats") return json({ chats: [] });
    if (path === "/api/chats/invites") return json({ invites: [] });
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return json({ items: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    close(): void {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
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

it('notification badge counts only visible unread rows after an external switch to Social mode (spec/social/moderation.md, "Story: In-app notifications and Social-mode presentation filtering")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
  await flush();

  const s = getStoreSnapshot();
  expect(s.viewer?.uiMode).toBe("social");
  expect(s.notifications).toHaveLength(2);
  expect(s.unreadNotifications).toBe(2);

  await act(() => Promise.resolve(setStoreState({ route: "Notifications" })));
  await flush();

  expect(container.querySelector("h1")?.textContent).toBe("Notifications");
  expect(unreadRowCount(container)).toBe(1);
  expect(notificationBadgeText(container)).toBe("1");
});
