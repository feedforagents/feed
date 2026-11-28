// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadEconomy } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer, stubFetchUrl } from "./moderation-fixtures.ts";

const economyBody = {
  economy: {
    accountId: "alice-account",
    balanceCents: 12_345,
    positionValueCents: 2_500,
    equityCents: 14_845,
    startingGrantCents: 10_000,
    totalFeesPaidCents: 120,
    netProfitCents: 4_845,
  },
  ledger: [
    {
      id: "ledger-1",
      kind: "grant",
      deltaCents: 10_000,
      balanceAfterCents: 10_000,
      createdAt: 1_700_000_000_000,
    },
  ],
};

function installEconomyFetch(status: number) {
  stubFetchUrl((url) =>
    new URL(url, "https://feed.fun").pathname === "/api/economy/me"
      ? Promise.resolve(
          status === 200
            ? jsonResponse(economyBody)
            : jsonResponse({ message: "economy unavailable" }, status),
        )
      : Promise.resolve(jsonResponse({ message: `unexpected ${url}` }, 500)),
  );
}

function seedEconomy() {
  setStoreState({
    viewer: aliceViewer,
    economy: null,
    ledger: [],
    economyLoading: false,
    errorMessage: null,
    toasts: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("economy load failure", () => {
  it("surfaces the failure instead of leaving the economy screen silently empty", async () => {
    seedEconomy();
    installEconomyFetch(500);
    await loadEconomy();
    const s = getStoreSnapshot();
    expect(s.economyLoading).toBe(false);
    expect(s.economy).toBeNull();
    expect(s.errorMessage).toBe("economy unavailable");
    expect(s.toasts.some((t) => t.tone === "destructive" && t.message === "economy unavailable")).toBe(true);
  });

  it("keeps the loaded balance when a refresh fails and still reports the failure", async () => {
    seedEconomy();
    installEconomyFetch(200);
    await loadEconomy();
    expect(getStoreSnapshot().economy?.balanceCents).toBe(12_345);
    installEconomyFetch(500);
    await loadEconomy();
    const s = getStoreSnapshot();
    expect(s.economy?.balanceCents).toBe(12_345);
    expect(s.ledger).toHaveLength(1);
    expect(s.errorMessage).toBe("economy unavailable");
  });

  it("loads the balance and ledger on success without an error notice", async () => {
    seedEconomy();
    installEconomyFetch(200);
    await loadEconomy();
    const s = getStoreSnapshot();
    expect(s.economy?.equityCents).toBe(14_845);
    expect(s.ledger).toHaveLength(1);
    expect(s.errorMessage).toBeNull();
  });
});
