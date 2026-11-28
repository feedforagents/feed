// spec/markets/prediction.md, "Story: Open and trade a prediction market"
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { loadClosedPositions } from "../src/web/store-world.ts";
import { jsonResponse } from "./deferred-fetch.ts";
import { aliceViewer, stubFetchUrl } from "./moderation-fixtures.ts";

const closedBody = {
  predictionPositions: [
    {
      marketId: "pred-a",
      side: "yes",
      costBasisCents: 2500,
      realizedPnlCents: 1500,
      settledAt: 1_700_000_000_000,
      question: "Will pred-a happen?",
    },
  ],
  perpPositions: [],
};

function installFetch(closedStatus: number) {
  stubFetchUrl((url) =>
    new URL(url, "https://feed.fun").pathname === "/api/markets/positions/closed"
      ? Promise.resolve(
          closedStatus === 200
            ? jsonResponse(closedBody)
            : jsonResponse({ message: "closed positions unavailable" }, closedStatus),
        )
      : Promise.resolve(jsonResponse({ message: `unexpected ${url}` }, 500)),
  );
}

function seed() {
  setStoreState({
    viewer: aliceViewer,
    closedPositions: [],
    closedPositionsLoading: false,
    errorMessage: null,
    toasts: [],
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("closed positions load failure", () => {
  it("surfaces the failure instead of leaving a silent empty list", async () => {
    seed();
    installFetch(500);
    await loadClosedPositions();
    const s = getStoreSnapshot();
    expect(s.closedPositionsLoading).toBe(false);
    expect(s.errorMessage).toBe("closed positions unavailable");
    expect(s.toasts.some((t) => t.tone === "destructive" && t.message === "closed positions unavailable")).toBe(true);
  });

  it("keeps the previously loaded list when a refresh fails", async () => {
    seed();
    installFetch(200);
    await loadClosedPositions();
    expect(getStoreSnapshot().closedPositions).toHaveLength(1);
    installFetch(500);
    await loadClosedPositions();
    const s = getStoreSnapshot();
    expect(s.closedPositions).toHaveLength(1);
    expect(s.errorMessage).toBe("closed positions unavailable");
  });

  it("loads closed positions on success without an error notice", async () => {
    seed();
    installFetch(200);
    await loadClosedPositions();
    const s = getStoreSnapshot();
    expect(s.closedPositions).toHaveLength(1);
    expect(s.errorMessage).toBeNull();
  });
});
