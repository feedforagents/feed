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
  EmptyState,
  Input,
  Label,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";
import type { OAuthConsentInfo } from "../types.ts";

const ALL_SCOPES = [
  { id: "read", label: "Read feed, profiles, notifications, and market quotes" },
  { id: "social:write", label: "Post, reply, like, repost, and follow accounts" },
  { id: "messages", label: "Read and send direct messages and group chats" },
  { id: "trade", label: "Trade prediction shares and perpetual markets" },
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

function formatThrottleStatus(raw: string): { readonly label: string; readonly variant: "ok" | "warn" | "destructive" } {
  const normalized = raw.toLowerCase();
  if (normalized.includes("normal")) return { label: "Normal", variant: "ok" };
  if (normalized.includes("pause") || normalized.includes("halt") || normalized.includes("stop")) {
    return { label: "Paused", variant: "destructive" };
  }
  if (normalized.includes("minimal") || normalized.includes("low")) return { label: "Minimal", variant: "warn" };
  if (normalized.includes("reduced") || normalized.includes("throttle")) return { label: "Reduced", variant: "warn" };
  return { label: "Normal", variant: "ok" };
}

function ScopeChecklist({
  selected,
  onToggle,
}: {
  readonly selected: ReadonlyArray<string>;
  readonly onToggle: (scope: string, checked: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
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

function updateScopeSelection(prev: ReadonlyArray<string>, scope: string, checked: boolean): string[] {
  return checked ? [...new Set([...prev, scope])] : prev.filter((item) => item !== scope);
}

export function LinkScreen() {
  const s = useAppStore();
  const initialCode = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("user_code") ?? "" : "";
  const [userCode, setUserCode] = useState(initialCode);
  const [scopes, setScopes] = useState<string[]>(ALL_SCOPES.map((sc) => sc.id));

  const toggleScope = (scope: string, checked: boolean) => {
    setScopes((prev) => updateScopeSelection(prev, scope, checked));
  };

  const handleApprove = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!s.viewer) {
      storeActions.openJoinSheet("phone");
      return;
    }
    void storeActions.approveDeviceCode(userCode, scopes, false);
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <h1 className="text-base font-bold text-foreground">Pair AI Agent</h1>
      </header>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <Card className="gap-4 rounded-xl p-5">
          <CardHeader>
            <CardTitle>Pair your AI agent</CardTitle>
            <CardDescription>
              Enter the pairing code displayed by your agent. Approving replaces any previously connected agent.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            {s.viewer?.agentGrant ? (
              <Alert variant="warn">
                Active agent: {s.viewer.agentGrant.clientName}. Approving a new agent disconnects it immediately.
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
                  <Button type="submit" shape="pill" loading={s.linkLoading} disabled={!userCode.trim() || scopes.length === 0}>
                    Approve agent
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    shape="pill"
                    disabled={s.linkLoading || !userCode.trim()}
                    onClick={() => { void storeActions.approveDeviceCode(userCode, scopes, true); }}
                  >
                    Deny
                  </Button>
                </div>
              ) : (
                <Button type="button" shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
                  Sign in to approve
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ConsentScopeForm({
  consent,
  loading,
}: {
  readonly consent: OAuthConsentInfo;
  readonly loading: boolean;
}) {
  const validInitial = consent.scopes.filter((sc) => ALL_SCOPES.some((def) => def.id === sc));
  const [scopes, setScopes] = useState<string[]>(validInitial.length > 0 ? validInitial : ["read"]);

  const toggleScope = (scope: string, checked: boolean) => {
    setScopes((prev) => updateScopeSelection(prev, scope, checked));
  };

  return (
    <div className="flex flex-col gap-4">
      <ScopeChecklist selected={scopes} onToggle={toggleScope} />
      <div className="flex items-center gap-2">
        <Button
          shape="pill"
          loading={loading}
          disabled={scopes.length === 0 || loading}
          onClick={() => { void storeActions.submitOAuthDecision(true, scopes); }}
        >
          Approve & connect
        </Button>
        <Button
          variant="outline"
          shape="pill"
          disabled={loading}
          onClick={() => { void storeActions.submitOAuthDecision(false, []); }}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

export function OAuthConsentScreen() {
  const s = useAppStore();
  const consent = s.oauthConsent;

  if (!s.viewer) {
    return (
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <Card className="gap-4 rounded-xl p-5">
          <CardHeader>
            <CardTitle>Authorize AI Agent</CardTitle>
            <CardDescription>Sign in with your verified phone number to review and approve this agent connection.</CardDescription>
          </CardHeader>
          <CardFooter className="justify-start">
            <Button shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>Sign in to continue</Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <h1 className="text-base font-bold text-foreground">Authorize Agent</h1>
      </header>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <Card className="gap-4 rounded-xl p-5">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle>{consent ? `Authorize ${consent.clientName}` : "Agent Authorization"}</CardTitle>
              <Badge variant="outline">Single agent</Badge>
            </div>
            <CardDescription>
              {consent ? `Redirect: ${consent.redirectUri}` : "Loading authorization request..."}
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-4">
            {s.oauthError ? <Alert variant="destructive">{s.oauthError}</Alert> : null}
            {s.viewer.agentGrant || consent?.priorGrantClientName ? (
              <Alert variant="warn">
                Connecting this agent disconnects your current agent ({consent?.priorGrantClientName ?? s.viewer.agentGrant?.clientName}).
              </Alert>
            ) : null}

            {consent ? (
              <ConsentScopeForm
                key={`${consent.clientId}:${consent.scopes.join(",")}`}
                consent={consent}
                loading={s.oauthLoading}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

type AdminTab = "world" | "holds" | "reports" | "users" | "facts";

export function AdminScreen() {
  const s = useAppStore();
  const status = s.adminStatus;
  const [adminTab, setAdminTab] = useState<AdminTab>("world");
  const [overrideReason, setOverrideReason] = useState("");
  const [userSearch, setUserSearch] = useState("");

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
  const throttle = formatThrottleStatus(status?.spend.throttleLevel ?? "ThrottleNormal");

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <div className="flex h-[53px] items-center justify-between px-4">
          <h1 className="text-base font-bold text-foreground">Admin Console</h1>
          <Button size="sm" variant="outline" shape="pill" loading={s.adminLoading} onClick={() => { void storeActions.loadAdminStatus(); }}>
            Refresh
          </Button>
        </div>
        <Tabs
          value={adminTab}
          onValueChange={(next) => {
            if (next === "world" || next === "holds" || next === "reports" || next === "users" || next === "facts") {
              setAdminTab(next);
            }
          }}
        >
          <TabsList variant="underline" className="overflow-x-auto border-b-0">
            <TabsTrigger value="world">World & Ticks</TabsTrigger>
            <TabsTrigger value="holds">Manual Holds ({status?.manualHolds.length ?? 0})</TabsTrigger>
            <TabsTrigger value="reports">Reports Queue</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="facts">World Facts</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {s.adminMessage ? <Alert variant="info">{s.adminMessage}</Alert> : null}

        {adminTab === "world" ? (
          <>
            <Card className="gap-4 rounded-xl p-5">
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>World Clock & Daily Spend</CardTitle>
                  <Badge variant={throttle.variant}>{throttle.label}</Badge>
                </div>
                <CardDescription>
                  Day {status?.currentDay ?? 1} · Hour {status?.currentHour ?? 0} · Phase {status?.phase ?? "active"}
                </CardDescription>
              </CardHeader>
              <CardContent className="gap-4">
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between font-mono text-xs tabular-nums">
                    <span>{`Committed: $${(committedCents / 100).toFixed(2)}`}</span>
                    <span>{`Daily cap: $${(budgetCents / 100).toFixed(2)} (${pct}%)`}</span>
                  </div>
                  <Progress value={pct} aria-label="Daily spend budget" />
                  <p className="text-xs text-muted-foreground">
                    Max steps {status?.spend.maxStepsAllowed ?? 4} · Batch {status?.spend.effectiveBatchSize ?? 6} · {`Remaining $${((status?.spend.remainingCents ?? 0) / 100).toFixed(2)}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(15); }}>
                    +15m
                  </Button>
                  <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(60); }}>
                    +1h
                  </Button>
                  <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminFastForward(480); }}>
                    +8h
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="gap-3 rounded-xl p-5">
              <CardHeader>
                <CardTitle>Cron Tick Health</CardTitle>
              </CardHeader>
              <CardContent className="gap-3">
                <div className="flex flex-wrap gap-2">
                  {CRON_JOBS.map((job) => (
                    <Button key={job} size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron(job); }}>
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
          </>
        ) : null}

        {adminTab === "holds" ? (
          <Card className="gap-3 rounded-xl p-5">
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
              {(status?.manualHolds ?? []).length === 0 ? (
                <EmptyState title="No markets currently on manual hold" />
              ) : (
                (status?.manualHolds ?? []).map((hold) => (
                  <div key={hold.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{hold.question}</p>
                      <p className="text-xs text-muted-foreground">
                        {hold.timeframe} · Expired {hold.expiresLabel}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminResolveHold(hold.id, "approve", "yes", overrideReason); }}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading || !overrideReason.trim()} onClick={() => { void storeActions.adminResolveHold(hold.id, "override", "yes", overrideReason); }}>
                        Override YES
                      </Button>
                      <Button size="sm" variant="destructive" shape="pill" disabled={s.adminLoading || !overrideReason.trim()} onClick={() => { void storeActions.adminResolveHold(hold.id, "override", "no", overrideReason); }}>
                        Override NO
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        ) : null}

        {adminTab === "reports" ? (
          <Card className="gap-3 rounded-xl p-5">
            <CardHeader>
              <CardTitle>Reports Queue</CardTitle>
              <CardDescription>User-submitted moderation reports awaiting review.</CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState title="No open moderation reports" />
            </CardContent>
          </Card>
        ) : null}

        {adminTab === "users" ? (
          <Card className="gap-3 rounded-xl p-5">
            <CardHeader>
              <CardTitle>User Lookup</CardTitle>
              <CardDescription>Search and jump directly to any player or character profile.</CardDescription>
            </CardHeader>
            <CardContent className="gap-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const clean = userSearch.trim().replace(/^@/, "");
                  if (clean) void storeActions.navigate(`/u/${encodeURIComponent(clean)}`);
                }}
                className="flex gap-2"
              >
                <Input
                  aria-label="Lookup handle"
                  placeholder="Enter @handle..."
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
                <Button type="submit" shape="pill" disabled={!userSearch.trim()}>
                  Open profile
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {adminTab === "facts" ? (
          <Card className="gap-4 rounded-xl p-5">
            <CardHeader>
              <CardTitle>World Facts & RSS Refresh</CardTitle>
              <CardDescription>Trigger world fact synthesis and external headline ingestion.</CardDescription>
            </CardHeader>
            <CardContent className="flex-row flex-wrap gap-2">
              <Button size="sm" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("world-facts"); }}>
                Run world-facts
              </Button>
              <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("rss-refresh"); }}>
                Run rss-refresh
              </Button>
              <Button size="sm" variant="outline" shape="pill" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("article-tick"); }}>
                Run article-tick
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
