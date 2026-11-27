// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Switch between Game mode and Social mode"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { decodePositions } from "../src/web/types.ts";
import {
  flush,
  installAppTestLifecycle,
  installStubEventSource,
  makeViewerSession,
  mountApp,
  stubFetchByUrl,
} from "./app-test-helpers.tsx";

const opened: Root[] = [];
const mockState = { modeSaveFails: true };

installAppTestLifecycle(opened, () => {
  mockState.modeSaveFails = true;
  setStoreState({ viewer: null, positions: [], route: "Home", settingsTab: "profile", toasts: [] });
});

function installNetwork(): void {
  stubFetchByUrl((url) => {
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          viewer: makeViewerSession({ uiMode: "social", balanceCents: 10500, startingGrantCents: 10000 }),
          acceptedCountries: ["+1"],
          publicAppUrl: window.location.origin,
          devSmsCodeEnabled: true,
        }),
      );
    }
    if (path === "/api/auth/mode") {
      return Promise.resolve(
        mockState.modeSaveFails
          ? Response.json({ message: "Mode save failed" }, { status: 500 })
          : Response.json({ ok: true }),
      );
    }
    if (path === "/api/feed" || path === "/api/posts") return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    if (path === "/api/chats") return Promise.resolve(Response.json({ chats: [] }));
    if (path === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    if (path === "/api/notifications") return Promise.resolve(Response.json({ items: [], unreadCount: 0 }));
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return Promise.resolve(Response.json({ items: [] }));
    if (path === "/api/skills/hosts") {
      return Promise.resolve(Response.json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] }));
    }
    if (path === "/api/markets") return Promise.resolve(Response.json({ predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } }));
    if (path === "/api/trending") return Promise.resolve(Response.json({ trending: [] }));
    if (path === "/api/articles") return Promise.resolve(Response.json({ articles: [] }));
    return Promise.resolve(Response.json({}));
  });
  installStubEventSource();
}

async function mountSettingsWithAtRiskPosition(): Promise<HTMLElement> {
  installNetwork();
  const { container } = await mountApp(opened);
  await flush();
  const positions = decodePositions({
    predictionPositions: [
      {
        marketId: "mkt-rain",
        side: "yes",
        shares: 1500,
        costBasisCents: 800,
        estimatedValueCents: 850,
        question: "Will it rain tomorrow?",
        yesPriceBps: 5700,
        noPriceBps: 4300,
        settledAt: null,
      },
    ],
  });
  act(() => {
    setStoreState({
      route: "Settings",
      settingsTab: "appearance",
      viewer: makeViewerSession({ uiMode: "social", balanceCents: 10500, startingGrantCents: 10000 }),
      positions,
      toasts: [],
    });
  });
  await flush();
  return container;
}

function viewMarketsButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("View markets"));
  if (!button) {
    const s = getStoreSnapshot();
    throw new Error(
      `View markets button not found; route=${s.route} tab=${s.settingsTab} mode=${s.viewer?.uiMode ?? "null"} positions=${s.positions.length} text=${(container.textContent ?? "").slice(0, 400)}`,
    );
  }
  return button;
}

it('stays in Settings when returning to Game mode fails to save (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  const container = await mountSettingsWithAtRiskPosition();
  act(() => {
    viewMarketsButton(container).click();
  });
  await flush();
  const s = getStoreSnapshot();
  expect({
    route: s.route,
    uiMode: s.viewer?.uiMode ?? null,
    toastMessages: s.toasts.map((t) => t.message),
  }).toEqual({
    route: "Settings",
    uiMode: "social",
    toastMessages: ["Mode save failed"],
  });
});

it('opens Markets when returning to Game mode saves (spec/app/navigation.md, "Story: Switch between Game mode and Social mode")', async () => {
  mockState.modeSaveFails = false;
  const container = await mountSettingsWithAtRiskPosition();
  act(() => {
    viewMarketsButton(container).click();
  });
  await flush();
  const s = getStoreSnapshot();
  expect(s.route).toBe("Markets");
  expect(s.viewer?.uiMode).toBe("game");
});
