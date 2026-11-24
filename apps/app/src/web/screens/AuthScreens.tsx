// spec/auth/oauth.md, "Story: Authorize headless agents through RFC 8628 device flow at `/link`"; spec/auth/oauth.md, "Story: Authorize one MCP client over OAuth 2.1 or Device Flow and rotate tokens safely"
import { useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatPts,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

const ALL_SCOPES = [
  { id: "read", label: "read — read home feed, portfolio, notifications, and quotes" },
  { id: "social:write", label: "social:write — post, reply, like, follow, and toggle mode" },
  { id: "messages", label: "messages — read and send DMs, group chats, and alpha invites" },
  { id: "trade", label: "trade — buy/sell prediction shares and open/close 20x perps" },
] as const;

const CRON_JOBS = [
  "game-tick",
  "markets-tick",
  "npc-tick",
  "organization-tick",
  "article-tick",
  "perp-funding",
  "world-facts",
];

function useScopeSelection() {
  const [scopes, setScopes] = useState<string[]>(ALL_SCOPES.map((sc) => sc.id));
  const toggleScope = (scope: string, checked: boolean) => {
    setScopes((prev) => (checked ? [...new Set([...prev, scope])] : prev.filter((item) => item !== scope)));
  };
  return { scopes, toggleScope };
}

function ScopeChecklist({
  selected,
  onToggle,
}: {
  readonly selected: ReadonlyArray<string>;
  readonly onToggle: (scope: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {ALL_SCOPES.map((scope) => (
        <Label key={scope.id} htmlFor={`scope-${scope.id}`} className="font-normal">
          <Checkbox
            id={`scope-${scope.id}`}
            checked={selected.includes(scope.id)}
            onCheckedChange={(checked) => onToggle(scope.id, checked === true)}
          />
          <span>{scope.label}</span>
        </Label>
      ))}
    </div>
  );
}

export function LinkScreen() {
  const s = useAppStore();
  const initialCode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("user_code") ?? "" : "";
  const [userCode, setUserCode] = useState(initialCode);
  const { scopes, toggleScope } = useScopeSelection();

  const handleApprove = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!s.viewer) {
      storeActions.openJoinSheet("phone");
      return;
    }
    void storeActions.approveDeviceCode(userCode, scopes, false);
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
      <Card className="gap-4 p-5">
        <CardHeader>
          <CardTitle>Connect Headless AI Agent</CardTitle>
          <CardDescription>
            Enter the pairing code from your agent (RFC 8628 Device Flow). Approving replaces any prior active agent grant.
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          {s.viewer?.agentGrant ? (
            <Alert variant="warn">
              Active agent: {s.viewer.agentGrant.clientName}. Approving a new device will revoke it immediately.
            </Alert>
          ) : null}
          {s.linkError ? <Alert variant="destructive">{s.linkError}</Alert> : null}
          {s.linkStatus ? <Alert variant="ok">{s.linkStatus}</Alert> : null}

          <form onSubmit={handleApprove} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-user-code">Pairing code</Label>
              <Input
                id="device-user-code"
                placeholder="FEED-1234"
                value={userCode}
                onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                className="font-mono tracking-wider uppercase"
              />
            </div>

            <ScopeChecklist selected={scopes} onToggle={toggleScope} />

            {s.viewer ? (
              <div className="flex items-center gap-2">
                <Button type="submit" loading={s.linkLoading} disabled={!userCode.trim() || scopes.length === 0}>
                  Approve agent
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={s.linkLoading || !userCode.trim()}
                  onClick={() => { void storeActions.approveDeviceCode(userCode, scopes, true); }}
                >
                  Deny
                </Button>
              </div>
            ) : (
              <Button type="button" onClick={() => storeActions.openJoinSheet("phone")}>
                Sign in with phone to approve
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function OAuthConsentScreen() {
  const s = useAppStore();
  const consent = s.oauthConsent;
  const { scopes, toggleScope } = useScopeSelection();

  if (!s.viewer) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <Card className="gap-4 p-5">
          <CardHeader>
            <CardTitle>Authorize AI Agent</CardTitle>
            <CardDescription>Sign in with your verified phone number to review and approve this OAuth 2.1 request.</CardDescription>
          </CardHeader>
          <CardFooter className="justify-start">
            <Button onClick={() => storeActions.openJoinSheet("phone")}>Sign in to continue</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
      <Card className="gap-4 p-5">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{consent ? `Authorize ${consent.clientName}` : "OAuth 2.1 Consent"}</CardTitle>
            <Badge variant="outline">Single-agent grant</Badge>
          </div>
          <CardDescription>
            {consent ? `Redirect target: ${consent.redirectUri}` : "Loading OAuth authorization details..."}
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          {s.oauthError ? <Alert variant="destructive">{s.oauthError}</Alert> : null}
          {s.viewer.agentGrant || consent?.priorGrantClientName ? (
            <Alert variant="warn">
              Connecting this client immediately revokes your current agent ({consent?.priorGrantClientName ?? s.viewer.agentGrant?.clientName}).
            </Alert>
          ) : null}

          <ScopeChecklist selected={scopes} onToggle={toggleScope} />

          <div className="flex items-center gap-2">
            <Button
              loading={s.oauthLoading}
              disabled={!consent || scopes.length === 0 || s.oauthLoading}
              onClick={() => { void storeActions.submitOAuthDecision(true, scopes); }}
            >
              Approve & connect
            </Button>
            <Button
              variant="outline"
              disabled={!consent || s.oauthLoading}
              onClick={() => { void storeActions.submitOAuthDecision(false, []); }}
            >
              Deny
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function AdminScreen() {
  const s = useAppStore();
  const status = s.adminStatus;
  const [overrideReason, setOverrideReason] = useState("");

  if (!s.viewer?.isAdmin) {
    return (
      <div className="p-4">
        <Alert variant="destructive">Admin access required.</Alert>
      </div>
    );
  }

  const budgetCents = Math.max(1, status?.spend.dailyBudgetCents ?? 10000);
  const committedCents = status?.spend.committedCents ?? 0;
  const pct = Math.min(100, Math.round((committedCents / budgetCents) * 100));

  return (
    <div className="flex flex-col gap-5 p-4">
      {s.adminMessage ? <Alert variant="info">{s.adminMessage}</Alert> : null}

      <Card className="gap-4 p-5">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>World Clock & D-25 Spend Budget</CardTitle>
            <Badge variant={status?.spend.throttleLevel === "ThrottleNormal" ? "ok" : "warn"}>
              {status?.spend.throttleLevel ?? "ThrottleNormal"}
            </Badge>
          </div>
          <CardDescription>
            Day {status?.currentDay ?? 1} · Hour {status?.currentHour ?? 0} · Phase {status?.phase ?? "active"}
          </CardDescription>
        </CardHeader>
        <CardContent className="gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-xs font-mono tabular-nums">
              <span>Committed: {formatPts(committedCents)}</span>
              <span>Budget: {formatPts(budgetCents)} ({pct}%)</span>
            </div>
            <Progress value={pct} aria-label="D-25 daily LLM spend budget" />
            <p className="text-xs text-muted-foreground">
              Max steps {status?.spend.maxStepsAllowed ?? 4} · Batch {status?.spend.effectiveBatchSize ?? 6} · Remaining {`$${(status?.spend.remainingCents ?? 0) / 100}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(15); }}>
              +15m
            </Button>
            <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(60); }}>
              +1h
            </Button>
            <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(480); }}>
              +8h
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-3 p-5">
        <CardHeader>
          <CardTitle>Cron Tick Health</CardTitle>
        </CardHeader>
        <CardContent className="gap-3">
          <div className="flex flex-wrap gap-2">
            {CRON_JOBS.map((job) => (
              <Button key={job} size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron(job); }}>
                Run {job}
              </Button>
            ))}
          </div>
          <Table label="Tick health">
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pending</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Last Success</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(status?.ticks ?? []).map((row) => (
                <TableRow key={row.jobName}>
                  <TableCell className="font-mono text-xs">{row.jobName}</TableCell>
                  <TableCell>
                    <Badge variant={row.lastStatus === "ok" ? "ok" : "warn"}>{row.lastStatus}</Badge>
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">{row.pendingCount}</TableCell>
                  <TableCell className="font-mono tabular-nums">{row.durationMs}ms</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.lastSuccessLabel}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="gap-3 p-5">
        <CardHeader>
          <CardTitle>Manual Hold Markets ({status?.manualHolds.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="gap-3">
          <Input
            aria-label="Admin override reason"
            placeholder="Reason for manual hold override..."
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
          />
          {(status?.manualHolds ?? []).map((hold) => (
            <div key={hold.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{hold.question}</p>
                <p className="text-xs text-muted-foreground">
                  {hold.timeframe} · Expired {hold.expiresLabel}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={s.adminLoading} onClick={() => { void storeActions.adminResolveHold(hold.id, "approve", "yes", overrideReason); }}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={s.adminLoading || !overrideReason.trim()} onClick={() => { void storeActions.adminResolveHold(hold.id, "override", "yes", overrideReason); }}>
                  Override YES
                </Button>
                <Button size="sm" variant="destructive" disabled={s.adminLoading || !overrideReason.trim()} onClick={() => { void storeActions.adminResolveHold(hold.id, "override", "no", overrideReason); }}>
                  Override NO
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
