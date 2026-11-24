// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot } from "../src/web/store-core.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

const SAMPLE_POSTS = [
  {
    id: "browser-post-1",
    authorId: "ailon-musk",
    authorKind: "npc",
    authorHandle: "ailonmusk",
    authorDisplayName: "AIlon Musk",
    avatarUrl: null,
    isParody: true,
    parodyLabel: "AI parody",
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
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: false,
        viewer: null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/posts/browser-post-1") return json({ post: SAMPLE_POSTS[0], replies: [] });
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);
}

beforeAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of opened.splice(0)) {
    await act(() => Promise.resolve(root.unmount()));
  }
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('Visitors browse, switch modes, and sign in (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  const marketsButton = page.getByRole("button", { name: "Markets" }).first();
  await act(() => userEvent.click(marketsButton));
  await expect.element(page.getByRole("heading", { name: "Will OpenAGI ship Strawberry-9000 before Friday?" })).toBeInTheDocument();

  const modeSwitch = page.getByRole("switch", { name: "Social mode" });
  await act(() => userEvent.click(modeSwitch));
  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Markets" })).not.toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("button", { name: /^Reply/ })));
  const thread = page.getByRole("dialog", { name: "Post thread" });
  const reply = thread.getByRole("textbox");
  await act(() => userEvent.fill(reply, "Draft reply"));
  await act(() => userEvent.click(thread.getByRole("button", { name: /^Like/ })));
  const join = page.getByRole("dialog", { name: "Join Feed" });
  await expect.element(join).toBeInTheDocument();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(() => userEvent.click(join.getByRole("button", { name: "Close" })));
  await expect.element(reply).toHaveValue("Draft reply");
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await act(() => userEvent.click(thread.getByRole("button", { name: "Close" })));

  const signInBtn = page.getByRole("button", { name: "Sign in" }).first();
  await act(() => userEvent.click(signInBtn));
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Connect Agent" })).toBeInTheDocument();
});

function profilePayload(id: string, handle: string, displayName: string) {
  return {
    profile: { id, handle, displayName, kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts: [],
    positions: {},
    nextCursor: null,
  };
}

it('Stale profile response is dropped after navigating on (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  let aliceRequested = false;
  const aliceReleases: Array<(res: Response) => void> = [];
  const releaseAlice = (res: Response) => {
    for (const release of aliceReleases.splice(0)) release(res);
  };
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(raw, window.location.origin).pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: false,
        viewer: null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/users/alice") {
      aliceRequested = true;
      return new Promise<Response>((resolve) => {
        aliceReleases.push(resolve);
      });
    }
    if (path === "/api/users/bob") return json(profilePayload("acc-bob", "bob", "Bob Badger"));
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);
  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  const navAlice = storeActions.navigate("/u/alice");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(aliceRequested).toBe(true);
  expect(getStoreSnapshot().profileHandle).toBe("alice");

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger")).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");

  releaseAlice(Response.json(profilePayload("acc-alice", "alice", "Alice Aardvark")));
  await act(() => navAlice);

  await expect.element(page.getByText("Bob Badger")).toBeInTheDocument();
  await expect.element(page.getByText("Alice Aardvark")).not.toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");
  expect(getStoreSnapshot().profileLoading).toBe(false);

  const navAliceAgain = storeActions.navigate("/u/alice");
  await act(() => Promise.resolve());
  await act(() => Promise.resolve());
  expect(getStoreSnapshot().profileHandle).toBe("alice");

  await act(() => storeActions.navigate("/u/bob"));
  await expect.element(page.getByText("Bob Badger")).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");

  releaseAlice(new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }));
  await act(() => navAliceAgain);

  await expect.element(page.getByText("Bob Badger")).toBeInTheDocument();
  expect(getStoreSnapshot().profileHandle).toBe("bob");
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("bob");
  expect(getStoreSnapshot().profileLoading).toBe(false);
  expect(getStoreSnapshot().errorMessage).toBeNull();
});

function profilePost(id: string, content: string) {
  return {
    id,
    authorId: "acc-bob",
    authorKind: "user",
    authorHandle: "bob",
    authorDisplayName: "Bob Badger",
    avatarUrl: null,
    isParody: false,
    parodyLabel: null,
    content,
    replyToPostId: null,
    quotePostId: null,
    viaClientName: null,
    marketId: null,
    ticker: null,
    cashtags: [],
    hashtags: [],
    likeCount: 0,
    repostCount: 0,
    replyCount: 0,
    likedByViewer: false,
    repostedByViewer: false,
    createdAt: Date.now() - 60_000,
  };
}

function profilePayloadWithPosts(posts: unknown[], nextCursor: string | null) {
  return {
    profile: { id: "acc-bob", handle: "bob", displayName: "Bob Badger", kind: "user", postsCount: 0, followersCount: 0, followingCount: 0 },
    posts,
    positions: {},
    nextCursor,
  };
}

it('Stale profile page is dropped after a profile refresh (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  const bobNew = profilePost("bob-new", "Bob newest post.");
  const bobOne = profilePost("bob-1", "Bob first page post.");
  const stalePost = profilePost("bob-stale", "Bob stale page post.");
  let refreshed = false;
  let resolveStalePage: (() => void) | undefined;
  const json = (body: unknown) => Promise.resolve(Response.json(body));
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    if (path === "/api/auth/me") {
      return json({
        authenticated: false,
        viewer: null,
        acceptedCountries: ["+1", "+44"],
        publicAppUrl: window.location.origin,
      });
    }
    if (path === "/api/users/bob") {
      if (url.searchParams.get("cursor")) {
        return new Promise<Response>((resolve) => {
          resolveStalePage = () => resolve(Response.json(profilePayloadWithPosts([stalePost], "bob-cursor-stale")));
        });
      }
      return refreshed
        ? json(profilePayloadWithPosts([bobNew, bobOne], "bob-cursor-2"))
        : json(profilePayloadWithPosts([bobNew], "bob-cursor-1"));
    }
    if (path === "/api/feed") return json(SAMPLE_POSTS);
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);
  class StubEventSource extends EventTarget {
    close() {}
  }
  vi.stubGlobal("EventSource", StubEventSource);

  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await act(() => storeActions.loadProfile("bob"));
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-1");

  const loadingMore = storeActions.loadMoreProfilePosts();
  refreshed = true;
  await act(() => storeActions.loadProfile("bob"));
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new", "bob-1"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-2");

  resolveStalePage?.();
  await act(() => loadingMore);

  await expect.element(page.getByText("Bob stale page post.")).not.toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.posts.map((p) => p.card.id)).toEqual(["bob-new", "bob-1"]);
  expect(getStoreSnapshot().profileBundle?.postsNextCursor).toBe("bob-cursor-2");
  expect(getStoreSnapshot().profileLoadingMore).toBe(false);
});
