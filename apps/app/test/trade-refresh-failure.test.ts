// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { submitPredictionOrder } from "../src/web/store-world.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const viewer = {
  accountId: "alice",
  handle: "alice",
  displayName: "Alice Player",
  bio: "",
  avatarUrl: null,
  bannerUrl: null,
  phoneLast2: null,
  phoneVerifiedAt: null,
  emailMasked: null,
  emailVerifiedAt: null,
  uiMode: "game" as const,
  balanceCents: 10000,
  startingGrantCents: 10000,
  isAdmin: false,
  isReviewer: false,
  agentGrant: null,
};

function installTradeFetch(marketsStatus: number, buyStatus = 200) {
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://feed.fun");
    const method = init?.method ?? "GET";
    if (method === "POST" && url.pathname === "/api/markets/predictions/pred-a/buy") {
      return Promise.resolve(
        buyStatus === 200
          ? jsonResponse({ balanceAfterCents: 7500 })
          : jsonResponse({ message: "Market closed for trading" }, buyStatus),
      );
    }
    if (method === "GET" && url.pathname === "/api/markets") {
      return Promise.resolve(
        marketsStatus === 200
          ? jsonResponse({
              predictions: [],
              perps: [],
              positions: {
                predictionPositions: [
                  {
                    marketId: "pred-a",
                    side: "yes",
                    shares: 4000,
                    costBasisCents: 2500,
                    estimatedValueCents: 2500,
                    question: "Will pred-a happen?",
                    yesPriceBps: 5000,
                    noPriceBps: 5000,
                    settledAt: null,
                  },
                ],
              },
            })
          : jsonResponse({ message: "markets unavailable" }, marketsStatus),
      );
    }
    return Promise.resolve(jsonResponse({ message: `unexpected ${method} ${url.pathname}` }, 500));
  };
  vi.stubGlobal("fetch", fetchMock);
}

function resetTrade() {
  setStoreState({
    viewer,
    positions: [],
    predictions: [],
    perps: [],
    tradeLoading: false,
    tradeError: null,
    marketsLoading: false,
    statusMessage: null,
    errorMessage: null,
    toasts: [],
    walletView: false,
    route: "Markets",
    selectedMarketKind: "prediction",
    selectedMarketId: "pred-a",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trade refresh failure", () => {
  it('reveals a failed position refresh after a successful buy without marking the trade failed (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTrade();
    installTradeFetch(500);
    const ok = await submitPredictionOrder("pred-a", "Buy", "yes", 25);
    const s = getStoreSnapshot();
    expect(ok).toBe(true);
    expect(s.viewer?.balanceCents).toBe(7500);
    expect(s.statusMessage).toBe("Buy YES executed.");
    expect(s.tradeError).toBeNull();
    expect(s.tradeLoading).toBe(false);
    expect(s.positions).toEqual([]);
    expect(s.errorMessage).toContain("could not be refreshed");
  });

  it('applies the refreshed position after a successful buy when the refresh succeeds (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTrade();
    installTradeFetch(200);
    const ok = await submitPredictionOrder("pred-a", "Buy", "yes", 25);
    const s = getStoreSnapshot();
    expect(ok).toBe(true);
    expect(s.viewer?.balanceCents).toBe(7500);
    expect(s.positions.map((p) => p.marketId)).toEqual(["pred-a"]);
    expect(s.errorMessage).toBeNull();
    expect(s.tradeError).toBeNull();
  });

  it('keeps a failed buy a trade failure (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTrade();
    installTradeFetch(200, 500);
    const ok = await submitPredictionOrder("pred-a", "Buy", "yes", 25);
    const s = getStoreSnapshot();
    expect(ok).toBe(false);
    expect(s.tradeError).toBe("Market closed for trading");
    expect(s.viewer?.balanceCents).toBe(10000);
    expect(s.positions).toEqual([]);
  });
});
