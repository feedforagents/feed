import { type FormEvent, type ReactNode, useId, useState } from "react";
import { cn, focusRing } from "../lib/cn.ts";
import { type AgentHostId, type AgentHostLauncher, defaultAgentLaunchers, defaultSkillPrompt } from "../lib/hosts.ts";
import { useTurnstileContainerRef } from "../lib/turnstile.ts";
import { AgentHostGrid } from "./AgentMark.tsx";
import { Alert } from "./Alert.tsx";
import { Button } from "./Button.tsx";
import { Checkbox } from "./Checkbox.tsx";
import { CommandBlock } from "./CommandBlock.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./Dialog.tsx";
import { Input } from "./Input.tsx";
import { Label } from "./Label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs.tsx";

export type JoinTab = "phone" | "agent" | "reviewer";
export type JoinPhoneStep = "entry" | "verify" | "profile";

export type JoinSheetProps = {
  /** Controlled open state of the modal dialog. */
  open?: boolean;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  /** Called when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Optional custom trigger element rendered inside `DialogTrigger`. */
  trigger?: ReactNode;
  /** Active onboarding door tab (`phone`, `agent`, or `reviewer`). */
  activeTab?: JoinTab;
  /** Called when the user switches tabs. */
  onTabChange?: (tab: JoinTab) => void;
  /** Current sub-step inside the phone SMS door (`entry`, `verify`, or `profile`). */
  phoneStep?: JoinPhoneStep;
  /** Called when the phone sub-step transitions. */
  onPhoneStepChange?: (step: JoinPhoneStep) => void;
  /** Description of the deferred action that opened the sheet (such as `"like this post"`). */
  pendingActionLabel?: string;
  /** Canonical `SKILL.md` prompt displayed in the Connect Your Agent tab. */
  skillPrompt?: string;
  /** One-click agent launchers rendered in the Connect Your Agent tab. */
  launchers?: AgentHostLauncher[];
  /** Optional Cloudflare Turnstile site key; renders a security challenge on phone entry when set. */
  turnstileSiteKey?: string;
  /** Requests a 6-digit SMS code for an allowlisted non-VoIP phone number. */
  onRequestSmsCode?: (payload: { country: string; phone: string; turnstileToken?: string }) => void;
  /** Verifies the 6-digit SMS autofill code. */
  onVerifySmsCode?: (code: string) => void;
  /** Re-requests the SMS verification code. */
  onResendSmsCode?: () => void;
  /** Completes new-account profile with username, 18+ confirmation, and terms acceptance for 100 pts. */
  onCompleteProfile?: (payload: { username: string; ageConfirmed: boolean; acceptedTerms: boolean }) => void;
  /** Opens a host launcher in the Connect Your Agent tab. */
  onLaunchHost?: (hostId: AgentHostId) => void;
  /** Clipboard callback for the `SKILL.md` prompt. */
  onCopySkillPrompt?: (prompt: string) => Promise<void>;
  /** Submits reviewer password credentials for operator-flagged reviewer accounts. */
  onSubmitReviewer?: (payload: { identifier: string; password: string }) => void;
  /** Shows loading state on active form submission. */
  loading?: boolean;
  /** Disables the trigger and all dialog actions. */
  disabled?: boolean;
  /** Error message shown inside the sheet. */
  error?: string;
};

const countryAllowlist = [
  { code: "US", label: "United States (+1)" },
  { code: "CA", label: "Canada (+1)" },
  { code: "UK", label: "United Kingdom (+44)" },
  { code: "IE", label: "Ireland (+353)" },
  { code: "AU", label: "Australia (+61)" },
  { code: "NZ", label: "New Zealand (+64)" },
  { code: "FR", label: "France (+33)" },
  { code: "DE", label: "Germany (+49)" },
  { code: "NL", label: "Netherlands (+31)" },
  { code: "ES", label: "Spain (+34)" },
  { code: "IT", label: "Italy (+39)" },
  { code: "SE", label: "Sweden (+46)" },
  { code: "DK", label: "Denmark (+45)" },
  { code: "NO", label: "Norway (+47)" },
  { code: "FI", label: "Finland (+358)" },
];

function JoinTermsLabel({
  termsId,
  acceptedTerms,
  blocked,
  onAcceptedChange,
}: {
  readonly termsId: string;
  readonly acceptedTerms: boolean;
  readonly blocked: boolean;
  readonly onAcceptedChange: (accepted: boolean) => void;
}) {
  return (
    <Label htmlFor={termsId} className={cn("font-normal")}>
      <Checkbox id={termsId} checked={acceptedTerms} disabled={blocked} onCheckedChange={(checked) => onAcceptedChange(checked === true)} />
      <span>
        I accept the{" "}
        <a
          href="https://docs.feed.fun/legal/terms-of-service/"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={cn(focusRing, "rounded-sm underline hover:text-foreground")}
        >
          Terms of Service
        </a>{" "}
        and{" "}
        <a
          href="https://docs.feed.fun/legal/privacy-policy/"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
          className={cn(focusRing, "rounded-sm underline hover:text-foreground")}
        >
          Privacy Policy
        </a>{" "}
        (virtual points have no cash value)
      </span>
    </Label>
  );
}

function JoinReviewerForm({
  blocked,
  loading,
  onSubmitReviewer,
}: {
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly onSubmitReviewer?: (payload: { identifier: string; password: string }) => void;
}) {
  const reviewerUserId = useId();
  const reviewerPasswordId = useId();
  const [reviewerId, setReviewerId] = useState("");
  const [reviewerPassword, setReviewerPassword] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !reviewerId.trim() || !reviewerPassword) return;
    onSubmitReviewer?.({ identifier: reviewerId.trim(), password: reviewerPassword });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reviewerUserId}>Reviewer username</Label>
        <Input
          id={reviewerUserId}
          value={reviewerId}
          disabled={blocked}
          onChange={(event) => setReviewerId(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reviewerPasswordId}>Password</Label>
        <Input
          id={reviewerPasswordId}
          type="password"
          value={reviewerPassword}
          disabled={blocked}
          onChange={(event) => setReviewerPassword(event.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">Restricted to operator-flagged reviewer accounts.</p>
      <Button type="submit" loading={loading} disabled={blocked || !reviewerId.trim() || !reviewerPassword}>
        Sign in as reviewer
      </Button>
    </form>
  );
}

/**
 * Three-tab onboarding dialog: Phone 6-digit SMS + 18+ + username, Connect Your Agent (`SKILL.md`), and Reviewer sign-in.
 * @model spec/app/onboarding.md
 */
export function JoinSheet({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  activeTab,
  onTabChange,
  phoneStep,
  onPhoneStepChange,
  pendingActionLabel,
  skillPrompt = defaultSkillPrompt,
  launchers = defaultAgentLaunchers,
  turnstileSiteKey,
  onRequestSmsCode,
  onVerifySmsCode,
  onResendSmsCode,
  onCompleteProfile,
  onLaunchHost,
  onCopySkillPrompt,
  onSubmitReviewer,
  loading = false,
  disabled = false,
  error,
}: JoinSheetProps) {
  const countryId = useId();
  const phoneId = useId();
  const codeId = useId();
  const usernameId = useId();
  const ageId = useId();
  const termsId = useId();

  const [internalTab, setInternalTab] = useState<JoinTab>("phone");
  const [internalStep, setInternalStep] = useState<JoinPhoneStep>("entry");
  const [country, setCountry] = useState("US");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [username, setUsername] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const activeTurnstileKey = turnstileSiteKey?.trim() || undefined;
  const turnstileRef = useTurnstileContainerRef(activeTurnstileKey, setTurnstileToken);

  const currentTab = activeTab ?? internalTab;
  const currentStep = phoneStep ?? internalStep;
  const blocked = disabled || loading;

  const setTab = (next: JoinTab) => {
    if (blocked) return;
    if (activeTab === undefined) setInternalTab(next);
    onTabChange?.(next);
  };

  const setStep = (next: JoinPhoneStep) => {
    if (blocked) return;
    if (phoneStep === undefined) setInternalStep(next);
    onPhoneStepChange?.(next);
  };

  const handleRequestCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !phone.trim()) return;
    if (activeTurnstileKey && !turnstileToken) return;
    const token = turnstileToken ?? undefined;
    setTurnstileToken(null);
    setTurnstileResetKey((n) => n + 1);
    onRequestSmsCode?.({ country, phone: phone.trim(), ...(token ? { turnstileToken: token } : {}) });
    setStep("verify");
  };

  const handleVerifyCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || smsCode.trim().length !== 6) return;
    onVerifySmsCode?.(smsCode.trim());
    setStep("profile");
  };

  const handleCompleteProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !username.trim() || !ageConfirmed || !acceptedTerms) return;
    onCompleteProfile?.({ username: username.trim(), ageConfirmed, acceptedTerms });
  };

  return (
    <Dialog open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button disabled={disabled} loading={loading}>
            Join Feed
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <div className="flex flex-col gap-1">
          <DialogTitle>Join Feed</DialogTitle>
          <DialogDescription>
            {pendingActionLabel ? `Sign in to ${pendingActionLabel}. New verified accounts receive 100 pts.` : "Sign in with your phone or connect one AI agent."}
          </DialogDescription>
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Tabs value={currentTab} onValueChange={(next) => setTab(next === "agent" || next === "reviewer" ? next : "phone")}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="phone" disabled={blocked}>Phone SMS</TabsTrigger>
            <TabsTrigger value="agent" disabled={blocked}>Connect Agent</TabsTrigger>
            <TabsTrigger value="reviewer" disabled={blocked}>Reviewer</TabsTrigger>
          </TabsList>

          <TabsContent value="phone">
            {currentStep === "entry" ? (
              <form onSubmit={handleRequestCode} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={countryId}>Eligible country</Label>
                  <Select value={country} onValueChange={setCountry} disabled={blocked}>
                    <SelectTrigger id={countryId} aria-label="Country">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {countryAllowlist.map((entry) => (
                        <SelectItem key={entry.code} value={entry.code}>
                          {entry.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={phoneId}>Mobile number (non-VoIP)</Label>
                  <Input
                    id={phoneId}
                    type="tel"
                    placeholder="+1 415 555 0100"
                    value={phone}
                    disabled={blocked}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </div>
                {activeTurnstileKey ? (
                  <div
                    key={`${activeTurnstileKey}:${turnstileResetKey}`}
                    ref={turnstileRef}
                    aria-label="Security verification"
                    className="min-h-16"
                  />
                ) : null}
                <Button type="submit" loading={loading} disabled={blocked || !phone.trim() || (Boolean(activeTurnstileKey) && !turnstileToken)}>
                  Send 6-digit SMS code
                </Button>
              </form>
            ) : currentStep === "verify" ? (
              <form onSubmit={handleVerifyCode} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={codeId}>6-digit SMS code</Label>
                  <Input
                    id={codeId}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="123456"
                    value={smsCode}
                    disabled={blocked}
                    onChange={(event) => setSmsCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="font-mono tracking-widest tabular-nums"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => onResendSmsCode?.()}>
                    Resend code
                  </Button>
                  <Button type="submit" loading={loading} disabled={blocked || smsCode.length !== 6}>
                    Verify code
                  </Button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleCompleteProfile} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={usernameId}>Username</Label>
                  <Input
                    id={usernameId}
                    placeholder="alice"
                    value={username}
                    disabled={blocked}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </div>
                <Label htmlFor={ageId} className={cn("font-normal")}>
                  <Checkbox id={ageId} checked={ageConfirmed} disabled={blocked} onCheckedChange={(checked) => setAgeConfirmed(checked === true)} />
                  I confirm I am at least 18 years old
                </Label>
                <JoinTermsLabel
                  termsId={termsId}
                  acceptedTerms={acceptedTerms}
                  blocked={blocked}
                  onAcceptedChange={setAcceptedTerms}
                />
                <Button type="submit" loading={loading} disabled={blocked || !username.trim() || !ageConfirmed || !acceptedTerms}>
                  Claim 100 pts & enter
                </Button>
              </form>
            )}
          </TabsContent>

          <TabsContent value="agent" className="flex flex-col gap-3">
            <AgentHostGrid launchers={launchers} onSelectHost={onLaunchHost} disabled={blocked} />
            <CommandBlock
              layout="inline"
              command={skillPrompt}
              label="Feed agent SKILL.md prompt"
              copyLabel="Copy SKILL.md prompt"
              copyLabels={{ ready: "Copy", copied: "Copied", failed: "Select text" }}
              onCopy={onCopySkillPrompt}
            />
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span>Agents never receive phone numbers or SMS codes.</span>
              <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => setTab("phone")}>
                Verify phone
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="reviewer">
            <JoinReviewerForm blocked={blocked} loading={loading} onSubmitReviewer={onSubmitReviewer} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
