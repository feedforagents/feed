import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ArrowLeft, ExternalLink, MailCheck } from "lucide-react";
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

export type JoinTab = "email" | "phone" | "agent" | "reviewer";
export type JoinEmailStep = "entry" | "sent" | "profile";
export type JoinPhoneStep = "entry" | "verify" | "profile";

type AsyncActionResult = Promise<boolean> | Promise<void> | boolean | void;

export type JoinSheetProps = {
  /** Controlled open state of the modal dialog. */
  open?: boolean;
  /** Uncontrolled initial open state. */
  defaultOpen?: boolean;
  /** Called when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Optional custom trigger element rendered inside `DialogTrigger` when provided. */
  trigger?: ReactNode;
  /** Shows the Email Magic Link tab alongside Phone and Connect Agent (defaults to `true`). */
  emailAuthEnabled?: boolean;
  /** Active onboarding door tab (`email`, `phone`, `agent`, or `reviewer`). */
  activeTab?: JoinTab;
  /** Called when the user switches tabs. */
  onTabChange?: (tab: JoinTab) => void;
  /** Current sub-step inside the email magic link door (`entry`, `sent`, or `profile`). */
  emailStep?: JoinEmailStep;
  /** Called when the email sub-step transitions. */
  onEmailStepChange?: (step: JoinEmailStep) => void;
  /** Masked email address shown on the "Check your inbox" step (e.g. `a***@example.com`). */
  pendingEmailMasked?: string;
  /** Fallback email address shown on the "Check your inbox" step when `pendingEmailMasked` is omitted. */
  pendingEmail?: string;
  /** Shows a 1-click "Open dev magic link" helper on the email sent step when in localnet/loopback mode. */
  devEmailLinkEnabled?: boolean;
  /** Localnet/loopback magic link URL opened by the dev helper button. */
  devEmailMagicLinkUrl?: string;
  /** Invoked when the user clicks "Open dev magic link". */
  onOpenDevMagicLink?: (url?: string) => void;
  /** Requests an email magic link for the entered address. */
  onRequestEmailMagicLink?: (payload: { email: string; turnstileToken?: string }) => AsyncActionResult;
  /** Re-requests the email magic link for the pending email address. */
  onResendEmailMagicLink?: () => AsyncActionResult;
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
  /** Optional Cloudflare Turnstile site key; renders a security challenge on email and phone entry when set. */
  turnstileSiteKey?: string;
  /** Optional local development SMS code surfaced as a quick-fill helper on the verify step. */
  devSmsCode?: string;
  /** Shows a localnet/loopback dev SMS code autofill button on the verification step when `onFillDevCode` is provided. */
  devSmsCodeEnabled?: boolean;
  /** Fetches or fills the localnet/loopback SMS code; returning a 6-digit string populates the input automatically. */
  onFillDevCode?: (phone: string) => Promise<string | null | undefined> | string | null | undefined | void;
  /** Requests a 6-digit SMS code for an allowlisted non-VoIP phone number. */
  onRequestSmsCode?: (payload: { country: string; phone: string; turnstileToken?: string }) => AsyncActionResult;
  /** Verifies the 6-digit SMS autofill code. */
  onVerifySmsCode?: (code: string) => AsyncActionResult;
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
}

function runAndAdvanceOnSuccess(action: () => AsyncActionResult, onSuccess: () => void): void {
  let result: AsyncActionResult;
  try {
    result = action();
  } catch {
    return;
  }
  if (isThenable(result)) {
    void Promise.resolve(result).then(
      (ok) => {
        if (ok !== false) onSuccess();
      },
      () => undefined,
    );
    return;
  }
  if (result !== false) onSuccess();
}

function maskEmailPreview(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  if (at <= 0) return trimmed;
  return `${trimmed[0]}***${trimmed.slice(at)}`;
}

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

function JoinProfileForm({
  blocked,
  loading,
  onCompleteProfile,
}: {
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly onCompleteProfile?: (payload: { username: string; ageConfirmed: boolean; acceptedTerms: boolean }) => void;
}) {
  const usernameId = useId();
  const ageId = useId();
  const termsId = useId();

  const [username, setUsername] = useState("");
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !username.trim() || !ageConfirmed || !acceptedTerms) return;
    onCompleteProfile?.({ username: username.trim(), ageConfirmed, acceptedTerms });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
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
  );
}

function useTurnstileGate(turnstileSiteKey?: string) {
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const siteKey = turnstileSiteKey?.trim() || undefined;
  const containerRef = useTurnstileContainerRef(siteKey, setToken);
  const needsToken = Boolean(siteKey) && !token;
  const consumeToken = (): string | undefined => {
    const current = token ?? undefined;
    setToken(null);
    setResetKey((n) => n + 1);
    return current;
  };
  return { siteKey, resetKey, containerRef, needsToken, consumeToken };
}

function TurnstileWidgetSlot({
  siteKey,
  resetKey,
  containerRef,
}: {
  readonly siteKey?: string;
  readonly resetKey: number;
  readonly containerRef: ReturnType<typeof useTurnstileContainerRef>;
}) {
  if (!siteKey) return null;
  return (
    <div
      key={`${siteKey}:${resetKey}`}
      ref={containerRef}
      aria-label="Security verification"
      className="min-h-16"
    />
  );
}

function JoinEmailDoor({
  step,
  isStepControlled,
  blocked,
  loading,
  turnstileSiteKey,
  pendingEmailMasked,
  pendingEmail,
  devEmailLinkEnabled,
  devEmailMagicLinkUrl,
  onOpenDevMagicLink,
  onStepChange,
  onRequestEmailMagicLink,
  onResendEmailMagicLink,
  onCompleteProfile,
}: {
  readonly step: JoinEmailStep;
  readonly isStepControlled: boolean;
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly turnstileSiteKey?: string;
  readonly pendingEmailMasked?: string;
  readonly pendingEmail?: string;
  readonly devEmailLinkEnabled?: boolean;
  readonly devEmailMagicLinkUrl?: string;
  readonly onOpenDevMagicLink?: (url?: string) => void;
  readonly onStepChange: (next: JoinEmailStep) => void;
  readonly onRequestEmailMagicLink?: (payload: { email: string; turnstileToken?: string }) => AsyncActionResult;
  readonly onResendEmailMagicLink?: () => AsyncActionResult;
  readonly onCompleteProfile?: (payload: { username: string; ageConfirmed: boolean; acceptedTerms: boolean }) => void;
}) {
  const emailId = useId();
  const [email, setEmail] = useState(pendingEmail ?? "");
  const turnstile = useTurnstileGate(turnstileSiteKey);

  const trimmedEmail = email.trim();
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmedEmail);

  const handleRequestLink = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !validEmail || turnstile.needsToken) return;
    const token = turnstile.consumeToken();
    runAndAdvanceOnSuccess(
      () => onRequestEmailMagicLink?.({ email: trimmedEmail, ...(token ? { turnstileToken: token } : {}) }),
      () => {
        if (!isStepControlled) onStepChange("sent");
      },
    );
  };

  if (step === "entry") {
    return (
      <form onSubmit={handleRequestLink} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={emailId}>Email address</Label>
          <Input
            id={emailId}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            disabled={blocked}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <TurnstileWidgetSlot siteKey={turnstile.siteKey} resetKey={turnstile.resetKey} containerRef={turnstile.containerRef} />
        <Button type="submit" loading={loading} disabled={blocked || !validEmail || turnstile.needsToken}>
          Send magic link
        </Button>
      </form>
    );
  }

  if (step === "sent") {
    const displayTarget = pendingEmailMasked || (pendingEmail ? maskEmailPreview(pendingEmail) : trimmedEmail ? maskEmailPreview(trimmedEmail) : "your inbox");
    const showDevLink = Boolean(devEmailLinkEnabled && (devEmailMagicLinkUrl || onOpenDevMagicLink));
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3.5">
          <MailCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold text-foreground">Check your inbox</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              We sent a sign-in link to <span className="font-mono font-medium text-foreground">{displayTarget}</span> — expires in 15 minutes.
            </p>
          </div>
        </div>

        {showDevLink ? (
          <Button
            type="button"
            variant="outline"
            disabled={blocked}
            onClick={() => {
              if (onOpenDevMagicLink) {
                onOpenDevMagicLink(devEmailMagicLinkUrl);
              } else if (devEmailMagicLinkUrl && typeof window !== "undefined") {
                window.location.assign(devEmailMagicLinkUrl);
              }
            }}
            className="w-full"
          >
            <ExternalLink aria-hidden className="size-4" />
            Open dev magic link
          </Button>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={blocked}
            onClick={() => onStepChange("entry")}
            className={cn(focusRing, "inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground")}
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            Use a different email
          </button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={blocked}
            onClick={() => {
              void onResendEmailMagicLink?.();
            }}
          >
            Resend link
          </Button>
        </div>
      </div>
    );
  }

  return <JoinProfileForm blocked={blocked} loading={loading} onCompleteProfile={onCompleteProfile} />;
}

function JoinPhoneDoor({
  step,
  isStepControlled,
  blocked,
  loading,
  turnstileSiteKey,
  devSmsCode,
  devSmsCodeEnabled,
  onFillDevCode,
  onStepChange,
  onRequestSmsCode,
  onVerifySmsCode,
  onResendSmsCode,
  onCompleteProfile,
}: {
  readonly step: JoinPhoneStep;
  readonly isStepControlled: boolean;
  readonly blocked: boolean;
  readonly loading: boolean;
  readonly turnstileSiteKey?: string;
  readonly devSmsCode?: string;
  readonly devSmsCodeEnabled?: boolean;
  readonly onFillDevCode?: (phone: string) => Promise<string | null | undefined> | string | null | undefined | void;
  readonly onStepChange: (next: JoinPhoneStep) => void;
  readonly onRequestSmsCode?: (payload: { country: string; phone: string; turnstileToken?: string }) => AsyncActionResult;
  readonly onVerifySmsCode?: (code: string) => AsyncActionResult;
  readonly onResendSmsCode?: () => void;
  readonly onCompleteProfile?: (payload: { username: string; ageConfirmed: boolean; acceptedTerms: boolean }) => void;
}) {
  const countryId = useId();
  const phoneId = useId();
  const codeId = useId();

  const [country, setCountry] = useState("US");
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const turnstile = useTurnstileGate(turnstileSiteKey);

  const handleRequestCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || !phone.trim() || turnstile.needsToken) return;
    const token = turnstile.consumeToken();
    runAndAdvanceOnSuccess(
      () => onRequestSmsCode?.({ country, phone: phone.trim(), ...(token ? { turnstileToken: token } : {}) }),
      () => {
        if (!isStepControlled) onStepChange("verify");
      },
    );
  };

  const handleVerifyCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || smsCode.trim().length !== 6) return;
    runAndAdvanceOnSuccess(
      () => onVerifySmsCode?.(smsCode.trim()),
      () => {
        if (!isStepControlled) onStepChange("profile");
      },
    );
  };

  const handleFillDevCode = async () => {
    if (blocked) return;
    if (devSmsCode) {
      setSmsCode(devSmsCode.replace(/\D/g, "").slice(0, 6));
      return;
    }
    if (!onFillDevCode) return;
    const result = await onFillDevCode(phone.trim());
    if (typeof result === "string") {
      const digits = result.replace(/\D/g, "").slice(0, 6);
      if (digits.length > 0) setSmsCode(digits);
    }
  };

  const showDevCodeHelper = Boolean(devSmsCode) || (Boolean(devSmsCodeEnabled) && Boolean(onFillDevCode));

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
        <TurnstileWidgetSlot siteKey={turnstile.siteKey} resetKey={turnstile.resetKey} containerRef={turnstile.containerRef} />
        <Button type="submit" loading={loading} disabled={blocked || !phone.trim() || turnstile.needsToken}>
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
          {showDevCodeHelper ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={blocked}
              onClick={() => {
                void handleFillDevCode();
              }}
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
          <Button type="button" variant="ghost" size="sm" disabled={blocked} onClick={() => onResendSmsCode?.()}>
            Resend code
          </Button>
          <Button type="submit" loading={loading} disabled={blocked || smsCode.length !== 6}>
            Verify code
          </Button>
        </div>
      </form>
    );
  }

  return <JoinProfileForm blocked={blocked} loading={loading} onCompleteProfile={onCompleteProfile} />;
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
          Back to sign-in
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
      <Button type="submit" loading={loading} disabled={blocked || !reviewerId.trim() || !reviewerPassword}>
        Sign in as reviewer
      </Button>
    </form>
  );
}

/**
 * Onboarding dialog with Email Magic Link, Phone SMS, and Connect Agent tabs plus a subtle Reviewer sign-in footer link.
 * @model spec/app/onboarding.md
 */
export function JoinSheet({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  emailAuthEnabled = true,
  activeTab,
  onTabChange,
  emailStep,
  onEmailStepChange,
  pendingEmailMasked,
  pendingEmail,
  devEmailLinkEnabled = false,
  devEmailMagicLinkUrl,
  onOpenDevMagicLink,
  onRequestEmailMagicLink,
  onResendEmailMagicLink,
  phoneStep,
  onPhoneStepChange,
  pendingActionLabel,
  skillPrompt = defaultSkillPrompt,
  launchers = defaultAgentLaunchers,
  turnstileSiteKey,
  devSmsCode,
  devSmsCodeEnabled = false,
  onFillDevCode,
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
  const defaultDoor: JoinTab = emailAuthEnabled ? "email" : "phone";
  const [internalTab, setInternalTab] = useState<JoinTab>(defaultDoor);
  const [internalEmailStep, setInternalEmailStep] = useState<JoinEmailStep>("entry");
  const [internalPhoneStep, setInternalPhoneStep] = useState<JoinPhoneStep>("entry");
  const [formResetKey, setFormResetKey] = useState(0);

  const rawTab = activeTab ?? internalTab;
  const currentTab: JoinTab = !emailAuthEnabled && rawTab === "email" ? "phone" : rawTab;
  const currentEmailStep = emailStep ?? internalEmailStep;
  const currentPhoneStep = phoneStep ?? internalPhoneStep;
  const blocked = disabled || loading;

  const setTab = (next: JoinTab) => {
    if (blocked) return;
    if (activeTab === undefined) setInternalTab(next);
    onTabChange?.(next);
  };

  const setEmailStep = (next: JoinEmailStep) => {
    if (blocked) return;
    if (emailStep === undefined) setInternalEmailStep(next);
    onEmailStepChange?.(next);
  };

  const setPhoneStep = (next: JoinPhoneStep) => {
    if (blocked) return;
    if (phoneStep === undefined) setInternalPhoneStep(next);
    onPhoneStepChange?.(next);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (blocked) return;
    if (!nextOpen) {
      setFormResetKey((n) => n + 1);
      if (emailStep === undefined) setInternalEmailStep("entry");
      if (phoneStep === undefined) setInternalPhoneStep("entry");
    }
    onOpenChange?.(nextOpen);
  };

  return (
    <Dialog open={open} defaultOpen={defaultOpen} onOpenChange={handleOpenChange}>
      {trigger ? (
        <DialogTrigger asChild disabled={blocked}>
          {trigger}
        </DialogTrigger>
      ) : null}
      <DialogContent className="max-w-lg rounded-xl">
        <div className="flex flex-col gap-1">
          <DialogTitle>Join Feed</DialogTitle>
          <DialogDescription>
            {pendingActionLabel
              ? `Sign in to ${pendingActionLabel}. New verified accounts receive 100 pts.`
              : emailAuthEnabled
                ? "Sign in with email, phone, or connect one AI agent."
                : "Sign in with your phone or connect one AI agent."}
          </DialogDescription>
        </div>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        {currentTab === "reviewer" ? (
          <JoinReviewerForm
            key={`reviewer:${formResetKey}`}
            blocked={blocked}
            loading={loading}
            onSubmitReviewer={onSubmitReviewer}
            onBack={() => setTab(defaultDoor)}
          />
        ) : (
          <>
            <Tabs
              value={currentTab}
              onValueChange={(next) => {
                if (next === "email" && emailAuthEnabled) setTab("email");
                else if (next === "agent") setTab("agent");
                else setTab("phone");
              }}
            >
              <TabsList variant="underline" className={cn("grid w-full", emailAuthEnabled ? "grid-cols-3" : "grid-cols-2")}>
                {emailAuthEnabled ? (
                  <TabsTrigger value="email" disabled={blocked}>Email</TabsTrigger>
                ) : null}
                <TabsTrigger value="phone" disabled={blocked}>Phone</TabsTrigger>
                <TabsTrigger value="agent" disabled={blocked}>Connect Agent</TabsTrigger>
              </TabsList>

              {emailAuthEnabled ? (
                <TabsContent value="email">
                  <JoinEmailDoor
                    key={`email:${formResetKey}`}
                    step={currentEmailStep}
                    isStepControlled={emailStep !== undefined}
                    blocked={blocked}
                    loading={loading}
                    turnstileSiteKey={turnstileSiteKey}
                    pendingEmailMasked={pendingEmailMasked}
                    pendingEmail={pendingEmail}
                    devEmailLinkEnabled={devEmailLinkEnabled}
                    devEmailMagicLinkUrl={devEmailMagicLinkUrl}
                    onOpenDevMagicLink={onOpenDevMagicLink}
                    onStepChange={setEmailStep}
                    onRequestEmailMagicLink={onRequestEmailMagicLink}
                    onResendEmailMagicLink={onResendEmailMagicLink}
                    onCompleteProfile={onCompleteProfile}
                  />
                </TabsContent>
              ) : null}

              <TabsContent value="phone">
                <JoinPhoneDoor
                  key={`phone:${formResetKey}`}
                  step={currentPhoneStep}
                  isStepControlled={phoneStep !== undefined}
                  blocked={blocked}
                  loading={loading}
                  turnstileSiteKey={turnstileSiteKey}
                  devSmsCode={devSmsCode}
                  devSmsCodeEnabled={devSmsCodeEnabled}
                  onFillDevCode={onFillDevCode}
                  onStepChange={setPhoneStep}
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
                <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <span>Agents never receive your email, phone number, or sign-in codes.</span>
                  <Button type="button" variant="outline" size="sm" disabled={blocked} onClick={() => setTab(defaultDoor)}>
                    {emailAuthEnabled ? "Sign in" : "Verify phone"}
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
