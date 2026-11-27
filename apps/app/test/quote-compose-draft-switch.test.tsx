// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { decodePost, type AppPost } from "../src/web/types.ts";
import { flush, installAppTestLifecycle, installMockNetwork, makeRawPost, makeViewerSession, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", composeOpen: false, quotePostTarget: null });
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

function makePost(id: string, content: string): AppPost {
  const post = decodePost(makeRawPost(1_700_000_000_000, { id, content }), "acct-player-1");
  if (!post) throw new Error(`failed to decode ${id}`);
  return post;
}

function composerTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea[aria-label="Post text"]');
  if (!textarea) throw new Error("composer textarea not found");
  return textarea;
}

async function mountSignedInApp(): Promise<void> {
  installMockNetwork(respond);
  await mountApp(opened);
  await flush();
  setStoreState({ viewer: makeViewerSession({ accountId: "acct-player-1", displayName: "Alice Trader" }) });
  await flush();
}

async function openQuote(post: AppPost): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    act(() => { storeActions.openComposeDialog(post); });
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

it("clears the quote draft when the compose dialog reopens for a different post", async () => {
  await mountSignedInApp();

  const postA = makePost("post-a", "Post A body");
  const postB = makePost("post-b", "Post B body");

  await openQuote(postA);
  await typeDraft("Draft written for post A");
  expect(composerTextarea().value).toBe("Draft written for post A");

  act(() => { storeActions.closeComposeDialog(); });
  await flush();
  await openQuote(postB);

  expect(document.body.textContent).toContain("Post B body");
  expect(composerTextarea().value).toBe("");
});

it("keeps the quote draft when the compose dialog reopens for the same post", async () => {
  await mountSignedInApp();

  const postA = makePost("post-a", "Post A body");

  await openQuote(postA);
  await typeDraft("Draft written for post A");

  act(() => { storeActions.closeComposeDialog(); });
  await flush();
  await openQuote(postA);

  expect(composerTextarea().value).toBe("Draft written for post A");
});
