// @vitest-environment happy-dom
// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadPnlHistory } from "../src/web/store-world.ts";
import { makeViewerSession } from "./app-test-helpers.tsx";

type Pending = { resolve: (value: Response) => void };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installQueryFetch() {
  const pending = new Map<string, Pending>();
  const fetchMock: typeof fetch = (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, "https://feed.fun");
    return new Promise<Response>((resolve) => {
      pending.set(`${url.pathname}?${url.searchParams.toString()}`, { resolve });
    });
  };
  vi.stubGlobal("fetch", fetchMock);
  return pending;
}

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

async function seedLoadedAll(pending: Map<string, Pending>) {
  const load = loadPnlHistory("ALL");
  pending.get("/api/economy/me/pnl-history?range=ALL")?.resolve(jsonResponse(pnlBody(1528)));
  await load;
  expect(getStoreSnapshot().pnlHistory.at(-1)?.value).toBe(15.28);
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
    const pending = installQueryFetch();
    await seedLoadedAll(pending);
    const failing = loadPnlHistory("1D");
    pending.get("/api/economy/me/pnl-history?range=1D")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
  });

  it('restores the loaded period, not an intermediate switch, when the newest switch fails (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installQueryFetch();
    await seedLoadedAll(pending);
    const first = loadPnlHistory("1D");
    const second = loadPnlHistory("1W");
    pending.get("/api/economy/me/pnl-history?range=1W")?.resolve(jsonResponse({ message: "boom" }, 500));
    await second;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
    pending.get("/api/economy/me/pnl-history?range=1D")?.resolve(jsonResponse(pnlBody(11100)));
    await first;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=boom");
  });

  it('still applies a successful switch (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installQueryFetch();
    await seedLoadedAll(pending);
    const switching = loadPnlHistory("1W");
    pending.get("/api/economy/me/pnl-history?range=1W")?.resolve(jsonResponse(pnlBody(22200)));
    await switching;
    expect(chartSummary()).toBe("range=1W last=222 loading=false error=none");
  });

  it('keeps a same-period refresh failure silent (spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit")', async () => {
    resetWallet();
    const pending = installQueryFetch();
    await seedLoadedAll(pending);
    const failing = loadPnlHistory();
    pending.get("/api/economy/me/pnl-history?range=ALL")?.resolve(jsonResponse({ message: "boom" }, 500));
    await failing;
    expect(chartSummary()).toBe("range=ALL last=15.28 loading=false error=none");
  });
});
