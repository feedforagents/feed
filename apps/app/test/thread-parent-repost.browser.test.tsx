// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { setStoreState } from "../src/web/store-core.ts";
import { loadFeed } from "../src/web/store-world.ts";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

const PARENT_POST = {
  id: "thread-parent",
  authorId: "alice",
  authorKind: "human",
  authorHandle: "alice",
  authorDisplayName: "Alice",
  avatarUrl: null,
  isParody: false,
  parodyLabel: null,
  content: "Parent post shown above its thread.",
  replyToPostId: null,
  quotePostId: null,
  viaClientName: null,
  marketId: null,
  ticker: null,
  cashtags: [],
  hashtags: [],
  likeCount: 1,
  repostCount: 7,
  replyCount: 0,
  likedByViewer: false,
  repostedByViewer: false,
  createdAt: Date.now() - 120_000,
};

const CHILD_POST = {
  ...PARENT_POST,
  id: "thread-child",
  authorHandle: "bob",
  authorDisplayName: "Bob",
  content: "Child reply that opens the thread.",
  replyToPostId: "thread-parent",
  likeCount: 5,
  repostCount: 2,
  replyCount: 1,
};

const SAMPLE_MARKETS = {
  predictions: [],
  perps: [],
  positions: [],
  economy: null,
};

type ThreadNetworkOptions = {
  parentInFeed: boolean;
  parentReposted: boolean;
};

function installThreadNetwork(options: ThreadNetworkOptions) {
  class IdleEventSource extends EventTarget {
    close() {}
  }
  let parentReposted = options.parentReposted;
  let parentLiked = false;
  const repostMethods: string[] = [];
  const likeMethods: string[] = [];
  vi.stubGlobal("EventSource", IdleEventSource);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") return Response.json({ authenticated: true, viewer: { accountId: "viewer", handle: "viewer" } });
    if (path === "/api/skills/hosts") return Response.json({ hosts: [] });
    if (path === "/api/feed") {
      const parent = { ...PARENT_POST, repostedByViewer: parentReposted, repostCount: parentReposted ? 8 : 7 };
      return Response.json(options.parentInFeed ? [parent, CHILD_POST] : [CHILD_POST]);
    }
    if (path === "/api/posts/thread-child") {
      return Response.json({
        post: CHILD_POST,
        parentPost: { ...PARENT_POST, repostedByViewer: parentReposted, repostCount: parentReposted ? 8 : 7 },
        replies: [],
      });
    }
    if (path === "/api/posts/thread-parent/repost") {
      const method = init?.method ?? "GET";
      repostMethods.push(method);
      if (method === "POST") parentReposted = true;
      else if (method === "DELETE") parentReposted = false;
      else return Response.json({}, { status: 405 });
      return Response.json({ reposted: parentReposted, repostCount: parentReposted ? 8 : 7 });
    }
    if (path === "/api/posts/thread-parent/like") {
      const method = init?.method ?? "GET";
      likeMethods.push(method);
      if (method === "POST") parentLiked = true;
      else if (method === "DELETE") parentLiked = false;
      else return Response.json({}, { status: 405 });
      return Response.json({ liked: parentLiked, likeCount: parentLiked ? 2 : 1 });
    }
    if (path === "/api/markets") return Response.json(SAMPLE_MARKETS);
    if (path === "/api/explore") return Response.json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return Response.json({ leaderboard: [] });
    if (path === "/api/economy/packs") return Response.json({ packs: [] });
    return Response.json({}, { status: 404 });
  });
  return { repostMethods, likeMethods };
}

async function mountApp() {
  const oldPath = window.location.pathname + window.location.search;
  window.history.replaceState(null, "", "/");
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(() => Promise.resolve(root.render(<App />)));
  await act(() => loadFeed());
  return {
    cleanup: async () => {
      await act(() => Promise.resolve(root.unmount()));
      container.remove();
      setStoreState({
        route: "Home",
        profileHandle: null,
        selectedTicker: null,
        localUiMode: "game",
        joinSheetOpen: false,
        joinTab: "phone",
        joinPhoneStep: "entry",
        feedPosts: [],
        feedLoading: false,
        feedNextCursor: null,
        activeThread: null,
        threadLoading: false,
        statusMessage: null,
        errorMessage: null,
      });
      window.history.replaceState(null, "", oldPath);
      vi.unstubAllGlobals();
    },
  };
}

async function openThreadDialog() {
  await expect.element(page.getByText("Child reply that opens the thread.")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Reply1", exact: true })).toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: "Reply1", exact: true })));
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("Parent post shown above its thread.")).toBeInTheDocument();
  return dialog;
}

it("Thread parent repost updates its card (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const { repostMethods, likeMethods } = installThreadNetwork({ parentInFeed: true, parentReposted: false });
  const { cleanup } = await mountApp();
  try {
    const dialog = await openThreadDialog();

    const parentRepost = dialog.getByRole("button", { name: "Repost7", exact: true });
    await expect.element(parentRepost).toHaveAttribute("aria-pressed", "false");

    await act(() => userEvent.click(parentRepost));
    expect(repostMethods).toEqual(["POST"]);
    await expect.element(dialog.getByRole("button", { name: "Repost8", exact: true })).toHaveAttribute("aria-pressed", "true");

    const parentLike = dialog.getByRole("button", { name: "Like1", exact: true });
    await expect.element(parentLike).toHaveAttribute("aria-pressed", "false");

    await act(() => userEvent.click(parentLike));
    expect(likeMethods).toEqual(["POST"]);
    await expect.element(dialog.getByRole("button", { name: "Like2", exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await cleanup();
  }
});

it("Thread parent repost undo sends DELETE when the parent is outside the feed (spec/social/posts.md, \"Story: Like, repost, follow, and block enforcement\")", async () => {
  const { repostMethods } = installThreadNetwork({ parentInFeed: false, parentReposted: true });
  const { cleanup } = await mountApp();
  try {
    const dialog = await openThreadDialog();

    const parentRepost = dialog.getByRole("button", { name: "Repost8", exact: true });
    await expect.element(parentRepost).toHaveAttribute("aria-pressed", "true");

    await act(() => userEvent.click(parentRepost));
    expect(repostMethods).toEqual(["DELETE"]);
    await expect.element(dialog.getByRole("button", { name: "Repost7", exact: true })).toHaveAttribute("aria-pressed", "false");
  } finally {
    await cleanup();
  }
});
