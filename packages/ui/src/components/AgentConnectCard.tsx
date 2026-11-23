import type { ComponentProps } from "react";
import { ShieldCheck, Unplug } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { type AgentHostId, type AgentHostLauncher, type AgentLogoKey, defaultAgentLaunchers, defaultSkillPrompt } from "../lib/hosts.ts";
import { AgentHostGrid, AgentMark } from "./AgentMark.tsx";
import { Alert } from "./Alert.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./Card.tsx";
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

export type AgentConnectCardProps = Omit<ComponentProps<"div">, "children"> & {
  /** Currently active single grant, or `null` when disconnected. */
  grant?: AgentGrantSummary | null;
  /** One-click launchers shown when no agent is connected. */
  launchers?: AgentHostLauncher[];
  /** Canonical `SKILL.md` prompt shown when connecting a client. */
  skillPrompt?: string;
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

/**
 * Displays the account's single connected AI agent grant (at most one active) with scopes, last-used timing, revocation, and host launchers.
 * @model spec/auth/agentGrant.md
 */
export function AgentConnectCard({
  grant = null,
  launchers = defaultAgentLaunchers,
  skillPrompt = defaultSkillPrompt,
  onRevoke,
  onSelectHost,
  onCopyPrompt,
  revoking = false,
  loading = false,
  disabled = false,
  className,
  ...props
}: AgentConnectCardProps) {
  const blocked = disabled || loading || revoking;

  if (grant) {
    const activeScopes = scopeEntries.filter(([key]) => grant.scopes[key]);
    return (
      <Card className={cn("gap-4", className)} {...props}>
        <CardHeader className="flex-row items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {grant.agentMark ? (
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-foreground">
                <AgentMark agent={grant.agentMark} size="md" />
              </div>
            ) : (
              <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-primary">
                <ShieldCheck aria-hidden className="size-5" />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <CardTitle>{grant.clientName}</CardTitle>
              <CardDescription>Connected {grant.connectedAt} · Last used {grant.lastUsedAt}</CardDescription>
            </div>
          </div>
          <Badge variant="ok">Active</Badge>
        </CardHeader>
        <CardContent>
          <div role="group" aria-label="Granted scopes" className="flex flex-wrap gap-1.5">
            {activeScopes.map(([, label]) => (
              <Badge key={label} variant="outline" className="font-mono">
                {label}
              </Badge>
            ))}
          </div>
          <Alert variant="info">
            One agent per account. Authorizing another client automatically revokes this grant.
          </Alert>
        </CardContent>
        <CardFooter>
          <Button
            variant="destructive"
            size="sm"
            loading={revoking || loading}
            disabled={blocked}
            onClick={() => {
              if (!blocked) onRevoke?.(grant.grantId);
            }}
          >
            <Unplug aria-hidden className="size-4" />
            Revoke grant
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className={cn("gap-4", className)} {...props}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Connect an AI agent</CardTitle>
          <Badge variant="outline">0 of 1 connected</Badge>
        </div>
        <CardDescription>Authorize one MCP client at a time via OAuth 2.1 or device code.</CardDescription>
      </CardHeader>
      <CardContent>
        <AgentHostGrid launchers={launchers} onSelectHost={onSelectHost} disabled={blocked} />
        <CommandBlock
          layout="inline"
          command={skillPrompt}
          label="Feed agent skill prompt"
          copyLabel="Copy SKILL.md prompt"
          copyLabels={{ ready: "Copy", copied: "Copied", failed: "Select text" }}
          onCopy={onCopyPrompt}
        />
      </CardContent>
    </Card>
  );
}
