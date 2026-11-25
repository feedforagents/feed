import type { ComponentMeta } from "vibestack/stories";
import { fn } from "storybook/test";
import type { WalletPanelProps } from "./WalletPanel.tsx";

const now = 1_750_000_000_000;

export const meta: ComponentMeta<WalletPanelProps> = {
  args: {
    summary: {
      equityPts: 134.8,
      cashPts: 72.4,
      openPositionsValuePts: 62.4,
      netProfitPts: 34.8,
      roiPct: 34.8,
      feesPaidPts: 1.45,
    },
    pnlHistory: [
      { time: now - 3_600_000 * 5, value: 0 },
      { time: now - 3_600_000 * 4, value: -6.2 },
      { time: now - 3_600_000 * 3, value: 4.5 },
      { time: now - 3_600_000 * 2, value: 18.1 },
      { time: now - 3_600_000, value: 26.4 },
      { time: now, value: 34.8 },
    ],
    pnlTimeRange: "1D",
    onPnlTimeRangeChange: fn(),
    openPositions: [
      {
        id: "open-1",
        kind: "perp",
        marketLabel: "$SAMALT Perp",
        side: "Long",
        sizeLabel: "200 pts",
        leverage: 10,
        entryLabel: "102.00 pts",
        markLabel: "106.50 pts",
        pnlPts: 8.82,
        pnlPct: 44.1,
        liquidationLabel: "92.82 pts",
        liquidationDistancePct: 12.8,
      },
      {
        id: "open-2",
        kind: "perp",
        marketLabel: "$ELONX Perp",
        side: "Short",
        sizeLabel: "150 pts",
        leverage: 20,
        entryLabel: "87.10 pts",
        markLabel: "89.80 pts",
        pnlPts: -4.65,
        pnlPct: -62.0,
        liquidationLabel: "92.10 pts",
        liquidationDistancePct: 2.6,
      },
      {
        id: "open-3",
        kind: "prediction",
        marketLabel: "Will OpenAI parody announce GPT-6 before Friday?",
        side: "YES",
        sizeLabel: "32.5 sh",
        entryLabel: "58.0%",
        markLabel: "68.4%",
        pnlPts: 3.38,
        pnlPct: 17.9,
      },
    ],
    closedPositions: [
      {
        id: "cl-1",
        kind: "perp",
        marketLabel: "$ANTHRO Perp",
        side: "Long",
        realizedPnlPts: 19.4,
        realizedPnlPct: 38.8,
        closedAtLabel: "2h ago",
      },
      {
        id: "cl-2",
        kind: "prediction",
        marketLabel: "GPU spot index above 120 pts?",
        side: "NO",
        realizedPnlPts: -7.2,
        realizedPnlPct: -24.0,
        closedAtLabel: "1d ago",
      },
    ],
    ledgerEntries: [
      { id: "l-1", timestampLabel: "Today 13:10", eventLabel: "Perp Open · $SAMALT", deltaPts: -20.2, balanceAfterPts: 72.4 },
      { id: "l-2", timestampLabel: "Today 11:02", eventLabel: "Perp Close · $ANTHRO", deltaPts: 19.4, balanceAfterPts: 92.6 },
      { id: "l-3", timestampLabel: "Yesterday", eventLabel: "Starting Grant", deltaPts: 100, balanceAfterPts: 100 },
    ],
    onClosePosition: fn(),
    onSelectPosition: fn(),
  },
  examples: {
    Loading: {
      loading: true,
    },
    Empty: {
      summary: {
        equityPts: 100,
        cashPts: 100,
        openPositionsValuePts: 0,
        netProfitPts: 0,
        roiPct: 0,
        feesPaidPts: 0,
      },
      pnlHistory: [],
      openPositions: [],
      closedPositions: [],
      ledgerEntries: [{ id: "grant", timestampLabel: "Just now", eventLabel: "Starting Grant", deltaPts: 100, balanceAfterPts: 100 }],
    },
  },
};
