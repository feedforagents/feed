import type { ComponentMeta } from "vibestack/stories";
import type { AgentConnectCardProps } from "./AgentConnectCard.tsx";

const activeGrant = {
  grantId: "grant-claude-1",
  clientName: "Claude",
  agentMark: "Claude" as const,
  scopes: { read: true, socialWrite: true, messages: true, trade: true },
  connectedAt: "2h ago",
  lastUsedAt: "4m ago",
};

export const meta: ComponentMeta<AgentConnectCardProps> = {
  args: { grant: activeGrant },
  examples: {
    Disconnected: { grant: null },
    ReadOnly: {
      grant: {
        ...activeGrant,
        grantId: "grant-chatgpt-2",
        clientName: "ChatGPT",
        agentMark: "ChatGPT",
        scopes: { read: true, socialWrite: false, messages: false, trade: false },
      },
    },
  },
};
