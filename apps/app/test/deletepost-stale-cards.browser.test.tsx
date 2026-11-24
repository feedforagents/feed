// spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import type { ViewerSession } from "../src/web/types.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

const VIEWER: ViewerSession = {
  accountId: "viewer-1",
  handle: "ailonmusk",
  displayName: "AIlon Musk",
  bio: "",
  avatarUrl: null,
  phoneLast2: null,
  uiMode: "game",
  balanceCents: 0,
  startingGrantCents: 0,
  purchasedCents: 0,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

const SAMPLE_POSTS = [
  {
    id: "browser-post-1",
    authorId: "viewer-1",
    authorKind: "user",
    authorHandle: "ailonmusk",
    authorDisplayName: "AIlon Musk",
    avatarUrl: null,
    isParody: false,
    parodyLabel: null,
    content: "Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.",
    replyToPostId: null,
    quotePostId: null,
    viaClientName: null,
    marketId: "seed-market-1",
    ticker: "XTRPC",
    cashtags: ["XTRPC"],
    hashtags: [],
    likeCount: 14,
    repostCount: 3,
    replyCount: 1,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt: Date.now() - 60_000,
  },
];

const SAMPLE_MARKETS = {
  predictions: [
    {
      id: "seed-market-1",
      slotIndex: 0,
      question: "Will OpenAGI ship Strawberry-9000 before Friday?",
      description: "Virtual prediction market",
      category: "tech",
      timeframe: "1d",
      phase: "opening",
      yesShares: 500,
      noShares: 500,
      liquidityCents: 100_000,
      yesProbabilityBps: 5000,
      noProbabilityBps: 5000,
      status: "open",
      resolvedOutcome: null,
      resolutionProof: null,
      resolutionArticleId: null,
      expiresAt: Date.now() + 3_600_000,
      resolvedAt: null,
      createdAt: Date.now() - 300_000,
    },
  ],
  perps: [],
  positions: [],
  economy: null,
};

function installMockNetwork() {
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/auth/me") {
      return json({
        authenticated: true,
        viewer: VIEWER,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (url.pathname === "/api/feed") return json(SAMPLE_POSTS);
    if (url.pathname === "/api/markets") return json(SAMPLE_MARKETS);
    if (url.pathname === "/api/explore") {
      return json({ trending: [], articles: [], search: { posts: SAMPLE_POSTS, accounts: [], markets: [] } });
    }
    if (url.pathname === "/api/users/ailonmusk") {
      return json({
        profile: { id: "viewer-1", handle: "ailonmusk", displayName: "AIlon Musk", kind: "user", postsCount: 1 },
        posts: SAMPLE_POSTS,
        positions: [],
      });
    }
    if (url.pathname === "/api/posts/browser-post-1") {
      if (method === "DELETE") return json({});
      return json({ post: SAMPLE_POSTS[0], parentPost: null, replies: [] });
    }
    if (url.pathname === "/api/leaderboard") return json({ leaderboard: [] });
    if (url.pathname === "/api/economy/packs") return json({ packs: [] });
    if (url.pathname === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

async function mountApp() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
}

async function seedLists() {
  // bootStore() only runs once (store.ts `booted` flag), so later tests set the
  // viewer explicitly instead of relying on boot's hydrateAuth.
  await act(() => setStoreState({ viewer: VIEWER }));
  await act(() => storeActions.loadExplore());
  await act(() => storeActions.loadProfile("ailonmusk"));
  await vi.waitFor(() => {
    const s = getStoreSnapshot();
    expect(s.feedPosts).toHaveLength(1);
    expect(s.explore.posts).toHaveLength(1);
    expect(s.profileBundle?.posts).toHaveLength(1);
  });
}

async function deleteOwnPostFromThread() {
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  const replyButton = page.getByRole("button", { name: /Reply/ }).first();
  await act(() => userEvent.click(replyButton));
  await expect.element(page.getByRole("button", { name: "Delete post" })).toBeInTheDocument();
  await act(() => userEvent.click(page.getByRole("button", { name: "Delete post" })));
  await vi.waitFor(() => {
    expect(getStoreSnapshot().feedPosts).toHaveLength(0);
  });
}

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  setStoreState({
    route: "Home",
    profileHandle: null,
    selectedTicker: null,
    feedPosts: [],
    explore: { trending: [], articles: [], posts: [], accounts: [], actors: [], organizations: [] },
    profileBundle: null,
    activeThread: null,
    viewer: null,
    localUiMode: "game",
  });
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('Deleting a post removes its card from Explore (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  installMockNetwork();
  await mountApp();
  await seedLists();
  await deleteOwnPostFromThread();
  await vi.waitFor(() => {
    expect(getStoreSnapshot().explore.posts).toHaveLength(0);
  });
  expect(getStoreSnapshot().profileBundle?.posts).toHaveLength(0);
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).not.toBeInTheDocument();
});

it('Deleting a post removes its card from the author Profile (spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution")', async () => {
  installMockNetwork();
  await mountApp();
  await seedLists();
  await deleteOwnPostFromThread();
  await vi.waitFor(() => {
    expect(getStoreSnapshot().profileBundle?.posts).toHaveLength(0);
  });
  expect(getStoreSnapshot().explore.posts).toHaveLength(0);
});
