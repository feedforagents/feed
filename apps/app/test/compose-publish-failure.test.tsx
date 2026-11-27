// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { expect, it } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { composerTextarea, flush, installAppTestLifecycle, installMockNetwork, makeAuthMeResponse, makeRawPost, makeViewerSession, mountApp, openComposeDialogForTest, setControlValue } from "./app-test-helpers.tsx";

const roots: Root[] = [];

installAppTestLifecycle(roots, () => {
  setStoreState({ toasts: [], errorMessage: null, composeOpen: false, quotePostTarget: null, viewer: null, route: "Home" });
});

function installNetwork(postStatus: number): void {
  installMockNetwork((path, _url, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/posts" && method === "POST") {
      if (postStatus === 200) {
        return makeRawPost(Date.now(), { id: "post-new", content: "Draft that must survive" });
      }
      return Response.json({ error: { code: "RateLimited", message: "Hourly action limit exceeded" } }, { status: postStatus });
    }
    if (path === "/api/auth/me") return makeAuthMeResponse();
    return undefined;
  });
}

async function mountSignedInApp(postStatus: number): Promise<void> {
  installNetwork(postStatus);
  await mountApp(roots);
  await flush();
  setStoreState({ viewer: makeViewerSession({ accountId: "acct-player-1", displayName: "Alice Trader" }) });
  await flush();
}

function dialogElement(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("compose dialog not found");
  return dialog;
}

async function openCompose(): Promise<void> {
  await openComposeDialogForTest(() => { storeActions.openComposeDialog(null); });
}

async function typeDraft(text: string): Promise<void> {
  await setControlValue(composerTextarea(), text);
}

async function submitCompose(): Promise<void> {
  const button = [...dialogElement().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Post");
  if (!button) throw new Error("Post button not found");
  act(() => { button.click(); });
  await flush();
}

it("keeps the draft and shows the failure inside the compose dialog when publishing fails", async () => {
  await mountSignedInApp(429);
  await openCompose();
  await typeDraft("Draft that must survive");
  await submitCompose();

  expect(composerTextarea().value).toBe("Draft that must survive");
  const alert = dialogElement().querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("Hourly action limit exceeded");
});

it("closes the compose dialog and clears the draft when publishing succeeds", async () => {
  await mountSignedInApp(200);
  await openCompose();
  await typeDraft("Draft that must survive");
  await submitCompose();

  expect(document.querySelector('[role="dialog"] textarea[aria-label="Post text"]')).toBeNull();
  await openCompose();
  expect(composerTextarea().value).toBe("");
});
