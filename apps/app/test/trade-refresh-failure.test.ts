// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { submitPredictionOrder } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

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

async function runBuy(marketsStatus: number, buyStatus = 200) {
  setStoreState({
    viewer: aliceViewer,
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
  installTradeFetch(marketsStatus, buyStatus);
  const ok = await submitPredictionOrder("pred-a", "Buy", "yes", 25);
  return { ok, s: getStoreSnapshot() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trade refresh failure", () => {
  it('reveals a failed position refresh after a successful buy without marking the trade failed (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    const { ok, s } = await runBuy(500);
    expect({
      ok,
      balance: s.viewer?.balanceCents,
      status: s.statusMessage,
      tradeError: s.tradeError,
      tradeLoading: s.tradeLoading,
      positions: s.positions,
    }).toEqual({
      ok: true,
      balance: 7500,
      status: "Buy YES executed.",
      tradeError: null,
      tradeLoading: false,
      positions: [],
    });
    expect(s.errorMessage).toContain("could not be refreshed");
  });

  it('applies the refreshed position after a successful buy when the refresh succeeds (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    const { ok, s } = await runBuy(200);
    expect({
      ok,
      balance: s.viewer?.balanceCents,
      positionIds: s.positions.map((p) => p.marketId),
      errorMessage: s.errorMessage,
      tradeError: s.tradeError,
    }).toEqual({
      ok: true,
      balance: 7500,
      positionIds: ["pred-a"],
      errorMessage: null,
      tradeError: null,
    });
  });

  it('keeps a failed buy a trade failure (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    const { ok, s } = await runBuy(200, 500);
    expect({
      ok,
      tradeError: s.tradeError,
      balance: s.viewer?.balanceCents,
      positions: s.positions,
    }).toEqual({
      ok: false,
      tradeError: "Market closed for trading",
      balance: 10000,
      positions: [],
    });
  });
});
