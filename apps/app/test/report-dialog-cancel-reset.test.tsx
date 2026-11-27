// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { flush, installAppTestLifecycle, installMockNetwork, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", reportTarget: null });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") {
    return {
      authenticated: true,
      viewer: {
        accountId: "acct-player-1",
        handle: "alice",
        displayName: "Alice Trader",
        bio: "",
        avatarUrl: null,
        bannerUrl: null,
        phoneLast2: "01",
        uiMode: "game",
        balanceCents: 10500,
        startingGrantCents: 10000,
        isAdmin: false,
        isReviewer: true,
        agentGrant: null,
      },
      acceptedCountries: ["+1", "+44"],
      publicAppUrl: window.location.origin,
      devSmsCodeEnabled: true,
    };
  }
  if (path === "/api/feed" || path === "/api/posts") return { items: [], nextCursor: null };
  if (path === "/api/trending") return { trending: [] };
  if (path === "/api/articles") return { articles: [] };
  if (path === "/api/markets") return { predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } };
  if (path === "/api/world/status") {
    return { currentDay: 3, currentHour: 14, phase: "active", gameRunning: true, lastTickAt: Date.now(), activeMarketsCount: 0, totalPostsCount: 0, activeActorsCount: 5 };
  }
  return undefined;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text);
}

function detailsInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional details"]');
}

async function typeDetails(value: string): Promise<void> {
  const input = detailsInput();
  if (!input) throw new Error("details input missing");
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  act(() => {
    descriptor?.set?.bind(input)(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function openReport(id: string, label: string): Promise<void> {
  await act(() => Promise.resolve(storeActions.openReportDialog({ kind: "post", id, label })));
  await flush();
  for (let i = 0; i < 50 && !detailsInput(); i += 1) {
    await flush();
  }
}

it('cancelling a report starts the next report empty instead of carrying the cancelled details to another post (spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts")', async () => {
  installMockNetwork(respond);
  await mountApp(opened);
  await flush();

  await openReport("post-a", "@bob's post");
  await act(() => Promise.resolve(buttonByText("Harassment")?.click()));
  await flush();
  await typeDetails("Details written for post A");

  await act(() => Promise.resolve(buttonByText("Cancel")?.click()));
  await flush();

  await openReport("post-b", "@carol's post");
  expect(detailsInput()?.value).toBe("");
});
