// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { flush, installAppTestLifecycle, installMockNetwork, makeRawPost, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, route: "Home", activePostId: null, activeThread: null, feedPosts: [] });
});

const createdAt = Date.now() - 60_000;
const postA = makeRawPost(createdAt, { id: "post-a", content: "Post A market note", replyCount: 1 });
const postB = makeRawPost(createdAt + 1000, {
  id: "post-b",
  authorId: "bob",
  authorHandle: "bob",
  authorDisplayName: "Bob Builder",
  content: "Bob reply to A",
  replyToPostId: "post-a",
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") {
    return {
      authenticated: true,
      viewer: {
        accountId: "alice",
        handle: "alice",
        displayName: "Alice Player",
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
      acceptedCountries: ["+1"],
      publicAppUrl: window.location.origin,
      devSmsCodeEnabled: true,
    };
  }
  if (path === "/api/posts/post-a") return { post: postA, replies: [postB] };
  if (path === "/api/posts/post-b") return { post: postB, replies: [] };
  if (path === "/api/feed") return { items: [], nextCursor: null };
  if (path === "/api/trending") return { trending: [] };
  if (path === "/api/articles") return { articles: [] };
  if (path === "/api/markets") return { predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } };
  if (path === "/api/world/status") {
    return {
      currentDay: 3,
      currentHour: 14,
      phase: "active",
      gameRunning: true,
      lastTickAt: Date.now(),
      activeMarketsCount: 0,
      totalPostsCount: 0,
      activeActorsCount: 5,
    };
  }
  return undefined;
}

function replyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>("#thread-reply-composer");
  if (!el) throw new Error("reply composer not found");
  return el;
}

async function typeReply(container: HTMLElement, text: string): Promise<void> {
  const el = replyTextarea(container);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the native value setter is invoked with the textarea as its receiver below
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function openPostAWithDraft(): Promise<HTMLElement> {
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();
  await act(async () => {
    await storeActions.navigate("/post/post-a");
  });
  await flush();
  expect(container.textContent).toContain("Post A market note");
  await typeReply(container, "Draft written for post A");
  expect(replyTextarea(container).value).toBe("Draft written for post A");
  return container;
}

it('Opening another post clears the reply draft written for the previous post (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithDraft();

  await act(async () => {
    await storeActions.navigate("/post/post-b");
  });
  await flush();

  expect(container.textContent).toContain("Bob reply to A");
  expect(replyTextarea(container).value).toBe("");
});

it('Reloading the same post thread keeps the reply draft (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithDraft();

  await act(async () => {
    await storeActions.openThread("post-a", "newest");
  });
  await flush();

  expect(replyTextarea(container).value).toBe("Draft written for post A");
});
