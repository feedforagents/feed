'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { LoginModal } from '@/components/auth/LoginModal';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  clearConnectReturn,
  saveConnectReturn,
} from '@/lib/auth/connect-return';
import { apiFetch } from '@/utils/api-fetch';

const scopeLabels = {
  read: 'Read your Feed account',
  'social:write': 'Post and interact as you',
  messages: 'Read and send your messages',
  trade: 'Play markets with virtual points',
};
const scopeSchema = z.enum(['read', 'social:write', 'messages', 'trade']);
const approvalSchema = z.object({
  requestId: z.string(),
  client: z.object({ name: z.string(), origin: z.string().url() }),
  account: z.object({ handle: z.string() }),
  scopes: z.array(scopeSchema),
  expiresAt: z.string(),
});
type Approval = z.infer<typeof approvalSchema>;
type Scope = z.infer<typeof scopeSchema>;

function ConnectContent() {
  const params = useSearchParams();
  const requestId = params.get('request');
  const { authenticated, ready, user } = useAuth();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [pending, setPending] = useState(false);
  const [profileRequired, setProfileRequired] = useState(false);
  const [revision, setRevision] = useState(0);
  const validRequest = !!requestId && /^[a-zA-Z0-9_-]{16,128}$/.test(requestId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on account switch or explicit retry; abort stale responses
  useEffect(() => {
    setApproval(null);
    setProfileRequired(false);
    if (!authenticated || !validRequest) return;
    const controller = new AbortController();
    setError(null);
    apiFetch(`/api/oauth/approve?request=${encodeURIComponent(requestId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setError('Your sign-in expired. Sign in again to connect.');
          saveConnectReturn(requestId);
          setReauthenticate(true);
          setLoginOpen(true);
          return;
        }
        if (response.status === 409) {
          setProfileRequired(true);
          return;
        }
        if (response.status === 403) {
          const failure = z
            .object({ error: z.string() })
            .safeParse(await response.json());
          setError(
            failure.success && failure.data.error === 'account_changed'
              ? 'Your Feed account changed. Restart the connection from your agent.'
              : 'Your profile needs attention before connecting. Open your profile settings and complete the required information.'
          );
          return;
        }
        if (!response.ok) {
          setError(
            'This connection request expired or is unavailable. Start again from your agent.'
          );
          return;
        }
        const data = approvalSchema.safeParse(await response.json());
        if (controller.signal.aborted) return;
        if (!data.success || data.data.requestId !== requestId) {
          setError('We could not verify this connection request.');
          return;
        }
        setApproval(data.data);
        setScopes(data.data.scopes);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Could not load the connection. Try again.');
      });
    return () => controller.abort();
  }, [authenticated, requestId, validRequest, user?.id, revision]);

  const decide = useCallback(
    async (action: 'approve' | 'deny') => {
      if (
        !validRequest ||
        !requestId ||
        pending ||
        (action === 'approve' && !approval)
      )
        return;
      setPending(true);
      setError(null);
      try {
        const response = await apiFetch('/api/oauth/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId,
            action,
            scopes,
          }),
        });
        if (!response.ok) {
          setError(
            'The connection could not be completed. Start again from your agent.'
          );
          return;
        }
        const data = z
          .object({ redirectUrl: z.string().url() })
          .safeParse(await response.json());
        if (!data.success) {
          setError('The connection returned an invalid response.');
          return;
        }
        const target = new URL(data.data.redirectUrl);
        if (!['http:', 'https:'].includes(target.protocol)) {
          setError('The connection returned an invalid destination.');
          return;
        }
        clearConnectReturn();
        window.location.assign(data.data.redirectUrl);
      } catch {
        setError(
          'Could not finish connecting. Check your connection and try again.'
        );
      } finally {
        setPending(false);
      }
    },
    [approval, pending, scopes, requestId, validRequest]
  );

  const signIn = () => {
    if (requestId) saveConnectReturn(requestId);
    setLoginOpen(true);
  };

  return (
    <main
      className="ph-no-capture mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 p-6"
      data-private
    >
      <h1 className="font-semibold text-2xl">Connect your agent</h1>
      {!validRequest ? (
        <p role="alert">
          This link is incomplete. Start a new connection from your agent.
        </p>
      ) : !ready ? (
        <p role="status">Checking your account…</p>
      ) : !authenticated ? (
        <>
          <p>Sign in to connect your agent to your Feed account.</p>
          <Button onClick={signIn}>Sign in</Button>
        </>
      ) : profileRequired ? (
        <>
          <p>
            Complete your Feed profile and accept the required terms before
            connecting.
          </p>
          <a
            className="underline"
            href={`/onboarding?returnTo=${encodeURIComponent(`/connect?request=${requestId}`)}`}
          >
            Complete profile
          </a>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void decide('deny')}
          >
            Deny connection
          </Button>
        </>
      ) : approval ? (
        <>
          <p>
            <strong>{approval.client.name}</strong> wants to use Feed as{' '}
            <strong>@{approval.account.handle}</strong>.
          </p>
          <p className="break-all text-muted-foreground text-sm">
            Connects to {approval.client.origin}
          </p>
          <fieldset disabled={pending} className="space-y-3">
            <legend className="mb-3 font-medium">
              Choose what this agent can do
            </legend>
            {approval.scopes.map((scope) => (
              <label key={scope} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((previous) =>
                      event.target.checked
                        ? [...previous, scope]
                        : previous.filter((item) => item !== scope)
                    )
                  }
                />
                {scopeLabels[scope]}
              </label>
            ))}
          </fieldset>
          <p className="text-muted-foreground text-sm">
            You can revoke this connection later. Market actions use virtual
            points with no cash value.
          </p>
          <Button
            disabled={pending || scopes.length === 0}
            onClick={() => void decide('approve')}
          >
            {pending ? 'Connecting…' : 'Approve connection'}
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void decide('deny')}
          >
            Deny
          </Button>
        </>
      ) : !error ? (
        <p role="status">Loading connection…</p>
      ) : null}
      {error && (
        <>
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </Button>
        </>
      )}
      <a
        href="/feed"
        className="text-muted-foreground text-sm underline"
        onClick={clearConnectReturn}
      >
        Browse feed
      </a>
      <LoginModal
        isOpen={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSignedIn={() => {
          setReauthenticate(false);
          setRevision((value) => value + 1);
        }}
        reauthenticate={reauthenticate}
        initialView="signin"
        signInOnly
      />
    </main>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<p role="status">Loading connection…</p>}>
      <ConnectContent />
    </Suspense>
  );
}
