// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { App } from "../src/web/App.tsx";
import { storeActions } from "../src/web/store.ts";

const opened: Root[] = [];
const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;

const sources: EventTarget[] = [];

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
    if (path === "/api/feed") return json([]);
    if (path === "/api/markets") return json(SAMPLE_MARKETS);
    if (path === "/api/explore") return json({ trending: [], articles: [], search: { posts: [], accounts: [], markets: [] } });
    if (path === "/api/leaderboard") return json({ leaderboard: [] });
    if (path === "/api/economy/packs") return json({ packs: [] });
    if (path === "/api/skills/hosts") return json({ skillUrl: `${window.location.origin}/SKILL.md`, mcpUrl: `${window.location.origin}/mcp`, hosts: [] });
    return json({});
  };
  vi.stubGlobal("fetch", fetchMock);

  class StubEventSource extends EventTarget {
    constructor() {
      super();
      sources.push(this);
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
  sources.splice(0);
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

afterAll(() => {
  environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

async function renderApp() {
  installMockNetwork();
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  opened.push(root);
  await act(() => Promise.resolve(root.render(<App />)));
}

it('Trending perp opens its chart (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await renderApp();

  await act(() => storeActions.navigate("/markets"));
  await expect.element(page.getByRole("button", { name: "Trade YES / NO" })).toBeInTheDocument();
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").not.toContain("$TSLAI Spot Index & Mark");
    },
    { timeout: 5000 },
  );

  await act(() => storeActions.navigate("/markets?ticker=TSLAI"));
  await expect.element(page.getByText("$TSLAI Spot Index & Mark")).toBeInTheDocument();

  await act(() => storeActions.navigate("/markets?ticker=NVDAI"));
  await expect.element(page.getByText("$NVDAI Spot Index & Mark")).toBeInTheDocument();
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").not.toContain("$TSLAI Spot Index & Mark");
    },
    { timeout: 5000 },
  );
});

it('Fresh perp entry opens its chart (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await renderApp();

  await act(() => storeActions.navigate("/markets?ticker=TSLAI"));
  await expect.element(page.getByText("$TSLAI Spot Index & Mark")).toBeInTheDocument();
});

it('Prediction selection follows back to its tab (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await renderApp();

  await act(() => storeActions.navigate("/markets?ticker=TSLAI"));
  await expect.element(page.getByText("$TSLAI Spot Index & Mark")).toBeInTheDocument();

  act(() => storeActions.selectMarket("prediction", "seed-market-1"));
  await expect.element(page.getByRole("button", { name: "Trade YES / NO" })).toBeInTheDocument();
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").not.toContain("$TSLAI Spot Index & Mark");
    },
    { timeout: 5000 },
  );
});

it('Hand-picked tabs stay put (spec/app/navigation.md, "Story: Browse public world content without a login wall")', async () => {
  await renderApp();

  await act(() => storeActions.navigate("/markets?ticker=TSLAI"));
  await expect.element(page.getByText("$TSLAI Spot Index & Mark")).toBeInTheDocument();

  await act(() => userEvent.click(page.getByRole("tab", { name: "Predictions" })));
  await expect.element(page.getByRole("button", { name: "Trade YES / NO" })).toBeInTheDocument();
  await vi.waitFor(
    () => {
      expect(document.body.textContent ?? "").not.toContain("$TSLAI Spot Index & Mark");
    },
    { timeout: 5000 },
  );

  await act(() => userEvent.click(page.getByRole("tab", { name: "Perps (20x)" })));
  await expect.element(page.getByText("$TSLAI Spot Index & Mark")).toBeInTheDocument();
});
