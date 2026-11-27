// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { expect, it } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { findButtonByText, flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, makeViewerSession, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", reportTarget: null, toasts: [], errorMessage: null });
});

function installNetwork(reportStatus: number): void {
  installMockNetwork((path, _url, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/reports" && method === "POST") {
      if (reportStatus === 200) return { id: "report-1", status: "open" };
      return Response.json({ error: { code: "RateLimited", message: "Hourly action limit exceeded" } }, { status: reportStatus });
    }
    if (path === "/api/auth/me") return makeAuthMeResponse();
    return undefined;
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
