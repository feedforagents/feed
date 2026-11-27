// @vitest-environment happy-dom
// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadPnlHistory } from "../src/web/store-world.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";
import { installDeferredFetch, jsonResponse, type Deferred } from "./deferred-fetch.ts";

function pnlBody(finalPnlCents: number) {
  return {
    points: [
      { timestamp: 1_700_000_000_000, pnlCents: 0 },
      { timestamp: 1_700_003_600_000, pnlCents: finalPnlCents },
    ],
  };
}

function resetWallet() {
  setStoreState({
    viewer: makeViewerSession(),
    pnlTimeRange: "ALL",
    pnlHistory: [],
    pnlHistoryLoading: false,
    errorMessage: null,
  });
}

async function seedLoadedPeriod(pending: Map<string, Deferred>, range: "ALL" | "1D", finalPnlCents: number) {
  const load = loadPnlHistory(range);
  pending.get(`GET /api/economy/me/pnl-history?range=${range}`)?.resolve(jsonResponse(pnlBody(finalPnlCents)));
  await load;
  expect(getStoreSnapshot().pnlHistory.at(-1)?.value).toBe(finalPnlCents / 100);
}

async function seedLoadedAll(pending: Map<string, Deferred>) {
  await seedLoadedPeriod(pending, "ALL", 1528);
}

function chartSummary(): string {
  const s = getStoreSnapshot();
  return `range=${s.pnlTimeRange} last=${s.pnlHistory.at(-1)?.value ?? "none"} loading=${String(s.pnlHistoryLoading)} error=${s.errorMessage ?? "none"}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wallet PnL period switch failure", () => {
  it('keeps the loaded period label when switching period fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installDeferredFetch();
    await seedLoadedAll(pending);
    const failing = loadPnlHistory("1D");
    pending.get("GET /api/economy/me/pnl-history?range=1D")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
  });

  it('restores a loaded non-ALL period when switching period fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installDeferredFetch();
    await seedLoadedPeriod(pending, "1D", 11100);
    const failing = loadPnlHistory("1W");
    pending.get("GET /api/economy/me/pnl-history?range=1W")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(chartSummary()).toBe("range=1D last=111 loading=false error=boom");
  });

  it('restores the loaded period, not an intermediate switch, when the newest switch fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installDeferredFetch();
    await seedLoadedAll(pending);
    const first = loadPnlHistory("1D");
    const second = loadPnlHistory("1W");
    pending.get("GET /api/economy/me/pnl-history?range=1W")?.resolve(jsonResponse({ message: "boom" }, 500));
    await second;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
    pending.get("GET /api/economy/me/pnl-history?range=1D")?.resolve(jsonResponse(pnlBody(11100)));
    await first;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
  });

  it('still applies a successful switch (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installDeferredFetch();
    await seedLoadedAll(pending);
    const switching = loadPnlHistory("1W");
    pending.get("GET /api/economy/me/pnl-history?range=1W")?.resolve(jsonResponse(pnlBody(22200)));
    await switching;
    expect(chartSummary()).toBe("range=1W last=222 loading=false error=none");
  });

  it('keeps a same-period refresh failure silent (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installDeferredFetch();
    await seedLoadedAll(pending);
    const failing = loadPnlHistory();
    pending.get("GET /api/economy/me/pnl-history?range=ALL")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=none");
  });
});
