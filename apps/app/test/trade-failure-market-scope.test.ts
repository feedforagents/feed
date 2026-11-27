// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { submitPredictionOrder } from "../src/web/store-world.ts";
import { navigate } from "../src/web/store.ts";
import { installDeferredFetch, jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer } from "./moderation-fixtures.ts";

function errorResponse(message: string, status = 500): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function resetTradeStore() {
  setStoreState({
    viewer: aliceViewer,
    route: "Markets",
    walletView: false,
    marketsViewMode: "terminal",
    selectedMarketKind: "prediction",
    selectedMarketId: "pred-a",
    selectedTicker: null,
    predictions: [],
    perps: [],
    positions: [],
    tradeLoading: false,
    tradeError: null,
    errorMessage: null,
  });
}

async function navigateToMarket(pending: ReturnType<typeof installDeferredFetch>, path: string) {
  const nav = navigate(path);
  pending.get("GET /api/markets")?.resolve(jsonResponse({ predictions: [], perps: [], positions: [] }));
  pending.get("GET /api/world/status")?.resolve(jsonResponse({}));
  await nav;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trade failure market scope", () => {
  it('shows the failure on the market that was traded (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTradeStore();
    const pending = installDeferredFetch();
    const submit = submitPredictionOrder("pred-a", "Buy", "yes", 10);
    pending.get("POST /api/markets/predictions/pred-a/buy")?.resolve(errorResponse("Market closed"));
    await expect(submit).resolves.toBe(false);
    expect(getStoreSnapshot().tradeError).toBe("Market closed");
    expect(getStoreSnapshot().tradeLoading).toBe(false);
  });

  it('does not carry a failed trade message to another market opened by URL (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTradeStore();
    const pending = installDeferredFetch();
    const submit = submitPredictionOrder("pred-a", "Buy", "yes", 10);
    pending.get("POST /api/markets/predictions/pred-a/buy")?.resolve(errorResponse("Market closed"));
    await submit;
    expect(getStoreSnapshot().tradeError).toBe("Market closed");
    await navigateToMarket(pending, "/markets/predictions/pred-b");
    expect(getStoreSnapshot().selectedMarketId).toBe("pred-b");
    expect(getStoreSnapshot().tradeError).toBeNull();
  });

  it('does not land an in-flight trade failure on a market opened while it was submitting (spec/markets/prediction.md, "Story: Open and trade a prediction market")', async () => {
    resetTradeStore();
    const pending = installDeferredFetch();
    const submit = submitPredictionOrder("pred-a", "Buy", "yes", 10);
    await navigateToMarket(pending, "/markets/predictions/pred-b");
    pending.get("POST /api/markets/predictions/pred-a/buy")?.resolve(errorResponse("Market closed"));
    await expect(submit).resolves.toBe(false);
    expect(getStoreSnapshot().selectedMarketId).toBe("pred-b");
    expect(getStoreSnapshot().tradeError).toBeNull();
    expect(getStoreSnapshot().tradeLoading).toBe(false);
  });
});
