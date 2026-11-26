// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FeedMarketCard } from "../src/components/FeedMarketCard.tsx";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
environment.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

function renderCard(resolvedOutcome: "yes" | "no" | null): string {
  act(() => {
    root?.render(
      <FeedMarketCard
        marketId="pred-test"
        question="Will the test pass?"
        yesOddsPct={62}
        status="resolved"
        resolvedOutcome={resolvedOutcome}
      />,
    );
  });
  return container?.textContent ?? "";
}

it('a resolved market with an unknown outcome renders "Resolved", not "Resolved NO" (spec/markets/prediction.md, "Resolution declassifies the hidden outcome, publishes the proof, and pays 1 pt (100 cents) per winning share idempotently")', () => {
  const text = renderCard(null);
  expect(text).toContain("Resolved");
  expect(text).not.toContain("Resolved NO");
});

it("a resolved market with a known outcome still names the winning side", () => {
  expect(renderCard("yes")).toContain("Resolved YES");
  expect(renderCard("no")).toContain("Resolved NO");
});
