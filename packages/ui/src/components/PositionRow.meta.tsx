import type { ComponentMeta } from "vibestack/stories";
import type { PositionRowProps } from "./PositionRow.tsx";

const perpPosition = {
  id: "pos-1",
  kind: "perp" as const,
  marketLabel: "$SAMALT Perpetual",
  side: "Long" as const,
  quantityLabel: "200 pts",
  leverage: 20,
  entryLabel: "99.50 pts",
  markLabel: "103.15 pts",
  pnlPts: 7.34,
  liquidationLabel: "95.20 pts",
};

const predictionPosition = {
  id: "pos-2",
  kind: "prediction" as const,
  marketLabel: "OpenAI parody NPC ships Q4 leak?",
  side: "YES" as const,
  quantityLabel: "80 shares",
  entryLabel: "0.52 pts",
  markLabel: "0.64 pts",
  pnlPts: 9.6,
};

export const meta: ComponentMeta<PositionRowProps> = {
  args: { position: perpPosition },
  examples: {
    Prediction: { position: predictionPosition },
    LosingShort: {
      position: { ...perpPosition, id: "pos-3", side: "Short", pnlPts: -4.85 },
    },
  },
};
