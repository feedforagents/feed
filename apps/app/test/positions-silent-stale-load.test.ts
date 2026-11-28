// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMarkets, loadPositionsSilent } from "../src/web/store-world.ts";
import { installFetch, jsonResponse, marketsResponse, unexpectedResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

const preTradeMarketsBody = {
  predictions: [],
  perps: [],
  positions: { predictionPositions: [] },
};

function seedPositions() {
  setStoreState({
    viewer: aliceViewer,
    positions: [],
    predictions: [],
    perps: [],
    marketsLoading: false,
    errorMessage: null,
    toasts: [],
    route: "Home",
    walletView: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("silent positions load ordering", () => {
  it("does not let a silent load that started before a markets refresh overwrite its fresher positions", async () => {
    seedPositions();
    let marketsCalls = 0;
    let releaseSilent: ((response: Response) => void) | null = null;
    installFetch((url, method) => {
      if (method === "GET" && url.pathname === "/api/markets") {
        marketsCalls += 1;
        if (marketsCalls === 1) {
          return new Promise<Response>((resolve) => {
            releaseSilent = resolve;
          });
        }
        return Promise.resolve(marketsResponse(200));
      }
      return unexpectedResponse(url, method);
    });
    const silent = loadPositionsSilent();
    await loadMarkets();
    expect(getStoreSnapshot().positions.map((p) => p.marketId)).toEqual(["pred-a"]);
    releaseSilent?.(jsonResponse(preTradeMarketsBody));
    await silent;
    expect(getStoreSnapshot().positions.map((p) => p.marketId)).toEqual(["pred-a"]);
  });

  it("applies a silent load when no markets load intervenes", async () => {
    seedPositions();
    installFetch((url, method) =>
      method === "GET" && url.pathname === "/api/markets"
        ? Promise.resolve(marketsResponse(200))
        : unexpectedResponse(url, method),
    );
    await loadPositionsSilent();
    expect(getStoreSnapshot().positions.map((p) => p.marketId)).toEqual(["pred-a"]);
  });
});
