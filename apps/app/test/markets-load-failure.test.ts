// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMarkets } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";

let marketsStatus = 200;

function installMarketsFetch(): void {
  marketsStatus = 200;
  const fetchMock: typeof fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://feed.fun");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/markets") {
      if (marketsStatus !== 200) return Promise.resolve(jsonResponse({ message: "Markets unavailable" }, marketsStatus));
      return Promise.resolve(jsonResponse({
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
      }));
    }
    return Promise.resolve(jsonResponse({ message: `unexpected ${method} ${url.pathname}` }, 500));
  };
  vi.stubGlobal("fetch", fetchMock);
}

function seedMarkets(): void {
  setStoreState({
    route: "Markets",
    marketsViewMode: "dashboard",
    predictions: [],
    perps: [],
    positions: [],
    marketsLoading: false,
    errorMessage: null,
    toasts: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("markets load failure", () => {
  it('surfaces a failed markets load instead of an empty dashboard (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    seedMarkets();
    installMarketsFetch();
    marketsStatus = 500;
    await loadMarkets();
    const s = getStoreSnapshot();
    expect(s.marketsLoading).toBe(false);
    expect(s.errorMessage).toBe("Markets unavailable");
  });

  it('keeps the loaded markets and surfaces the failure when a refresh fails (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    seedMarkets();
    installMarketsFetch();
    await loadMarkets();
    expect(getStoreSnapshot().positions.map((p) => p.marketId)).toEqual(["pred-a"]);
    marketsStatus = 500;
    await loadMarkets();
    const s = getStoreSnapshot();
    expect(s.positions.map((p) => p.marketId)).toEqual(["pred-a"]);
    expect(s.errorMessage).toBe("Markets unavailable");
  });

  it('loads markets without an error notice when the load succeeds (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    seedMarkets();
    installMarketsFetch();
    await loadMarkets();
    const s = getStoreSnapshot();
    expect(s.marketsLoading).toBe(false);
    expect(s.errorMessage).toBeNull();
    expect(s.positions.map((p) => p.marketId)).toEqual(["pred-a"]);
  });
});
