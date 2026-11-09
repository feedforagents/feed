'use client';

import { logger } from '@feed/shared';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import { getStewardApiUrl, STEWARD_TENANT_ID } from '@/lib/auth/steward-config';
import {
  type StewardLoginResult,
  stewardExchangeSchema,
} from '@/lib/auth/steward-exchange';
import {
  type AgentEntryView,
  agentSetupPromptForEntry,
} from '@/lib/onboarding/agent-entry';

/**
 * Steward-backed login modal.
 *
 * Supports:
 * - Email magic link (no password)
 * - Passkey (WebAuthn)
 * - OAuth: Google, Discord, Twitter/X
 */

type Step = 'idle' | 'email-sent' | 'loading' | 'error' | 'mfa';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  initialView?: AgentEntryView;
  signInOnly?: boolean;
  reauthenticate?: boolean;
  onSignedIn?: () => void;
}

export function LoginModal({
  isOpen,
  onClose,
  title,
  message,
  initialView = 'agent',
  signInOnly = false,
  reauthenticate = false,
  onSignedIn,
}: LoginModalProps) {
  const dialogId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    const dialog = document.getElementById(dialogId);
    const controls = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]'
        ) ?? []
      );
    (controls()[0] ?? dialog)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const items = controls();
        const first = items[0];
        const last = items.at(-1);
        if (!first || !last) {
          event.preventDefault();
          dialog?.focus();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !dialog?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !dialog?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      if (
        previousFocus instanceof HTMLElement &&
        document.contains(previousFocus)
      )
        previousFocus.focus();
    };
  }, [isOpen, dialogId]);
  const { stewardAuth, onLoginSuccess } = useStewardAuthContext();
  const { authenticated } = useAuth();
  const [requestedView, setView] = useState<AgentEntryView>(initialView);
  const [copied, setCopied] = useState(false);
  const prompt = agentSetupPromptForEntry(
    process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.NODE_ENV !== 'production'
        ? 'http://localhost:3000'
        : undefined)
  );
  const view: AgentEntryView = prompt === null ? 'signin' : requestedView;
  const signInPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isOpen && view === 'agent' && !signInOnly)
      document.getElementById(dialogId)?.querySelector('textarea')?.focus();
    if (isOpen && view === 'signin')
      signInPane.current
        ?.querySelector<HTMLInputElement>('input[type=email]')
        ?.focus();
  }, [isOpen, view, dialogId, signInOnly]);
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [mfa, setMfa] = useState<
    Extract<StewardLoginResult, { mfaRequired: true }>['mfa'] | null
  >(null);

  const completeLogin = useCallback(
    async (result: StewardLoginResult) => {
      if ('mfa' in result) {
        setMfa(result.mfa);
        setVerificationCode('');
        setStep('mfa');
        return;
      }
      await onLoginSuccess(result.token, result.refreshToken);
      onSignedIn?.();
      onClose();
    },
    [onLoginSuccess, onClose, onSignedIn]
  );

  useEffect(() => {
    if (authenticated && isOpen && !reauthenticate) onClose();
  }, [authenticated, isOpen, onClose, reauthenticate]);

  useEffect(() => {
    if (!isOpen) {
      setView(signInOnly ? 'signin' : initialView);
      setCopied(false);
      setStep('idle');
      setEmail('');
      setErrorMsg('');
      setVerificationCode('');
      setMfa(null);
    }
  }, [isOpen, initialView, signInOnly]);

  const handleEmailLogin = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setErrorMsg('Please enter a valid email address.');
      return;
    }
    setStep('loading');
    setErrorMsg('');
    try {
      const result = await stewardAuth.signInWithEmail(trimmed);
      if (result.ok) {
        setStep('email-sent');
        logger.info('Magic link sent', {}, 'LoginModal');
      } else {
        setErrorMsg('Failed to send magic link. Please try again.');
        setStep('error');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.warn('Email login failed', { error: msg }, 'LoginModal');
      setErrorMsg(msg);
      setStep('error');
    }
  }, [email, stewardAuth]);

  const handlePasskeyLogin = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@')) {
      setErrorMsg('Please enter your email address to use a passkey.');
      return;
    }
    setStep('loading');
    setErrorMsg('');
    try {
      const result = await stewardAuth.signInWithPasskey(trimmed);
      await completeLogin(result);
      logger.info('Passkey login successful', {}, 'LoginModal');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Passkey login failed';
      logger.warn('Passkey login failed', { error: msg }, 'LoginModal');
      setErrorMsg(msg);
      setStep('error');
    }
  }, [email, stewardAuth, completeLogin]);

  const handleOAuth = useCallback(
    async (provider: 'google' | 'discord' | 'twitter') => {
      setStep('loading');
      setErrorMsg('');
      try {
        const result = await stewardAuth.signInWithOAuth(provider, {
          tenantId: STEWARD_TENANT_ID,
          redirectUri: `${window.location.origin}/auth/callback/${provider}`,
        });
        await completeLogin(result);
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : 'Sign-in failed');
        setStep('error');
      }
    },
    [stewardAuth, completeLogin]
  );

  const verifyEmailCode = async () => {
    setVerifying(true);
    setErrorMsg('');
    try {
      const response = await fetch(
        `${getStewardApiUrl()}/auth/email/code/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Steward-Tenant': STEWARD_TENANT_ID,
          },
          body: JSON.stringify({
            email: email.trim(),
            code: verificationCode.trim(),
            tenantId: STEWARD_TENANT_ID,
          }),
        }
      );
      if (!response.ok)
        throw new Error(
          'The code is invalid or expired. Try again or request another email.'
        );
      await completeLogin(stewardExchangeSchema.parse(await response.json()));
    } catch (error) {
      setErrorMsg(
        error instanceof Error ? error.message : 'Code verification failed'
      );
    } finally {
      setVerifying(false);
    }
  };

  const verifyMfa = async (recovery = false) => {
    if (!mfa) return;
    setVerifying(true);
    setErrorMsg('');
    try {
      const result = recovery
        ? await stewardAuth.completeRecoveryCodeMfa(
            mfa.challengeId,
            verificationCode.trim()
          )
        : mfa.type === 'sms'
          ? await stewardAuth.completeSmsMfa(
              mfa.challengeId,
              verificationCode.trim()
            )
          : mfa.type === 'passkey'
            ? await stewardAuth.completePasskeyMfa()
            : await stewardAuth.completeTotpMfa(
                mfa.challengeId,
                verificationCode.trim()
              );
      await completeLogin(result);
    } catch (error) {
      setErrorMsg(
        error instanceof Error ? error.message : 'Verification failed'
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="ph-no-capture p-8 sm:max-w-sm"
        data-private
        data-feed-auth-open
        id={dialogId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        tabIndex={-1}
      >
        <DialogHeader>
          <DialogTitle id={`${dialogId}-title`} className="text-center text-xl">
            {view === 'agent' && !signInOnly
              ? 'Connect your agent'
              : (title ?? 'Sign in to Feed')}
          </DialogTitle>
          {(view === 'signin' || signInOnly) && (
            <DialogDescription
              id={`${dialogId}-description`}
              className="text-center"
            >
              {message ?? 'Use your existing Feed sign-in.'}
            </DialogDescription>
          )}
        </DialogHeader>

        {view === 'agent' && !signInOnly ? (
          <div className="flex flex-col gap-4 pt-1">
            <DialogDescription id={`${dialogId}-description`}>
              Give your agent this prompt to connect Feed and play from your own
              account.
            </DialogDescription>
            <textarea
              aria-label="Feed agent setup prompt"
              readOnly
              value={prompt ?? ''}
              rows={4}
              className="w-full resize-none rounded-md border bg-muted p-3 text-sm"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              onClick={async () => {
                if (prompt === null) return;
                try {
                  await navigator.clipboard.writeText(prompt);
                  setCopied(true);
                  setErrorMsg('');
                } catch {
                  setErrorMsg('Select and copy the prompt above.');
                }
              }}
            >
              {copied ? 'Prompt copied' : 'Copy prompt'}
            </Button>
            <p role="status" className="sr-only">
              {copied ? 'Prompt copied to clipboard' : ''}
            </p>
            <ol className="list-inside list-decimal space-y-1 text-muted-foreground text-sm">
              <li>Paste it into your agent.</li>
              <li>Connect and approve access.</li>
              <li>Continue playing.</li>
            </ol>
            <Button
              variant="outline"
              onClick={() => {
                setView('signin');
                setErrorMsg('');
              }}
            >
              Sign in
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Browse feed
            </Button>
            {errorMsg && (
              <p role="alert" className="text-destructive text-sm">
                {errorMsg}
              </p>
            )}
          </div>
        ) : (
          <div ref={signInPane} className="flex flex-col gap-3 pt-1">
            {prompt === null && (
              <p role="status" className="text-muted-foreground text-sm">
                Agent setup is unavailable at this address. You can still sign
                in.
              </p>
            )}
            {!signInOnly && prompt !== null && (
              <Button
                variant="ghost"
                onClick={() => {
                  setView('agent');
                  setErrorMsg('');
                }}
              >
                Connect your agent instead
              </Button>
            )}
            {step === 'mfa' && mfa ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  Complete your account's additional verification.
                </p>
                <Input
                  aria-label="Verification or recovery code"
                  autoComplete="one-time-code"
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  disabled={verifying}
                />
                <Button
                  onClick={() => void verifyMfa()}
                  disabled={
                    verifying ||
                    (mfa.type !== 'passkey' && !verificationCode.trim())
                  }
                >
                  {mfa.type === 'passkey'
                    ? 'Verify with passkey'
                    : 'Verify code'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void verifyMfa(true)}
                  disabled={verifying || !verificationCode.trim()}
                >
                  Use recovery code
                </Button>
              </div>
            ) : step === 'email-sent' ? (
              <div className="rounded-xl border bg-muted/50 p-5 text-center">
                <div className="mb-2 text-2xl">📬</div>
                <p className="font-semibold">Check your inbox</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  Enter the six-digit code sent to <strong>{email}</strong>.
                </p>
                <Input
                  className="mt-3"
                  aria-label="Email verification code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={verificationCode}
                  onChange={(event) => setVerificationCode(event.target.value)}
                  disabled={verifying}
                />
                <Button
                  className="mt-3 w-full"
                  onClick={() => void verifyEmailCode()}
                  disabled={verifying || !/^\d{6}$/.test(verificationCode)}
                >
                  Verify email
                </Button>
                <p className="mt-1 text-muted-foreground text-xs">
                  No email? Check spam or{' '}
                  <button
                    className="text-primary underline-offset-4 hover:underline"
                    onClick={() => setStep('idle')}
                    type="button"
                  >
                    try again
                  </button>
                  .
                </p>
              </div>
            ) : (
              <>
                {/* OAuth buttons — always enabled */}
                <div className="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    onClick={() => handleOAuth('google')}
                    disabled={step === 'loading'}
                    className="w-full gap-2"
                  >
                    <GoogleIcon />
                    Continue with Google
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleOAuth('discord')}
                    disabled={step === 'loading'}
                    className="w-full gap-2"
                  >
                    <DiscordIcon />
                    Continue with Discord
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => handleOAuth('twitter')}
                    disabled={step === 'loading'}
                    className="w-full gap-2"
                  >
                    <XIcon />
                    Continue with X
                  </Button>
                </div>

                <div className="relative flex items-center gap-3">
                  <div className="flex-1 border-t" />
                  <span className="text-muted-foreground text-xs">
                    or use email
                  </span>
                  <div className="flex-1 border-t" />
                </div>

                {/* Email + Passkey */}
                <div className="flex flex-col gap-2">
                  <Input
                    type="email"
                    aria-label="Email address"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleEmailLogin();
                    }}
                    disabled={step === 'loading'}
                    autoComplete="email"
                    className="h-10"
                  />
                  <div className="flex gap-2">
                    <Button
                      onClick={() => void handleEmailLogin()}
                      disabled={step === 'loading' || !email.trim()}
                      className="flex-1"
                      size="sm"
                    >
                      {step === 'loading' ? (
                        <span className="flex items-center gap-2">
                          <LoadingSpinner />
                          Sending…
                        </span>
                      ) : (
                        'Send code'
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void handlePasskeyLogin()}
                      disabled={step === 'loading' || !email.trim()}
                      className="flex-1"
                      size="sm"
                      title="Sign in with a passkey (biometric / hardware key)"
                    >
                      🔑 Passkey
                    </Button>
                  </div>
                </div>
              </>
            )}
            {errorMsg && (
              <p role="alert" className="text-center text-destructive text-xs">
                {errorMsg}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Icon SVGs ─────────────────────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function DiscordIcon() {
  return (
    <svg className="size-4 fill-[#5865F2]" viewBox="0 0 24 24" aria-hidden>
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="size-4 fill-current" viewBox="0 0 24 24" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.259 5.63 5.905-5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function LoadingSpinner() {
  return (
    <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
  );
}
