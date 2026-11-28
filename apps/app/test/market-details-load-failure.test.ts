// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadMarketDetails } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";
import { resetWorldFeedStore, stubFetchUrl } from "./moderation-fixtures.ts";

type PartStatuses = {
  readonly history: number;
  readonly trades: number;
  readonly social: number;
};

function stubMarketParts(statuses: PartStatuses) {
  stubFetchUrl((url) => {
    const path = new URL(url, "https://feed.fun").pathname;
    if (path.endsWith("/history")) {
      return Promise.resolve(
        statuses.history === 200
          ? jsonResponse([])
          : jsonResponse({ message: "market history unavailable" }, statuses.history),
      );
    }
    if (path.endsWith("/trades")) {
      return Promise.resolve(
        statuses.trades === 200
          ? jsonResponse([])
          : jsonResponse({ message: "market trades unavailable" }, statuses.trades),
      );
    }
    if (path === "/api/feed") {
      return Promise.resolve(
        statuses.social === 200
          ? jsonResponse({ items: [], nextCursor: null })
          : jsonResponse({ message: "market posts unavailable" }, statuses.social),
      );
    }
    return Promise.resolve(jsonResponse({ message: `unexpected ${url}` }, 500));
  });
}

function seedMarketDetails() {
  resetWorldFeedStore({
    route: "Markets",
    selectedMarketKind: "prediction",
    selectedMarketId: "mkt-1",
    marketHistory: [],
    marketTrades: [],
    marketSocialPosts: [],
  });
  setStoreState({ errorMessage: null, toasts: [] });
}

async function loadWith(statuses: PartStatuses) {
  seedMarketDetails();
  stubMarketParts(statuses);
  await loadMarketDetails("prediction", "mkt-1");
  return getStoreSnapshot();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("market details load failure", () => {
  it("surfaces a failed history load instead of a silently empty chart", async () => {
    const s = await loadWith({ history: 500, trades: 200, social: 200 });
    expect(s.marketHistoryLoading).toBe(false);
    expect(s.marketTradesLoading).toBe(false);
    expect(s.errorMessage).toBe("market history unavailable");
    expect(s.toasts.some((t) => t.tone === "destructive" && t.message === "market history unavailable")).toBe(true);
  });

  it("surfaces a failed trades load when the history load succeeds", async () => {
    const s = await loadWith({ history: 200, trades: 500, social: 200 });
    expect(s.errorMessage).toBe("market trades unavailable");
  });

  it("surfaces a failed social posts load when history and trades succeed", async () => {
    const s = await loadWith({ history: 200, trades: 200, social: 500 });
    expect(s.errorMessage).toBe("market posts unavailable");
  });

  it("loads every part on success without an error notice", async () => {
    const s = await loadWith({ history: 200, trades: 200, social: 200 });
    expect(s.marketHistory).toEqual([]);
    expect(s.marketTrades).toEqual([]);
    expect(s.errorMessage).toBeNull();
  });
});
