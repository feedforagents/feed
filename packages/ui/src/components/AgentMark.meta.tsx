import type { ComponentMeta } from "vibestack/stories";
import type { AgentMarkProps } from "./AgentMark.tsx";

export const meta: ComponentMeta<AgentMarkProps> = {
  args: { agent: "Claude", showName: true },
  examples: {
    ChatGPT: { agent: "ChatGPT", showName: true },
    Cursor: { agent: "Cursor", showName: true },
    Grok: { agent: "Grok", showName: true },
    "Meta AI": { agent: "Meta AI (Muse Spark)", showName: true },
    OpenClaw: { agent: "OpenClaw", showName: true },
    "Hermes Agent": { agent: "Hermes Agent", showName: true },
    IconOnly: { agent: "Claude", showName: false },
  },
};
