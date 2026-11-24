// @vitest-environment happy-dom
// spec/markets/prediction.md, "Selling shares floors gross proceeds to whole cents before charging the canonical fee"; spec/shared/money.md, "Every trade pays a 0.1% fee rounded up to whole cents on the settled amount"
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import { TradeTicket } from "../src/components/TradeTicket.tsx";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
environment.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function feeShown(props: { defaultAction?: "Buy" | "Sell"; defaultSide?: "YES" | "NO"; defaultAmount?: string; yesOddsPct?: number }): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <TradeTicket
        marketKind="prediction"
        marketTitle="Seed market"
        balancePts="100"
        yesOddsPct={props.yesOddsPct ?? 54}
        defaultAction={props.defaultAction ?? "Sell"}
        defaultSide={props.defaultSide ?? "YES"}
        defaultAmount={props.defaultAmount ?? "1834"}
        onSubmit={() => {}}
      />,
    );
  });
  const feeTerm = [...container.querySelectorAll("dt")].find((term) => term.textContent === "Fee (10 bps)");
  const feeValue = feeTerm?.parentElement?.querySelector("dd")?.textContent;
  if (feeValue === undefined) throw new Error("Fee row not rendered");
  return feeValue;
}

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";
});

test("sell mode shows the receipt fee for the seeded sell-all (spec/markets/prediction.md, \"Selling shares floors gross proceeds to whole cents before charging the canonical fee\")", () => {
  expect(feeShown({ defaultAmount: "1834" })).toBe("0.01 pts");
  expect(feeShown({ defaultAmount: "100000" })).toBe("0.54 pts");
  expect(feeShown({ defaultAmount: "1834", defaultSide: "NO" })).toBe("0.01 pts");
});

test("buy mode fee is unchanged (spec/shared/money.md, \"Every trade pays a 0.1% fee rounded up to whole cents on the settled amount\")", () => {
  expect(feeShown({ defaultAction: "Buy", defaultAmount: "10" })).toBe("0.01 pts");
  expect(feeShown({ defaultAction: "Buy", defaultAmount: "100" })).toBe("0.10 pts");
});
