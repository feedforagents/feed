// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadLeaderboard } from "../src/web/store-world.ts";
import { installDeferredFetch, jsonResponse, type Deferred } from "./deferred-fetch.ts";

function pageBody(handle: string, page: number) {
  return {
    scope: "players",
    metric: "net_profit",
    entries: [
      {
        rank: 1,
        accountId: `acct-${handle}`,
        handle,
        displayName: handle,
        netProfitCents: 500,
        balanceCents: 10500,
        positionValueCents: 0,
        equityCents: 10500,
        startingGrantCents: 10000,
      },
    ],
    page,
    pageSize: 25,
    totalCount: 60,
    totalPages: 3,
    currentUser: null,
  };
}

function resetLeaderboard() {
  setStoreState({
    leaderboard: [],
    leaderboardAudience: "traders",
    leaderboardTimeframe: "ALL",
    leaderboardScope: "players",
    leaderboardMetric: "net_profit",
    leaderboardPage: 1,
    leaderboardTotalPages: 1,
    leaderboardTotalCount: 0,
    leaderboardCurrentUser: null,
    leaderboardLoading: false,
    errorMessage: null,
  });
}

async function seedLoadedLeaderboard(pending: Map<string, Deferred>) {
  const load = loadLeaderboard();
  pending.get("GET /api/leaderboard?scope=players&metric=net_profit&page=1&pageSize=25")?.resolve(jsonResponse(pageBody("alice", 1)));
  await load;
  expect(getStoreSnapshot().leaderboard.map((row) => row.handle)).toEqual(["alice"]);
}

function controlsSummary(): string {
  const s = getStoreSnapshot();
  return `audience=${s.leaderboardAudience} timeframe=${s.leaderboardTimeframe} metric=${s.leaderboardMetric} page=${s.leaderboardPage} rows=${s.leaderboard.map((row) => row.handle).join(",")}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("leaderboard switch failure", () => {
  it('keeps the loaded timeframe label when switching timeframe fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetLeaderboard();
    const pending = installDeferredFetch();
    await seedLoadedLeaderboard(pending);
    const failing = loadLeaderboard({ timeframe: "7D", page: 1 });
    pending
      .get("GET /api/leaderboard?scope=players&metric=net_profit&page=1&pageSize=25&filter=traders&timeframe=7D")
      ?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(controlsSummary()).toBe("audience=traders timeframe=ALL metric=net_profit page=1 rows=alice");
    expect(getStoreSnapshot().leaderboardLoading).toBe(false);
  });

  it('keeps the loaded page when paging fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetLeaderboard();
    const pending = installDeferredFetch();
    await seedLoadedLeaderboard(pending);
    const failing = loadLeaderboard({ page: 2 });
    pending.get("GET /api/leaderboard?scope=players&metric=net_profit&page=2&pageSize=25")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(controlsSummary()).toBe("audience=traders timeframe=ALL metric=net_profit page=1 rows=alice");
  });

  it('restores the loaded controls, not an intermediate switch, when the newest switch fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetLeaderboard();
    const pending = installDeferredFetch();
    await seedLoadedLeaderboard(pending);
    const first = loadLeaderboard({ timeframe: "7D", page: 1 });
    const second = loadLeaderboard({ timeframe: "30D", page: 1 });
    pending
      .get("GET /api/leaderboard?scope=players&metric=net_profit&page=1&pageSize=25&filter=traders&timeframe=30D")
      ?.resolve(jsonResponse({ message: "boom" }, 500));
    await second;
    expect(controlsSummary()).toBe("audience=traders timeframe=ALL metric=net_profit page=1 rows=alice");
    pending
      .get("GET /api/leaderboard?scope=players&metric=net_profit&page=1&pageSize=25&filter=traders&timeframe=7D")
      ?.resolve(jsonResponse(pageBody("bob", 1)));
    await first;
    expect(controlsSummary()).toBe("audience=traders timeframe=ALL metric=net_profit page=1 rows=alice");
  });

  it('still applies a successful switch (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetLeaderboard();
    const pending = installDeferredFetch();
    await seedLoadedLeaderboard(pending);
    const switching = loadLeaderboard({ timeframe: "7D", page: 1 });
    pending
      .get("GET /api/leaderboard?scope=players&metric=net_profit&page=1&pageSize=25&filter=traders&timeframe=7D")
      ?.resolve(jsonResponse(pageBody("bob", 1)));
    await switching;
    expect(controlsSummary()).toBe("audience=traders timeframe=7D metric=net_profit page=1 rows=bob");
  });
});
