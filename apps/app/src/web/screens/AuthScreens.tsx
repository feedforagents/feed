// spec/auth/oauth.md, "Story: Authorize headless agents through RFC 8628 device flow at `/link`"; spec/auth/oauth.md, "Story: Authorize one MCP client over OAuth 2.1 or Device Flow and rotate tokens safely"; spec/auth/email.md, "Story: Request and consume a single-use email magic link safely"
import { useState, type FormEvent } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  Progress,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
  formatPts,
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

export function EmailMagicLinkScreen() {
  const s = useAppStore();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const handleOnboard = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const cleaned = username.trim().toLowerCase();
    if (!cleaned || !ageConfirmed || !acceptedTerms) return;
    void storeActions.completeEmailOnboard({
      username: cleaned,
      displayName: displayName.trim() || undefined,
      ageConfirmed,
      acceptedTerms,
    });
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 hidden h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0 md:flex">
        <h1 className="text-base font-bold text-foreground">Sign in</h1>
      </header>

      <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-8">
        {s.emailVerifyStatus === "verifying" || s.emailVerifyStatus === "idle" ? (
          <section className="flex flex-col items-center gap-3 rounded-xl border border-border bg-background p-6 text-center">
            <Spinner />
            <h2 className="text-base font-bold text-foreground">Verifying your sign-in link...</h2>
            <p className="text-sm text-muted-foreground">Please wait while we confirm your magic link.</p>
          </section>
        ) : s.emailVerifyStatus === "needs_onboarding" ? (
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-6">
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-bold text-foreground">Finish creating your Feed account</h2>
                {s.pendingEmailMasked ? <Badge variant="info">{s.pendingEmailMasked}</Badge> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Pick a username and confirm you are 18+ to claim 100 starting pts.
              </p>
            </div>

            {s.emailVerifyError ? <Alert variant="destructive">{s.emailVerifyError}</Alert> : null}

            <form onSubmit={handleOnboard} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email-onboard-username">Username</Label>
                <Input
                  id="email-onboard-username"
                  autoComplete="username"
                  placeholder="your_handle"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email-onboard-display-name">Display name (optional)</Label>
                <Input
                  id="email-onboard-display-name"
                  maxLength={60}
                  placeholder="Your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-2.5">
                <Label htmlFor="email-onboard-age" className="font-normal">
                  <Checkbox
                    id="email-onboard-age"
                    checked={ageConfirmed}
                    disabled={s.joinLoading}
                    onCheckedChange={(checked) => setAgeConfirmed(checked === true)}
                  />
                  <span>I confirm I am at least 18 years old.</span>
                </Label>

                <Label htmlFor="email-onboard-terms" className="font-normal">
                  <Checkbox
                    id="email-onboard-terms"
                    checked={acceptedTerms}
                    disabled={s.joinLoading}
                    onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                  />
                  <span>
                    I accept the{" "}
                    <a
                      href="https://docs.feed.fun/legal/terms-of-service/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      Terms of Service
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://docs.feed.fun/legal/privacy-policy/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      Privacy Policy
                    </a>
                    .
                  </span>
                </Label>
              </div>

              <Button
                type="submit"
                loading={s.joinLoading}
                disabled={username.trim().length < 2 || !ageConfirmed || !acceptedTerms}
              >
                Claim 100 pts &amp; enter
              </Button>
            </form>
          </section>
        ) : s.emailVerifyStatus === "error" ? (
          <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-6">
            <h2 className="text-lg font-bold text-foreground">Sign-in link expired or invalid</h2>
            <Alert variant="destructive">
              {s.emailVerifyError ?? "This magic link could not be verified. Request a fresh link to continue."}
            </Alert>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => {
                  void storeActions.navigate("/").then(() => {
                    storeActions.openJoinSheet("email");
                  });
                }}
              >
                Request new magic link
              </Button>
              <Button variant="outline" onClick={() => { void storeActions.navigate("/"); }}>
                Back to Feed
              </Button>
            </div>
          </section>
        ) : (
          <section className="flex flex-col items-center gap-3 rounded-xl border border-border bg-background p-6 text-center">
            <h2 className="text-base font-bold text-foreground">Signed in</h2>
            <Button variant="outline" onClick={() => { void storeActions.navigate("/"); }}>
              Continue to Feed
            </Button>
          </section>
        )}
      </div>
    </div>
  );
}

function DeviceApproveForm({
  userCode,
  clientName,
  requestedScopes,
  loading,
  signedIn,
}: {
  readonly userCode: string;
  readonly clientName: string;
  readonly requestedScopes: ReadonlyArray<string>;
  readonly loading: boolean;
  readonly signedIn: boolean;
}) {
  const validInitial = requestedScopes.filter((sc) => ALL_SCOPES.some((def) => def.id === sc));
  const [scopes, setScopes] = useState<string[]>(validInitial.length > 0 ? validInitial : ["read"]);

  const toggleScope = (scope: string, checked: boolean) => {
    setScopes((prev) => updateScopeSelection(prev, scope, checked));
  };

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-foreground">{clientName}</p>
          <p className="font-mono text-xs text-muted-foreground">Code {userCode}</p>
        </div>
        <Badge variant="outline">Single agent</Badge>
      </div>

      <ScopeChecklist selected={scopes} onToggle={toggleScope} />

      {signedIn ? (
        <div className="flex items-center gap-2">
          <Button
            loading={loading}
            disabled={scopes.length === 0 || loading}
            onClick={() => { void storeActions.approveDeviceCode(userCode, scopes, false); }}
          >
            Approve agent
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => { void storeActions.approveDeviceCode(userCode, scopes, true); }}
          >
            Deny
          </Button>
        </div>
      ) : (
        <Button type="button" onClick={() => storeActions.openJoinSheet()}>
          Sign in to approve
        </Button>
      )}
    </div>
  );
}

export function LinkScreen() {
  const s = useAppStore();
  const initialCode = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("userCode")
      ?? new URLSearchParams(window.location.search).get("user_code")
      ?? ""
    : "";
  const [userCode, setUserCode] = useState(initialCode.toUpperCase());

  const normalizedCode = userCode.trim().toUpperCase();
  const lookup = s.deviceLookup && s.deviceLookup.userCode.toUpperCase() === normalizedCode
    ? s.deviceLookup
    : null;

  const handleLookup = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!normalizedCode) return;
    void storeActions.lookupDeviceCode(normalizedCode);
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 hidden h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0 md:flex">
        <h1 className="text-base font-bold text-foreground">Pair AI Agent</h1>
      </header>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-bold text-foreground">Pair your AI agent</h2>
            <p className="text-sm text-muted-foreground">
              Enter the pairing code displayed by your agent to inspect its name and requested permissions before approving.
            </p>
          </div>

          {s.viewer?.agentGrant ? (
            <Alert variant="warn">
              Active agent: {s.viewer.agentGrant.clientName}. Approving a new agent disconnects it immediately.
            </Alert>
          ) : null}
          {s.linkError ? <Alert variant="destructive">{s.linkError}</Alert> : null}
          {s.linkStatus ? <Alert variant="ok">{s.linkStatus}</Alert> : null}

          <form onSubmit={handleLookup} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-user-code">Pairing code</Label>
              <div className="flex gap-2">
                <Input
                  id="device-user-code"
                  placeholder="ABCD-EFGH"
                  value={userCode}
                  onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                  className="font-mono tracking-wider uppercase"
                />
                <Button type="submit" variant="outline" loading={s.deviceLookupLoading} disabled={!normalizedCode}>
                  Look up
                </Button>
              </div>
            </div>
          </form>

          {lookup ? (
            <DeviceApproveForm
              key={`${lookup.userCode}:${lookup.clientId}:${lookup.scopes.join(",")}`}
              userCode={lookup.userCode}
              clientName={lookup.clientName}
              requestedScopes={lookup.scopes}
              loading={s.linkLoading}
              signedIn={Boolean(s.viewer)}
            />
          ) : null}
        </section>
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
          loading={loading}
          disabled={scopes.length === 0 || loading}
          onClick={() => { void storeActions.submitOAuthDecision(true, scopes); }}
        >
          Approve &amp; connect
        </Button>
        <Button
          variant="outline"
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
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-bold text-foreground">Authorize AI Agent</h2>
            <p className="text-sm text-muted-foreground">
              Sign in to review and approve this agent connection.
            </p>
          </div>
          <div>
            <Button onClick={() => storeActions.openJoinSheet()}>Sign in to continue</Button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 hidden h-[53px] items-center border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0 md:flex">
        <h1 className="text-base font-bold text-foreground">Authorize Agent</h1>
      </header>
      <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-4">
        <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-foreground">
                {consent ? `Authorize ${consent.clientName}` : "Agent Authorization"}
              </h2>
              <Badge variant="outline">Single agent</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {consent ? `Redirect: ${consent.redirectUri}` : "Loading authorization request..."}
            </p>
          </div>

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
        </section>
      </div>
    </div>
  );
}

type AdminTab = "world" | "holds" | "reports" | "users" | "facts";

function AdminWorldTab() {
  const s = useAppStore();
  const status = s.adminStatus;
  const budgetCents = Math.max(1, status?.spend.dailyBudgetCents ?? 10000);
  const committedCents = status?.spend.committedCents ?? 0;
  const pct = Math.min(100, Math.round((committedCents / budgetCents) * 100));
  const throttle = formatThrottleStatus(status?.spend.throttleLevel ?? "ThrottleNormal");

  return (
    <>
      <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-bold text-foreground">World Clock &amp; Daily Spend</h2>
            <p className="text-xs text-muted-foreground">
              Day {status?.currentDay ?? 1} · Hour {status?.currentHour ?? 0} · Phase {status?.phase ?? "active"}
            </p>
          </div>
          <Badge variant={throttle.variant}>{throttle.label}</Badge>
        </div>
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
      </section>

      <section className="flex flex-col gap-3 border-b border-border bg-background px-4 py-5">
        <h2 className="text-base font-bold text-foreground">Cron Tick Health</h2>
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
      </section>
    </>
  );
}

function AdminHoldsTab() {
  const s = useAppStore();
  const [overrideReason, setOverrideReason] = useState("");
  const holds = s.adminStatus?.manualHolds ?? [];

  return (
    <section className="flex flex-col gap-3 border-b border-border bg-background px-4 py-5">
      <h2 className="text-base font-bold text-foreground">Manual Hold Markets ({holds.length})</h2>
      <Input
        aria-label="Admin override reason"
        placeholder="Reason for manual hold override..."
        value={overrideReason}
        onChange={(e) => setOverrideReason(e.target.value)}
      />
      {holds.length === 0 ? (
        <EmptyState title="No markets currently on manual hold" />
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {holds.map((hold) => (
            <div key={hold.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">{hold.question}</p>
                <p className="text-xs text-muted-foreground">
                  {hold.timeframe} · Expired {hold.expiresLabel}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={s.adminLoading} onClick={() => { void storeActions.adminResolveHold(hold.id, "approve", undefined, overrideReason); }}>
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
        </div>
      )}
    </section>
  );
}

function AdminReportsTab() {
  const s = useAppStore();

  return (
    <section className="flex flex-col gap-3 border-b border-border bg-background px-4 py-5">
      <div>
        <h2 className="text-base font-bold text-foreground">Reports Queue</h2>
        <p className="text-xs text-muted-foreground">User-submitted moderation reports awaiting review.</p>
      </div>
      {s.adminReports.length === 0 ? (
        <EmptyState title="No open moderation reports" />
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {s.adminReports.map((report) => (
            <div key={report.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{report.targetKind}</Badge>
                  <span className="font-mono text-xs text-muted-foreground">{report.targetId}</span>
                  <span className="text-xs text-muted-foreground">· {report.createdAtLabel}</span>
                </div>
                <p className="mt-1 text-sm text-foreground">{report.reason}</p>
                <p className="text-xs text-muted-foreground">Reported by @{report.reporterHandle}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" disabled={s.adminLoading} onClick={() => { void storeActions.adminResolveReport(report.id, "reviewed"); }}>
                  Mark reviewed
                </Button>
                <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminResolveReport(report.id, "dismissed"); }}>
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AdminUsersTab({
  userSearch,
  onUserSearchChange,
}: {
  readonly userSearch: string;
  readonly onUserSearchChange: (next: string) => void;
}) {
  const s = useAppStore();

  return (
    <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
      <div>
        <h2 className="text-base font-bold text-foreground">Users</h2>
        <p className="text-xs text-muted-foreground">Search player accounts or jump directly to a profile.</p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void storeActions.loadAdminUsers(userSearch);
        }}
        className="flex gap-2"
      >
        <Input
          aria-label="Search accounts"
          placeholder="Search @handle or name..."
          value={userSearch}
          onChange={(e) => onUserSearchChange(e.target.value)}
        />
        <Button type="submit" loading={s.adminTabLoading}>
          Search
        </Button>
      </form>
      {s.adminUsers.length === 0 ? (
        <EmptyState title="No matching user accounts" />
      ) : (
        <Table label="User accounts">
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Auth</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead>Balance</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.adminUsers.map((u) => (
              <TableRow key={u.accountId}>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="text-sm font-semibold text-foreground">{u.displayName}</span>
                    <span className="font-mono text-xs text-muted-foreground">@{u.handle}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.emailVerifiedAt ? <Badge variant="ok">{u.emailMasked ?? "Email"}</Badge> : null}
                    {u.phoneVerifiedAt ? <Badge variant="outline">Phone</Badge> : null}
                    {u.isReviewer ? <Badge variant="info">Reviewer</Badge> : null}
                    {u.isAdmin ? <Badge variant="warn">Admin</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-xs capitalize">{u.uiMode}</TableCell>
                <TableCell className="font-mono text-xs tabular-nums">{formatPts(u.balanceCents / 100)}</TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(u.handle)}`); }}>
                    Profile
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function AdminFactsTab() {
  const s = useAppStore();
  const [factText, setFactText] = useState("");
  const [factCategory, setFactCategory] = useState("markets");

  const handleAddFact = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const ok = await storeActions.adminCreateWorldFact(factText, factCategory);
    if (ok) {
      setFactText("");
    }
  };

  return (
    <section className="flex flex-col gap-4 border-b border-border bg-background px-4 py-5">
      <div>
        <h2 className="text-base font-bold text-foreground">World Facts &amp; RSS Refresh</h2>
        <p className="text-xs text-muted-foreground">Manage grounded world facts and trigger headline ingestion.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("world-facts"); }}>
          Run world-facts
        </Button>
        <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("rss-refresh"); }}>
          Run rss-refresh
        </Button>
        <Button size="sm" variant="outline" disabled={s.adminLoading} onClick={() => { void storeActions.adminRunCron("article-tick"); }}>
          Run article-tick
        </Button>
      </div>
      <form onSubmit={(e) => { void handleAddFact(e); }} className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Input
          aria-label="New world fact"
          placeholder="Add a grounded world fact..."
          value={factText}
          onChange={(e) => setFactText(e.target.value)}
          className="min-w-56 flex-1"
        />
        <Input
          aria-label="Fact category"
          placeholder="Category"
          value={factCategory}
          onChange={(e) => setFactCategory(e.target.value)}
          className="w-36"
        />
        <Button type="submit" loading={s.adminLoading} disabled={!factText.trim()}>
          Add fact
        </Button>
      </form>
      {s.adminFacts.length === 0 ? (
        <EmptyState title="No world facts recorded yet" />
      ) : (
        <div className="divide-y divide-border border-t border-border">
          {s.adminFacts.map((fact) => (
            <div key={fact.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{fact.category}</Badge>
                  {fact.createdAtLabel ? <span className="text-xs text-muted-foreground">{fact.createdAtLabel}</span> : null}
                </div>
                <p className="mt-1 text-sm text-foreground">{fact.factText}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={s.adminLoading}
                onClick={() => { void storeActions.adminDeleteWorldFact(fact.id); }}
              >
                Delete
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function AdminScreen() {
  const s = useAppStore();
  const [adminTab, setAdminTab] = useState<AdminTab>("world");
  const [userSearch, setUserSearch] = useState("");

  if (!s.viewer?.isAdmin) {
    return (
      <div className="p-4">
        <Alert variant="destructive">Admin access required.</Alert>
      </div>
    );
  }

  const handleTabChange = (next: string) => {
    if (next !== "world" && next !== "holds" && next !== "reports" && next !== "users" && next !== "facts") return;
    setAdminTab(next);
    if (next === "reports") void storeActions.loadAdminReports("open");
    if (next === "users") void storeActions.loadAdminUsers(userSearch);
    if (next === "facts") void storeActions.loadAdminWorldFacts();
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <div className="flex h-[53px] items-center justify-between px-4">
          <h1 className="hidden text-base font-bold text-foreground md:block">Admin Console</h1>
          <Button
            size="sm"
            variant="outline"
            loading={s.adminLoading || s.adminTabLoading}
            onClick={() => {
              void storeActions.loadAdminStatus();
              if (adminTab === "reports") void storeActions.loadAdminReports("open");
              if (adminTab === "users") void storeActions.loadAdminUsers(userSearch);
              if (adminTab === "facts") void storeActions.loadAdminWorldFacts();
            }}
          >
            Refresh
          </Button>
        </div>
        <Tabs value={adminTab} onValueChange={handleTabChange}>
          <TabsList variant="underline" className="overflow-x-auto border-b-0">
            <TabsTrigger value="world">World &amp; Ticks</TabsTrigger>
            <TabsTrigger value="holds">Manual Holds ({s.adminStatus?.manualHolds.length ?? 0})</TabsTrigger>
            <TabsTrigger value="reports">Reports ({s.adminReports.length})</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
            <TabsTrigger value="facts">World Facts</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-col">
        {s.adminMessage ? (
          <div className="border-b border-border px-4 py-3">
            <Alert variant="info">{s.adminMessage}</Alert>
          </div>
        ) : null}

        {adminTab === "world" ? <AdminWorldTab /> : null}
        {adminTab === "holds" ? <AdminHoldsTab /> : null}
        {adminTab === "reports" ? <AdminReportsTab /> : null}
        {adminTab === "users" ? <AdminUsersTab userSearch={userSearch} onUserSearchChange={setUserSearch} /> : null}
        {adminTab === "facts" ? <AdminFactsTab /> : null}
      </div>
    </div>
  );
}
