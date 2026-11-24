// @vitest-environment happy-dom
// spec/markets/prediction.md, "Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact"; spec/markets/prediction.md, "Resolution declassifies the hidden outcome, publishes the proof, and pays 1 pt (100 cents) per winning share idempotently"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { TradeTicket, type TradeTicketProps } from "../src/components/TradeTicket.tsx";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
environment.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function renderTicket(props: TradeTicketProps): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<TradeTicket {...props} />);
  });
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

const baseProps: TradeTicketProps = {
  marketKind: "prediction",
  marketTitle: "Will OpenAGI announce GPT-Next compute pricing before Friday close?",
  balancePts: "100 pts",
  yesOddsPct: 54,
  defaultAmount: "10",
  onSubmit: () => {},
};

test('ticket "Est. shares" equals the credited shares for a 10 pt YES buy (spec/markets/prediction.md, "Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact")', () => {
  const container = renderTicket({ ...baseProps, yesShares: 46_000, noShares: 54_000 });
  expect(container.textContent).toContain("1834.00 shares");
});

test('ticket "Est. shares" for a 10 pt NO buy matches the server CPMM shares (spec/markets/prediction.md, "Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact")', () => {
  const container = renderTicket({ ...baseProps, defaultSide: "NO", yesShares: 46_000, noShares: 54_000 });
  expect(container.textContent).toContain("2146.00 shares");
});

test('ticket "Est. shares" without pool reserves uses the credited-share scale (spec/markets/prediction.md, "Buying YES or NO shares requires an open non-expired market, sufficient balance, and bounded odds impact")', () => {
  const container = renderTicket(baseProps);
  expect(container.textContent).toContain("1851.85 shares");
});
