import type { ComponentProps } from "react";
import { Search, Sparkles } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { type AgentHostId, type AgentHostLauncher, type AgentLogoKey, defaultAgentLaunchers } from "../lib/hosts.ts";
import { Button } from "./Button.tsx";

const marks: Record<AgentLogoKey, string> = {
  Cursor: new URL("../assets/agent-logos/cursor.svg", import.meta.url).href,
  Claude: new URL("../assets/agent-logos/claude.svg", import.meta.url).href,
  ChatGPT: new URL("../assets/agent-logos/chatgpt.svg", import.meta.url).href,
  Grok: new URL("../assets/agent-logos/grok.svg", import.meta.url).href,
  "Meta AI (Muse Spark)": new URL("../assets/agent-logos/meta-ai.svg", import.meta.url).href,
  OpenClaw: new URL("../assets/agent-logos/openclaw.svg", import.meta.url).href,
  "Hermes Agent": new URL("../assets/agent-logos/hermes-agent.svg", import.meta.url).href,
};

const sizeMap = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

export type AgentMarkProps = Omit<ComponentProps<"span">, "children"> & {
  /** The agent client whose mask mark is rendered. */
  agent: AgentLogoKey;
  /** Shows the client name beside the mark; hidden visually, it stays the accessible name. */
  showName?: boolean;
  /** Visual size of the mark. */
  size?: keyof typeof sizeMap;
};

/** Renders an AI agent client logo via CSS mask over `currentColor`. */
export function AgentMark({ agent, showName = false, size = "md", className, ...props }: AgentMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)} {...props}>
      <span aria-hidden className={cn(sizeMap[size], "shrink-0 bg-current mask-contain mask-center mask-no-repeat")} style={{ maskImage: `url("${marks[agent]}")` }} />
      <span className={showName ? undefined : "sr-only"}>{agent}</span>
    </span>
  );
}

export type AgentHostGridProps = {
  /** Launchers shown in the selector grid. */
  launchers?: AgentHostLauncher[];
  /** Invoked when a host launcher button is clicked. */
  onSelectHost?: (hostId: AgentHostId) => void;
  /** Disables all host buttons. */
  disabled?: boolean;
};

/** Responsive launcher grid for the nine supported Feed MCP agent hosts. */
export function AgentHostGrid({ launchers = defaultAgentLaunchers, onSelectHost, disabled = false }: AgentHostGridProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {launchers.map((host) => (
        <Button
          key={host.id}
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onSelectHost?.(host.id)}
          className="h-10 justify-start px-3"
        >
          {host.mark ? (
            <AgentMark agent={host.mark} size="sm" />
          ) : host.id === "HostGemini" ? (
            <Sparkles aria-hidden className="size-4 shrink-0" />
          ) : (
            <Search aria-hidden className="size-4 shrink-0" />
          )}
          <span className="truncate">{host.label}</span>
        </Button>
      ))}
    </div>
  );
}
