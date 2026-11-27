// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { findButtonByText, flush, installAppTestLifecycle, installStubEventSource, makeAuthMeResponse, makeViewerSession, mountApp, stubFetchByUrl } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", reportTarget: null, toasts: [], errorMessage: null });
});

function installNetwork(reportStatus: number): void {
  installStubEventSource();
  stubFetchByUrl((url, init) => {
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/reports" && method === "POST") {
      if (reportStatus === 200) {
        return Promise.resolve(Response.json({ id: "report-1", status: "open" }));
      }
      return Promise.resolve(
        Response.json({ error: { code: "RateLimited", message: "Hourly action limit exceeded" } }, { status: reportStatus }),
      );
    }
    if (path === "/api/auth/me") return Promise.resolve(Response.json(makeAuthMeResponse()));
    if (path === "/api/feed") return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    if (path === "/api/trending") return Promise.resolve(Response.json({ trending: [] }));
    if (path === "/api/articles") return Promise.resolve(Response.json({ articles: [] }));
    if (path === "/api/markets") {
      return Promise.resolve(Response.json({ predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } }));
    }
    if (path === "/api/world/status") {
      return Promise.resolve(
        Response.json({ currentDay: 3, currentHour: 14, phase: "active", gameRunning: true, lastTickAt: Date.now(), activeMarketsCount: 0, totalPostsCount: 0, activeActorsCount: 5 }),
      );
    }
    if (path === "/api/chats") return Promise.resolve(Response.json({ chats: [] }));
    if (path === "/api/chats/invites") return Promise.resolve(Response.json({ invites: [] }));
    if (path === "/api/notifications") return Promise.resolve(Response.json({ items: [], unreadCount: 0 }));
    if (path === "/api/moderation/blocks" || path === "/api/moderation/mutes") return Promise.resolve(Response.json({ items: [] }));
    return Promise.resolve(Response.json({}));
  });
}

function dialogElement(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("report dialog not found");
  return dialog;
}

async function openReport(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    act(() => { storeActions.openReportDialog({ kind: "post", id: "post-a", label: "@bob's post" }); });
    await flush();
    if (document.querySelector('textarea[aria-label="Additional details"]')) return;
  }
  throw new Error("report dialog did not open");
}

async function submitReport(): Promise<void> {
  const button = findButtonByText("Submit report", dialogElement());
  if (!button) throw new Error("Submit report button not found");
  act(() => { button.click(); });
  await flush();
}

it("shows the failure inside the report dialog when submitting a report fails", async () => {
  installNetwork(429);
  await mountApp(opened);
  await flush();
  setStoreState({ viewer: makeViewerSession() });
  await flush();

  await openReport();
  await submitReport();

  const alert = dialogElement().querySelector('[role="alert"]');
  expect(alert?.textContent ?? "").toContain("Hourly action limit exceeded");
});

it("closes the report dialog when submitting a report succeeds", async () => {
  installNetwork(200);
  await mountApp(opened);
  await flush();
  setStoreState({ viewer: makeViewerSession() });
  await flush();

  await openReport();
  await submitReport();

  expect(document.querySelector('textarea[aria-label="Additional details"]')).toBeNull();
});
