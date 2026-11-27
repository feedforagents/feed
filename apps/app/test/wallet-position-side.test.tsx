// @vitest-environment happy-dom
// spec/markets/economy.md, "Story: Trade with fixed starting capital and rank by net profit"
import { act } from "react";
import type { Root } from "react-dom/client";
import { expect, it } from "vitest";
import { getStoreSnapshot, setStoreState } from "../src/web/store-core.ts";
import { decodePositions } from "../src/web/types.ts";
import { flush, installAppTestLifecycle, installMockNetwork, makeViewerSession, mountApp } from "./app-test-helpers.tsx";

const opened: Root[] = [];

installAppTestLifecycle(opened, () => {
  setStoreState({ viewer: null, positions: [], route: "Home", walletView: false, selectedMarketSide: "YES" });
});

function respond(path: string): unknown {
  if (path === "/api/auth/me") {
    return {
      authenticated: true,
      viewer: makeViewerSession({ balanceCents: 10500, startingGrantCents: 10000 }),
      acceptedCountries: ["+1"],
      publicAppUrl: window.location.origin,
      devSmsCodeEnabled: true,
    };
  }
  return undefined;
}

async function mountWalletWithPositions(): Promise<HTMLElement> {
  installMockNetwork(respond);
  const { container } = await mountApp(opened);
  await flush();
  const positions = decodePositions({
    predictionPositions: [
      {
        marketId: "mkt-rain",
        side: "no",
        shares: 1978,
        costBasisCents: 1000,
        estimatedValueCents: 1028,
        question: "Will it rain tomorrow?",
        yesPriceBps: 5200,
        noPriceBps: 4800,
        settledAt: null,
      },
      {
        marketId: "mkt-sun",
        side: "yes",
        shares: 1500,
        costBasisCents: 800,
        estimatedValueCents: 850,
        question: "Will it be sunny tomorrow?",
        yesPriceBps: 5700,
        noPriceBps: 4300,
        settledAt: null,
      },
    ],
  });
  act(() => {
    setStoreState({
      route: "Markets",
      walletView: true,
      viewer: makeViewerSession({ balanceCents: 10500, startingGrantCents: 10000 }),
      positions,
    });
  });
  await flush();
  return container;
}

function positionButton(container: HTMLElement, question: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(question));
  if (!button) {
    const s = getStoreSnapshot();
    throw new Error(
      `position button not found: ${question}; route=${s.route} wallet=${String(s.walletView)} viewer=${s.viewer?.handle ?? "null"} positions=${s.positions.length} text=${(container.textContent ?? "").slice(0, 400)}`,
    );
  }
  return button;
}

it("opens the terminal on the NO side when the NO wallet position row is selected", async () => {
  const container = await mountWalletWithPositions();
  act(() => {
    positionButton(container, "Will it rain tomorrow?").click();
  });
  await flush();
  const s = getStoreSnapshot();
  expect(s.selectedMarketId).toBe("mkt-rain");
  expect(s.selectedMarketSide).toBe("NO");
});

it("opens the terminal on the YES side when the YES wallet position row is selected", async () => {
  const container = await mountWalletWithPositions();
  act(() => {
    positionButton(container, "Will it be sunny tomorrow?").click();
  });
  await flush();
  const s = getStoreSnapshot();
  expect(s.selectedMarketId).toBe("mkt-sun");
  expect(s.selectedMarketSide).toBe("YES");
});
