// @vitest-environment happy-dom
// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PriceChart } from "@repo/ui";
import { decodePerpMarket } from "../src/web/types.ts";

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
environment.IS_REACT_ACT_ENVIRONMENT = true;

const rawPerp = {
  ticker: "TSLAI",
  indexPriceCents: 10000,
  markPriceCents: 10100,
  fundingRateBps: 5,
  longOiCents: 5000,
  shortOiCents: 5000,
};

describe("Perp chart with no price history", () => {
  it('decodes to empty history instead of an Index/Mark line (spec/app/navigation.md, "Story: Browse public world content without a login wall")', () => {
    const decoded = decodePerpMarket(rawPerp);
    expect(decoded?.history).toEqual([]);
  });

  it('keeps real price history when the server sends it (spec/app/navigation.md, "Story: Browse public world content without a login wall")', () => {
    const decoded = decodePerpMarket({
      ...rawPerp,
      history: [
        { label: "09:00", value: 99 },
        { label: "10:00", value: 101 },
      ],
    });
    expect(decoded?.history).toEqual([
      { label: "09:00", value: 99 },
      { label: "10:00", value: 101 },
    ]);
  });

  it('renders the no-history state instead of a fabricated line (spec/app/navigation.md, "Story: Browse public world content without a login wall")', () => {
    const decoded = decodePerpMarket(rawPerp);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(<PriceChart points={decoded?.history ?? []} title="$TSLAI Spot Index & Mark" ariaLabel="TSLAI price chart" />);
    });
    expect(container.textContent).toContain("No price history yet.");
    expect(container.textContent).not.toContain("Low");
    expect(container.textContent).not.toContain("High");
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
