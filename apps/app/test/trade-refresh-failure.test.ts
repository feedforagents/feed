// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMarkets, submitPredictionOrder } from "../src/web/store-world.ts";
import { installDeferredFetchQueue, installFetch, jsonResponse, marketsResponse, unexpectedResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

function installTradeFetch(marketsStatus: number, buyStatus = 200) {
  installFetch((url, method) => {
    if (method === "POST" && url.pathname === "/api/markets/predictions/pred-a/buy") {
      return Promise.resolve(
        buyStatus === 200
          ? jsonResponse({ balanceAfterCents: 7500 })
          : jsonResponse({ message: "Market closed for trading" }, buyStatus),
      );
    }
    if (method === "GET" && url.pathname === "/api/markets") {
      return Promise.resolve(marketsResponse(marketsStatus));
    }
    return unexpectedResponse(url, method);
  });
}

function seedTrade(): void {
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
}

async function runBuy(marketsStatus: number, buyStatus = 200) {
  seedTrade();
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

  it.each([
    { latestStatus: 500, staleStatus: 200, warning: true, positionIds: [] },
    { latestStatus: 200, staleStatus: 500, warning: false, positionIds: ["pred-a"] },
  ])('uses the newer market refresh outcome after a successful buy (HTTP $latestStatus) (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async ({ latestStatus, staleStatus, warning, positionIds }) => {
    seedTrade();
    const queue = installDeferredFetchQueue();
    const marketsKey = "GET /api/markets";
    const trade = submitPredictionOrder("pred-a", "Buy", "yes", 25);
    queue.resolveOldest("POST /api/markets/predictions/pred-a/buy", jsonResponse({ balanceAfterCents: 7500 }));
    await vi.waitFor(() => expect(getStoreSnapshot().marketsLoading).toBe(true));

    const newerRefresh = loadMarkets();
    queue.resolveOldest(marketsKey, marketsResponse(staleStatus));
    queue.resolveNewest(marketsKey, marketsResponse(latestStatus));
    const [ok] = await Promise.all([trade, newerRefresh]);

    const s = getStoreSnapshot();
    expect({
      ok,
      balance: s.viewer?.balanceCents,
      tradeError: s.tradeError,
      positions: s.positions.map((p) => p.marketId),
      warning: s.errorMessage?.includes("could not be refreshed") ?? false,
    }).toEqual({ ok: true, balance: 7500, tradeError: null, positions: positionIds, warning });
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
