import { type ComponentProps, useState } from "react";
import { ChevronDown, ChevronUp, Link2, ShieldCheck, Unplug } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { type AgentHostId, type AgentHostLauncher, type AgentLogoKey, defaultAgentLaunchers, defaultSkillPrompt } from "../lib/hosts.ts";
import { AgentHostGrid, AgentMark } from "./AgentMark.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./AlertDialog.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { CommandBlock } from "./CommandBlock.tsx";

export interface AgentGrantSummary {
  /** Active OAuth or device-flow grant identifier. */
  grantId: string;
  /** Display name of the single connected client. */
  clientName: string;
  /** Optional matching mask mark key. */
  agentMark?: AgentLogoKey;
  /** Granted MVP scopes from `spec/auth/agentGrant.md`. */
  scopes: {
    read: boolean;
    socialWrite: boolean;
    messages: boolean;
    trade: boolean;
  };
  /** Formatted timestamp when the grant was installed. */
  connectedAt: string;
  /** Formatted timestamp of the most recent attributed action. */
  lastUsedAt: string;
}

export interface AgentRateLimitUsage {
  /** Action category label (e.g. `"Posts / hr"`). */
  label: string;
  /** Calls consumed in the current window. */
  used: number;
  /** Maximum calls allowed in the current window. */
  limit: number;
}

export type AgentConnectCardProps = Omit<ComponentProps<"div">, "children"> & {
  /** Currently active single grant, or `null` when disconnected. */
  grant?: AgentGrantSummary | null;
  /** One-click launchers shown when connecting or switching an agent. */
  launchers?: AgentHostLauncher[];
  /** Canonical `SKILL.md` prompt shown when connecting a client. */
  skillPrompt?: string;
  /** Direct MCP endpoint URL displayed with a copyable JSON snippet. */
  mcpUrl?: string;
  /** Optional rate-limit usage meters for the connected agent. */
  rateLimits?: AgentRateLimitUsage[];
  /** Opens the `/link` device pairing flow. */
  onOpenLink?: () => void;
  /** Revokes the currently connected grant. */
  onRevoke?: (grantId: string) => void;
  /** Triggers a host launcher. */
  onSelectHost?: (hostId: AgentHostId) => void;
  /** Clipboard callback forwarded to `CommandBlock`. */
  onCopyPrompt?: (prompt: string) => Promise<void>;
  /** True while revocation is in flight. */
  revoking?: boolean;
  /** True while grant state is loading. */
  loading?: boolean;
  /** Disables interactive controls. */
  disabled?: boolean;
};

const scopeEntries = [
  ["read", "read"],
  ["socialWrite", "social:write"],
  ["messages", "messages"],
  ["trade", "trade"],
] as const;

function buildMcpJsonSnippet(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        feed: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );
}

function McpSetupSection({
  launchers,
  skillPrompt,
  mcpUrl,
  blocked,
  onSelectHost,
  onCopyPrompt,
  onOpenLink,
}: {
  readonly launchers: AgentHostLauncher[];
  readonly skillPrompt: string;
  readonly mcpUrl: string;
  readonly blocked: boolean;
  readonly onSelectHost?: (hostId: AgentHostId) => void;
  readonly onCopyPrompt?: (prompt: string) => Promise<void>;
  readonly onOpenLink?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <AgentHostGrid launchers={launchers} onSelectHost={onSelectHost} disabled={blocked} />
      <CommandBlock
        layout="inline"
        command={skillPrompt}
        label="Feed agent skill prompt"
        copyLabel="Copy SKILL.md prompt"
        copyLabels={{ ready: "Copy", copied: "Copied", failed: "Select text" }}
        onCopy={onCopyPrompt}
      />
      <div className="flex flex-col gap-2">
        <CommandBlock
          layout="inline"
          command={mcpUrl}
          label="MCP endpoint URL"
          copyLabel="Copy MCP URL"
          copyLabels={{ ready: "Copy", copied: "Copied", failed: "Select URL" }}
        />
        <CodeBlock code={buildMcpJsonSnippet(mcpUrl)} label="MCP client JSON config" />
      </div>
      {onOpenLink ? (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" disabled={blocked} onClick={() => !blocked && onOpenLink()}>
            <Link2 aria-hidden className="size-4" />
            Pair via /link code
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Displays the account's single connected AI agent grant with scopes, rate-limit usage, collapsible host switchers, and revoke confirmation.
 * @model spec/auth/agentGrant.md
 */
export function AgentConnectCard({
  grant = null,
  launchers = defaultAgentLaunchers,
  skillPrompt = defaultSkillPrompt,
  mcpUrl = "https://feed.fun/mcp",
  rateLimits,
  onOpenLink,
  onRevoke,
  onSelectHost,
  onCopyPrompt,
  revoking = false,
  loading = false,
  disabled = false,
  className,
  ...props
}: AgentConnectCardProps) {
  const [showSwitchers, setShowSwitchers] = useState(false);
  const blocked = disabled || loading || revoking;

  if (grant) {
    const activeScopes = scopeEntries.filter(([key]) => grant.scopes[key]);
    return (
      <div className={cn("flex flex-col gap-4 rounded-lg border border-border bg-background p-4 text-foreground", className)} {...props}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {grant.agentMark ? (
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
                <AgentMark agent={grant.agentMark} size="md" />
              </div>
            ) : (
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-primary">
                <ShieldCheck aria-hidden className="size-5" />
              </div>
            )}
            <div className="flex flex-col gap-0.5">
              <h3 className="text-base leading-none font-semibold">{grant.clientName}</h3>
              <p className="text-sm text-muted-foreground">Connected {grant.connectedAt} · Last used {grant.lastUsedAt}</p>
            </div>
          </div>
          <Badge variant="ok">Active</Badge>
        </div>

        <div className="flex flex-col gap-3">
          <div role="group" aria-label="Granted scopes" className="flex flex-wrap gap-1.5">
            {activeScopes.map(([, label]) => (
              <Badge key={label} variant="outline" className="font-mono">
                {label}
              </Badge>
            ))}
          </div>

          {rateLimits && rateLimits.length > 0 ? (
            <dl className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-xs sm:grid-cols-3">
              {rateLimits.map((item) => (
                <div key={item.label} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">{item.label}</dt>
                  <dd className="font-mono font-semibold text-foreground tabular-nums">
                    {item.used} / {item.limit}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <button
              type="button"
              disabled={blocked}
              aria-expanded={showSwitchers}
              onClick={() => setShowSwitchers((prev) => !prev)}
              className="flex items-center justify-between text-left text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>Switch agent</span>
              {showSwitchers ? <ChevronUp aria-hidden className="size-4" /> : <ChevronDown aria-hidden className="size-4" />}
            </button>
            {showSwitchers ? (
              <McpSetupSection
                launchers={launchers}
                skillPrompt={skillPrompt}
                mcpUrl={mcpUrl}
                blocked={blocked}
                onSelectHost={onSelectHost}
                onCopyPrompt={onCopyPrompt}
                onOpenLink={onOpenLink}
              />
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          {onOpenLink ? (
            <Button variant="outline" size="sm" disabled={blocked} onClick={() => !blocked && onOpenLink()}>
              <Link2 aria-hidden className="size-4" />
              Pair via /link
            </Button>
          ) : (
            <span />
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" loading={revoking || loading} disabled={blocked}>
                <Unplug aria-hidden className="size-4" />
                Revoke grant
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Revoke {grant.clientName}?</AlertDialogTitle>
              <AlertDialogDescription>
                This immediately disconnects {grant.clientName} from your Feed account. You can reconnect an agent anytime.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel asChild>
                  <Button variant="outline" size="sm">
                    Cancel
                  </Button>
                </AlertDialogCancel>
                <AlertDialogAction asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={blocked}
                    onClick={() => {
                      if (!blocked) onRevoke?.(grant.grantId);
                    }}
                  >
                    Revoke access
                  </Button>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4 rounded-lg border border-border bg-background p-4 text-foreground", className)} {...props}>
      <div className="flex flex-col gap-1">
        <h3 className="text-base leading-none font-semibold">Connect an AI agent</h3>
        <p className="text-sm text-muted-foreground">Link one AI agent to post, chat, and trade from your Feed account.</p>
      </div>
      <McpSetupSection
        launchers={launchers}
        skillPrompt={skillPrompt}
        mcpUrl={mcpUrl}
        blocked={blocked}
        onSelectHost={onSelectHost}
        onCopyPrompt={onCopyPrompt}
        onOpenLink={onOpenLink}
      />
    </div>
  );
}
