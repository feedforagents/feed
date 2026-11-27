// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { flush, installAppTestLifecycle, installStubEventSource, makeRawPost, makeViewerSession, mountApp, stubFetchByUrl } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", composeOpen: false, quotePostTarget: null, toasts: [], errorMessage: null });
});

function installNetwork(postStatus: number): void {
  installStubEventSource();
  stubFetchByUrl((url, init) => {
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/posts" && method === "POST") {
      if (postStatus === 200) {
        return Promise.resolve(Response.json(makeRawPost(Date.now(), { id: "post-new", content: "Draft that must survive" })));
      }
      return Promise.resolve(
        Response.json({ error: { code: "RateLimited", message: "Hourly action limit exceeded" } }, { status: postStatus }),
      );
    }
    if (path === "/api/auth/me") {
      return Promise.resolve(
        Response.json({
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
        }),
      );
    }
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

async function mountSignedInApp(postStatus: number): Promise<void> {
  installNetwork(postStatus);
  await mountApp(opened);
  await flush();
  setStoreState({ viewer: makeViewerSession({ accountId: "acct-player-1", displayName: "Alice Trader" }) });
  await flush();
}

function dialogElement(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("compose dialog not found");
  return dialog;
}

function composerTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Post text"]');
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

async function openCompose(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    act(() => { storeActions.openComposeDialog(null); });
    await flush();
    if (document.querySelector('[role="dialog"] textarea[aria-label="Post text"]')) return;
  }
  throw new Error("compose dialog did not open");
}

async function typeDraft(text: string): Promise<void> {
  const textarea = composerTextarea();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
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
