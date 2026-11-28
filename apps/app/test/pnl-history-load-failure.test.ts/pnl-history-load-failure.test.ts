// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadPnlHistory } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer, stubFetchUrl } from "./moderation-fixtures.ts";
function installPnlFetch(status: number) {
  stubFetchUrl((url) =>
    new URL(url, "https://feed.fun").pathname === "/api/economy/me/pnl-history"
      ? Promise.resolve(
          status === 200
            ? jsonResponse([{ timestamp: 1700000000000, pnlCents: 500 }])
            : jsonResponse({ message: "pnl history unavailable" }, status),
        )
      : Promise.resolve(jsonResponse({ message: `unexpected ${url}` }, 500)),
  );
}
function seedPnl() {
  setStoreState({
    viewer: aliceViewer,
    pnlHistory: [],
    pnlHistoryLoading: false,
    pnlTimeRange: "ALL",
    errorMessage: null,
    toasts: [],
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("pnl history load failure", () => {
  it("surfaces a failed first load instead of leaving the wallet chart silently empty", async () => {
    seedPnl();
    installPnlFetch(500);
    await loadPnlHistory();
    const s = getStoreSnapshot();
    expect(s.pnlHistoryLoading).toBe(false);
    expect(s.pnlHistory).toEqual([]);
    expect(s.errorMessage).toBe("pnl history unavailable");
    expect(s.toasts.some((t) => t.tone === "destructive" && t.message === "pnl history unavailable")).toBe(true);
  });
  it("stays silent when a background refresh fails after a successful load", async () => {
    seedPnl();
    installPnlFetch(200);
    await loadPnlHistory();
    expect(getStoreSnapshot().pnlHistory).toHaveLength(1);
    installPnlFetch(500);
    await loadPnlHistory();
    const s = getStoreSnapshot();
    expect(s.pnlHistory).toHaveLength(1);
    expect(s.errorMessage).toBeNull();
    expect(s.toasts).toEqual([]);
  });
});
