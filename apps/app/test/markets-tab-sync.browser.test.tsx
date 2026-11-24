// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";

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

function perp(ticker: string, name: string) {
  return {
    ticker,
    name,
    indexPriceCents: 10000,
    markPriceCents: 10100,
    fundingRateBps: 10,
    openInterestCents: 50000,
    history: [
      { label: "Index", value: 100 },
      { label: "Mark", value: 101 },
    ],
  };
}

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
  perps: [perp("TSLAI", "Tesla AI"), perp("NVDAI", "Nvidia AI")],
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

function activeTabPanelText(): string {
  return document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent ?? "";
}

async function mountApp() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
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
    selectedMarketKind: "prediction",
    selectedMarketId: null,
    marketsTab: "predictions",
    localUiMode: "game",
    joinSheetOpen: false,
    joinTab: "phone",
    joinPhoneStep: "entry",
    activeThread: null,
    threadLoading: false,
  });
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('Markets tab follows the selected market when navigating to /markets?ticker=... while already on Markets (spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement")', async () => {
  installMockNetwork();
  await mountApp();

  await act(() => storeActions.navigate("/markets"));
  await vi.waitFor(() => {
    expect(activeTabPanelText()).toContain("Will OpenAGI ship Strawberry-9000 before Friday?");
  });

  const positionsTab = page.getByRole("tab", { name: "Positions (0)" });
  await act(() => userEvent.click(positionsTab));
  await expect.element(page.getByText("Sign in to view open positions")).toBeInTheDocument();

  await act(() => storeActions.navigate("/markets?ticker=TSLAI"));
  await vi.waitFor(() => {
    expect(activeTabPanelText()).toContain("$TSLAI Spot Index & Mark");
    expect(activeTabPanelText()).not.toContain("Will OpenAGI ship Strawberry-9000 before Friday?");
  });
  expect(getStoreSnapshot().marketsTab).toBe("perps");
  expect(getStoreSnapshot().selectedMarketId).toBe("TSLAI");
});

it('Back/forward to /markets?ticker=... selects that market and switches the tab (spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement")', async () => {
  installMockNetwork();
  await mountApp();

  await act(() => storeActions.navigate("/markets"));
  await vi.waitFor(() => {
    expect(activeTabPanelText()).toContain("Will OpenAGI ship Strawberry-9000 before Friday?");
  });

  window.history.pushState(null, "", "/markets?ticker=NVDAI");
  window.dispatchEvent(new PopStateEvent("popstate"));
  await vi.waitFor(() => {
    expect(activeTabPanelText()).toContain("$NVDAI Spot Index & Mark");
    expect(activeTabPanelText()).not.toContain("Will OpenAGI ship Strawberry-9000 before Friday?");
  });
  expect(getStoreSnapshot().selectedMarketKind).toBe("perp");
  expect(getStoreSnapshot().selectedMarketId).toBe("NVDAI");
  expect(getStoreSnapshot().marketsTab).toBe("perps");
});
