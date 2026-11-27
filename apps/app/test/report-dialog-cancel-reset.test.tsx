// @vitest-environment happy-dom
// spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { findButtonByText, flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, mountApp, setControlValue } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", reportTarget: null });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") return makeAuthMeResponse();
  return undefined;
}

function detailsInput(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Additional details"]');
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
  await act(() => Promise.resolve(findButtonByText("Harassment")?.click()));
  await flush();
  const details = detailsInput();
  if (!details) throw new Error("details input missing");
  await setControlValue(details, "Details written for post A");

  await act(() => Promise.resolve(findButtonByText("Cancel")?.click()));
  await flush();

  await openReport("post-b", "@carol's post");
  expect(detailsInput()?.value).toBe("");
});
