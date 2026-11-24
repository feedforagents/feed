import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
  /** Optional custom trigger element rendered inside `DialogTrigger` when provided. */
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
  /** Optional local development SMS code surfaced as a quick-fill helper on the verify step. */
  devSmsCode?: string;
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
  { code: "EU", label: "EU / EEA" },
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

function JoinPhoneDoor({
  step,
  blocked,
  loading,
  turnstileSiteKey,
  devSmsCode,
  onStepChange,
  onRequestSmsCode,
  onVerifySmsCode,
  onResendSmsCode,
  onCompleteProfile,
}: {
  readonly step: JoinPhoneStep;
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly turnstileSiteKey?: string;
  readonly devSmsCode?: string;
  readonly onStepChange: (next: JoinPhoneStep) => void;
  readonly onRequestSmsCode?: (payload: { country: string; phone: string; turnstileToken?: string }) => void;
  readonly onVerifySmsCode?: (code: string) => void;
  readonly onResendSmsCode?: () => void;
  readonly onCompleteProfile?: (payload: { username: string; ageConfirmed: boolean; acceptedTerms: boolean }) => void;
}) {
  const countryId = useId();
  const phoneId = useId();
  const codeId = useId();
  const usernameId = useId();
  const ageId = useId();
  const termsId = useId();

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

  const handleRequestCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !phone.trim()) return;
    if (activeTurnstileKey && !turnstileToken) return;
    const token = turnstileToken ?? undefined;
    setTurnstileToken(null);
    setTurnstileResetKey((n) => n + 1);
    onRequestSmsCode?.({ country, phone: phone.trim(), ...(token ? { turnstileToken: token } : {}) });
    onStepChange("verify");
  };

  const handleVerifyCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || smsCode.trim().length !== 6) return;
    onVerifySmsCode?.(smsCode.trim());
    onStepChange("profile");
  };

  const handleCompleteProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !username.trim() || !ageConfirmed || !acceptedTerms) return;
    onCompleteProfile?.({ username: username.trim(), ageConfirmed, acceptedTerms });
  };

  if (step === "entry") {
    return (
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
        <Button type="submit" shape="pill" loading={loading} disabled={blocked || !phone.trim() || (Boolean(activeTurnstileKey) && !turnstileToken)}>
          Send 6-digit SMS code
        </Button>
      </form>
    );
  }

  if (step === "verify") {
    return (
      <form onSubmit={handleVerifyCode} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={blocked}
            onClick={() => onStepChange("entry")}
            className={cn(focusRing, "inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground")}
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            Change number
          </button>
          {devSmsCode ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              shape="pill"
              disabled={blocked}
              onClick={() => setSmsCode(devSmsCode.replace(/\D/g, "").slice(0, 6))}
            >
              Fill dev code
            </Button>
          ) : null}
        </div>
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
          <Button type="button" variant="ghost" size="sm" shape="pill" disabled={blocked} onClick={() => onResendSmsCode?.()}>
            Resend code
          </Button>
          <Button type="submit" shape="pill" loading={loading} disabled={blocked || smsCode.length !== 6}>
            Verify code
          </Button>
        </div>
      </form>
    );
  }

  return (
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
      <Button type="submit" shape="pill" loading={loading} disabled={blocked || !username.trim() || !ageConfirmed || !acceptedTerms}>
        Claim 100 pts & enter
      </Button>
    </form>
  );
}

function JoinReviewerForm({
  blocked,
  loading,
  onSubmitReviewer,
  onBack,
}: {
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly onSubmitReviewer?: (payload: { identifier: string; password: string }) => void;
  readonly onBack: () => void;
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
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={blocked}
          onClick={onBack}
          className={cn(focusRing, "inline-flex items-center gap-1.5 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground")}
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          Back to phone & agent sign-in
        </button>
      </div>
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
      <Button type="submit" shape="pill" loading={loading} disabled={blocked || !reviewerId.trim() || !reviewerPassword}>
        Sign in as reviewer
      </Button>
    </form>
  );
}

/**
 * Onboarding dialog with Phone SMS and Connect Agent tabs plus a subtle Reviewer sign-in footer link.
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
  devSmsCode,
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
  const [internalTab, setInternalTab] = useState<JoinTab>("phone");
  const [internalStep, setInternalStep] = useState<JoinPhoneStep>("entry");

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

  return (
    <Dialog
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={(nextOpen) => {
        if (!blocked) onOpenChange?.(nextOpen);
      }}
    >
      {trigger ? (
        <DialogTrigger asChild disabled={blocked}>
          {trigger}
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-w-lg rounded-xl">
        <div className="flex flex-col gap-1">
          <DialogTitle>Join Feed</DialogTitle>
          <DialogDescription>
            {pendingActionLabel ? `Sign in to ${pendingActionLabel}. New verified accounts receive 100 pts.` : "Sign in with your phone or connect one AI agent."}
          </DialogDescription>
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {currentTab === "reviewer" ? (
          <JoinReviewerForm
            blocked={blocked}
            loading={loading}
            onSubmitReviewer={onSubmitReviewer}
            onBack={() => setTab("phone")}
          />
        ) : (
          <>
            <Tabs value={currentTab} onValueChange={(next) => setTab(next === "agent" ? "agent" : "phone")}>
              <TabsList variant="underline" className="grid w-full grid-cols-2">
                <TabsTrigger value="phone" disabled={blocked}>Phone SMS</TabsTrigger>
                <TabsTrigger value="agent" disabled={blocked}>Connect Agent</TabsTrigger>
              </TabsList>

              <TabsContent value="phone">
                <JoinPhoneDoor
                  step={currentStep}
                  blocked={blocked}
                  loading={loading}
                  turnstileSiteKey={turnstileSiteKey}
                  devSmsCode={devSmsCode}
                  onStepChange={setStep}
                  onRequestSmsCode={onRequestSmsCode}
                  onVerifySmsCode={onVerifySmsCode}
                  onResendSmsCode={onResendSmsCode}
                  onCompleteProfile={onCompleteProfile}
                />
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
                <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <span>Agents never receive phone numbers or SMS codes.</span>
                  <Button type="button" variant="outline" size="sm" shape="pill" disabled={blocked} onClick={() => setTab("phone")}>
                    Verify phone
                  </Button>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex justify-center border-t border-border pt-3">
              <button
                type="button"
                disabled={blocked}
                onClick={() => setTab("reviewer")}
                className={cn(focusRing, "rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline")}
              >
                Reviewer sign-in
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
