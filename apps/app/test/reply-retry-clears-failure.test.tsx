// @vitest-environment happy-dom
// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, pushToast, setStoreState } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";
import { eventSources, findButtonByText, flush, installAppTestLifecycle, installStubEventSource, makeAuthMeResponse, makeRawPost, makeViewerSession, mountApp, setControlValue, stubFetchByUrl } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, authLoaded: false, route: "Home", activePostId: null, activeThread: null, feedPosts: [], toasts: [] });
});

const createdAt = Date.now() - 60_000;
const postA = makeRawPost(createdAt, { id: "post-a", content: "Post A market note", replyCount: 0 });
const replyNew = makeRawPost(createdAt + 2000, {
  id: "reply-new",
  content: "My reply text",
  replyToPostId: "post-a",
});

let postAttempts = 0;

function installNetwork(): void {
  postAttempts = 0;
  stubFetchByUrl((url, init) => {
    const path = url.pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/auth/me") return Promise.resolve(Response.json(makeAuthMeResponse({ accountId: "alice", displayName: "Alice Player" })));
    if (path === "/api/posts" && method === "POST") {
      postAttempts += 1;
      if (postAttempts === 1) return Promise.resolve(Response.json({ message: "Hourly action limit exceeded" }, { status: 429 }));
      return Promise.resolve(Response.json(replyNew));
    }
    if (path === "/api/posts/post-a") {
      return Promise.resolve(Response.json(postAttempts >= 2 ? { post: { ...postA, replyCount: 1 }, replies: [replyNew] } : { post: postA, replies: [] }));
    }
    if (path === "/api/feed" || path === "/api/posts") return Promise.resolve(Response.json({ items: [], nextCursor: null }));
    if (path === "/api/trending") return Promise.resolve(Response.json({ trending: [] }));
    if (path === "/api/articles") return Promise.resolve(Response.json({ articles: [] }));
    if (path === "/api/markets") return Promise.resolve(Response.json({ predictions: [], perps: [], positions: { predictionPositions: [], perpPositions: [] } }));
    if (path === "/api/world/status") return Promise.resolve(Response.json({ currentDay: 3, currentHour: 14, phase: "active", gameRunning: true, lastTickAt: Date.now(), activeMarketsCount: 0, totalPostsCount: 0, activeActorsCount: 5 }));
    if (path === "/api/chats" || path === "/api/chats/invites") return Promise.resolve(Response.json({ chats: [], invites: [] }));
    if (path === "/api/notifications") return Promise.resolve(Response.json({ items: [], unreadCount: 0 }));
    if (path.startsWith("/api/moderation/")) return Promise.resolve(Response.json({ items: [] }));
    if (path === "/api/skills/hosts") return Promise.resolve(Response.json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] }));
    return Promise.resolve(Response.json({}));
  });
  eventSources.length = 0;
  installStubEventSource(eventSources);
}

function replyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>("#thread-reply-composer");
  if (!el) throw new Error("reply composer not found");
  return el;
}

async function openPostA(container: HTMLElement): Promise<void> {
  if (getStoreSnapshot().viewer === null) {
    setStoreState({ viewer: makeViewerSession({ accountId: "alice", displayName: "Alice Player" }), authLoaded: true });
  }
  await act(async () => {
    await storeActions.navigate("/post/post-a");
  });
  await flush();
  expect(container.textContent).toContain("Post A market note");
}

async function clickReply(container: HTMLElement): Promise<void> {
  const form = replyTextarea(container).closest("form");
  if (!form) throw new Error("reply form not found");
  await act(() => Promise.resolve(form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))));
  await flush();
}

function alertText(container: HTMLElement): string {
  return [...container.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "").join("\n");
}

async function openPostAWithFailedReply(): Promise<HTMLElement> {
  installNetwork();
  const { container } = await mountApp(opened);
  await flush();
  await openPostA(container);
  await setControlValue(replyTextarea(container), "My reply text");
  await clickReply(container);
  expect(postAttempts).toBe(1);
  return container;
}

async function openPostAWithFailedReplyAndTradeFailure(): Promise<HTMLElement> {
  const container = await openPostAWithFailedReply();
  await act(() => Promise.resolve(pushToast("Trade failed", "destructive")));
  await flush();
  expect(alertText(container)).toContain("Hourly action limit exceeded");
  expect(alertText(container)).toContain("Trade failed");
  return container;
}

it('Failed reply keeps its draft, and the successful retry clears the failure notice (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithFailedReply();
  expect(replyTextarea(container).value).toBe("My reply text");
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent ?? "").toContain("Hourly action limit exceeded");
  expect(findButtonByText("Reply", container)?.disabled).toBe(false);

  await clickReply(container);

  expect(postAttempts).toBe(2);
  expect(replyTextarea(container).value).toBe("");
  expect(container.textContent).toContain("My reply text");
  expect(container.textContent).toContain("Reply posted.");
  expect(container.querySelector('[role="alert"]')).toBeNull();

  await act(async () => {
    await storeActions.navigate("/");
  });
  await flush();
  expect(container.textContent).toContain("Reply posted.");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('Leaving the post after a failed reply clears the failure notice (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithFailedReply();
  expect(container.querySelector('[role="alert"]')?.textContent ?? "").toContain("Hourly action limit exceeded");

  await act(async () => {
    await storeActions.navigate("/");
  });
  await flush();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('A successful retry clears only that reply failure notice (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithFailedReplyAndTradeFailure();

  await act(async () => {
    await storeActions.createPost("Reply to B", { replyToPostId: "post-b" });
  });
  await flush();
  expect(alertText(container)).toContain("Hourly action limit exceeded");
  expect(alertText(container)).toContain("Trade failed");

  await clickReply(container);
  expect(alertText(container)).not.toContain("Hourly action limit exceeded");
  expect(alertText(container)).toContain("Trade failed");
  expect(container.textContent).toContain("Reply posted.");

  await act(async () => {
    await storeActions.navigate("/");
  });
  await flush();
  expect(alertText(container)).toContain("Trade failed");
});

it('Going back after a failed reply clears only that reply failure notice (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  const container = await openPostAWithFailedReplyAndTradeFailure();

  await act(async () => {
    window.history.back();
    await flush();
  });
  await flush();

  expect(getStoreSnapshot().route).toBe("Home");
  expect(alertText(container)).not.toContain("Hourly action limit exceeded");
  expect(alertText(container)).toContain("Trade failed");
});
