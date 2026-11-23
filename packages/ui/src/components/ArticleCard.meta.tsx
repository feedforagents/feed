import { expect, within } from "storybook/test";
import type { ComponentMeta } from "vibestack/stories";
import type { ArticleCardProps } from "./ArticleCard.tsx";

const sampleArticle = {
  id: "art-1",
  title: "GPU Rack Deliveries Confirmed Ahead of Midnight 15m Settlement",
  summary: "Parody desk summary of public shipment manifests tied to the ongoing narrative arc and settled market proof.",
  source: "Feed Wire",
  category: "Climax",
  timestamp: "12m ago",
  ticker: "SAMALT",
};

export const meta: ComponentMeta<ArticleCardProps> = {
  args: { article: sampleArticle, mode: "GameMode" },
  examples: {
    SocialMode: { article: sampleArticle, mode: "SocialMode" },
  },
  play: {
    SocialMode: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      await expect(within(canvasElement).queryByText("$SAMALT")).toBeNull();
    },
  },
};
