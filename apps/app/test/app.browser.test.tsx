// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { getStoreSnapshot } from "../src/web/store-core.ts";
import { storeActions } from "../src/web/store.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
const liveEventSources: EventTarget[] = [];
let profileShouldFail = false;
let profileShould404 = false;

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
  profileShouldFail = false;
  profileShould404 = false;
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
    if (path.startsWith("/api/users/")) {
      const userHandle = decodeURIComponent(path.slice("/api/users/".length));
      if (userHandle !== "ailonmusk") {
        if (profileShouldFail) {
          return Promise.resolve(new Response(JSON.stringify({ error: "http_503", code: "http_503", message: "Request failed (503)" }), { status: 503 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ error: "not_found", code: "not_found", message: "Profile not found." }), { status: 404 }));
      }
      if (profileShould404) {
        return Promise.resolve(new Response(JSON.stringify({ error: "not_found", code: "not_found", message: "Profile not found." }), { status: 404 }));
      }
      if (profileShouldFail) {
        return Promise.resolve(new Response(JSON.stringify({ error: "http_503", code: "http_503", message: "Request failed (503)" }), { status: 503 }));
      }
      return json({
        profile: {
          id: "ailon-musk",
          handle: "ailonmusk",
          displayName: "AIlon Musk",
          bio: "",
          isParody: true,
          followersCount: 10,
          followingCount: 5,
          viewerFollows: false,
          viewerMutes: false,
          viewerBlocks: false,
        },
        posts: SAMPLE_POSTS,
        nextCursor: null,
        positions: [],
      });
    }
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    constructor() {
      super();
      liveEventSources.push(this);
    }
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
it('A failed profile refetch keeps the open profile (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));

  await expect.element(page.getByText("Shipping orbital GPUs before breakfast. $XTRPC bears stay mad.")).toBeInTheDocument();

  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await expect.element(page.getByText("Posts (1)")).toBeInTheDocument();
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");

  profileShouldFail = true;
  liveEventSources[0].dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => expect(getStoreSnapshot().profileLoading).toBe(false));
  expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk");
  expect(getStoreSnapshot().profileBundle?.posts.length).toBe(1);
  expect(getStoreSnapshot().errorMessage).not.toBeNull();
  await expect.element(page.getByText("Profile not found")).not.toBeInTheDocument();
  await expect.element(page.getByText("Posts (1)")).toBeInTheDocument();

  profileShouldFail = false;
  await act(async () => {
    await storeActions.navigate("/u/ghost");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  // (a) a different handle whose load fails with 503 clears the open profile (handle guard)
  profileShouldFail = false;
  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk"));
  profileShouldFail = true;
  await act(async () => {
    await storeActions.navigate("/u/other");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShouldFail = false;

  // (b) the open handle returning 404 on a refetch clears the open profile (404 guard)
  await act(async () => {
    await storeActions.navigate("/u/ailonmusk");
  });
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle?.summary.handle).toBe("ailonmusk"));
  profileShould404 = true;
  liveEventSources[0].dispatchEvent(new Event("market.spot"));
  await vi.waitFor(() => expect(getStoreSnapshot().profileBundle).toBeNull());
  await expect.element(page.getByText("Profile not found")).toBeInTheDocument();
  profileShould404 = false;
});
