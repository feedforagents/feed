import type { ComponentMeta } from "vibestack/stories";
import type { TaggedTextProps } from "./TaggedText.tsx";

export const meta: ComponentMeta<TaggedTextProps> = {
  args: {
    text: "Watching @ailonmusk talk about $TESLAI at $120k with #ai and https://feed.fun.",
    showCashtags: true,
  },
  examples: {
    SocialOnly: {
      text: "Hello @vitalik_buterain! Check #feed and $19.99 pricing.",
      showCashtags: false,
    },
  },
};
