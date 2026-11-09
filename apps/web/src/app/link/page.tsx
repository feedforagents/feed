'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { LoginModal } from '@/components/auth/LoginModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/hooks/useAuth';
import {
  clearConnectReturn,
  saveDeviceReturn,
} from '@/lib/auth/connect-return';
import { apiFetch } from '@/utils/api-fetch';

const scopeSchema = z.enum(['read', 'social:write', 'messages', 'trade']);
const scopeLabels = {
  read: 'Read your Feed account',
  'social:write': 'Post and interact as you',
  messages: 'Read and send your messages',
  trade: 'Play markets with virtual points',
};
const approvalSchema = z.object({
  userCode: z.string(),
  client: z.object({ name: z.string() }),
  account: z.object({ handle: z.string() }),
  scopes: z.array(scopeSchema),
  expiresAt: z.string().datetime(),
});
type Approval = z.infer<typeof approvalSchema>;
type Scope = z.infer<typeof scopeSchema>;

function DeviceLinkContent() {
  const params = useSearchParams();
  const initialCode = params.get('user_code') ?? '';
  const { authenticated, ready, user } = useAuth();
  const [entry, setEntry] = useState(initialCode);
  const [userCode, setUserCode] = useState(initialCode.toUpperCase());
  const [approval, setApproval] = useState<Approval | null>(null);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [profileRequired, setProfileRequired] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState<'approved' | 'denied' | null>(null);
  const [revision, setRevision] = useState(0);
  const validCode =
    /^[BCDFGHJKLMNPQRSTVWXZ2-9]{4}-?[BCDFGHJKLMNPQRSTVWXZ2-9]{4}$/.test(
      userCode
    );
  const normalizedCode = userCode.replace('-', '');
  const entryMatches =
    entry.trim().toUpperCase().replace('-', '') === normalizedCode;

  useEffect(() => {
    setEntry(initialCode);
    setUserCode(initialCode.toUpperCase());
  }, [initialCode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch on account switch and explicit retry; abort obsolete responses
  useEffect(() => {
    setApproval(null);
    setProfileRequired(false);
    setComplete(null);
    if (!authenticated || !validCode) return;
    const controller = new AbortController();
    setError(null);
    apiFetch(
      `/api/oauth/device/approve?user_code=${encodeURIComponent(userCode)}`,
      { signal: controller.signal }
    )
      .then(async (response) => {
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          saveDeviceReturn(userCode);
          setReauthenticate(true);
          setLoginOpen(true);
          return;
        }
        if (response.status === 409) {
          setProfileRequired(true);
          return;
        }
        if (!response.ok) {
          setError(
            response.status === 403
              ? 'Your account changed or needs attention. Restart the connection from your agent.'
              : response.status === 429
                ? 'Too many attempts. Wait before trying again.'
                : 'This code is no longer available. Return to your agent to check the connection or start again.'
          );
          return;
        }
        const parsed = approvalSchema.safeParse(await response.json());
        if (controller.signal.aborted) return;
        if (!parsed.success || parsed.data.userCode !== normalizedCode) {
          setError('We could not verify this connection request.');
          return;
        }
        setApproval(parsed.data);
        setScopes(parsed.data.scopes);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Could not load the connection. Try again.');
      });
    return () => controller.abort();
  }, [authenticated, userCode, validCode, normalizedCode, user?.id, revision]);

  const decide = useCallback(
    async (action: 'approve' | 'deny') => {
      if (
        pending ||
        (action === 'approve' && !entryMatches) ||
        (!approval && !(action === 'deny' && profileRequired))
      )
        return;
      setPending(true);
      setError(null);
      try {
        const response = await apiFetch('/api/oauth/device/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userCode,
            action,
            scopes: action === 'deny' ? [] : scopes,
          }),
        });
        if (!response.ok) {
          setError(
            'This approval could not be completed. Restart from your agent if it expired or your account changed.'
          );
          return;
        }
        const parsed = z
          .object({ status: z.enum(['approved', 'denied']) })
          .safeParse(await response.json());
        if (
          !parsed.success ||
          parsed.data.status !== (action === 'approve' ? 'approved' : 'denied')
        ) {
          setError(
            'We could not verify the result. Check your agent before retrying.'
          );
          return;
        }
        clearConnectReturn();
        setComplete(parsed.data.status);
        setApproval(null);
      } catch {
        setError(
          'The connection was interrupted. Check your agent before retrying.'
        );
      } finally {
        setPending(false);
      }
    },
    [pending, approval, profileRequired, userCode, scopes, entryMatches]
  );

  return (
    <main className="mx-auto max-w-lg space-y-6 px-4 py-12">
      <h1 className="font-semibold text-2xl">Connect your agent</h1>
      <p>
        Enter the code your agent gave you. Approve only a connection you
        started.
      </p>
      {!complete && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setUserCode(entry.trim().toUpperCase());
            setRevision((value) => value + 1);
          }}
        >
          <label className="flex-1">
            Connection code
            <Input
              aria-label="Connection code"
              autoComplete="off"
              maxLength={9}
              disabled={pending}
              autoCapitalize="characters"
              placeholder="BCDF-GHJK"
              value={entry}
              onChange={(event) => {
                setEntry(event.target.value);
                setApproval(null);
              }}
            />
          </label>
          <Button className="self-end" type="submit" disabled={pending}>
            Continue
          </Button>
        </form>
      )}
      {userCode && !validCode && (
        <p role="alert">Enter the eight-character code shown by your agent.</p>
      )}
      {ready && validCode && !authenticated && (
        <Button
          onClick={() => {
            saveDeviceReturn(userCode);
            setLoginOpen(true);
          }}
        >
          Sign in
        </Button>
      )}
      {error && (
        <div role="alert" className="space-y-3">
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => setRevision((value) => value + 1)}
          >
            Try again
          </Button>
        </div>
      )}
      {profileRequired && !complete && (
        <div className="space-y-3">
          <p>
            Complete your required profile and terms before approving this
            connection.
          </p>
          <a
            className="underline"
            href={`/onboarding?returnTo=${encodeURIComponent(`/link?user_code=${userCode}`)}`}
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
        </div>
      )}
      {approval && entryMatches && !complete && (
        <section className="space-y-4" aria-label="Agent permissions">
          <p>
            <strong>{approval.client.name}</strong> wants to connect as{' '}
            <strong>@{approval.account.handle}</strong>.
          </p>
          <p className="text-sm">
            The app supplies its name. Check that this is the agent and code you
            intended to connect.
          </p>
          <p>
            Code: <strong>{userCode}</strong>
          </p>
          <fieldset className="space-y-3">
            <legend>Allow this agent to:</legend>
            {approval.scopes.map((scope) => (
              <label key={scope} className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((value) => value !== scope)
                    )
                  }
                />
                {scopeLabels[scope]}
              </label>
            ))}
          </fieldset>
          <p className="text-sm">
            You can revoke this connection in Connected agents.
          </p>
          <div className="flex gap-3">
            <Button
              disabled={
                pending ||
                !scopes.length ||
                Date.parse(approval.expiresAt) <= Date.now()
              }
              onClick={() => void decide('approve')}
            >
              Approve connection
            </Button>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void decide('deny')}
            >
              Deny
            </Button>
          </div>
        </section>
      )}
      {complete && (
        <p role="status">
          {complete === 'approved'
            ? 'Connection approved. Return to your agent; it will confirm when it is connected.'
            : 'Connection denied. Your agent has not been given access.'}
        </p>
      )}
      <a href="/feed" className="inline-block underline">
        Browse Feed
      </a>
      <LoginModal
        isOpen={loginOpen}
        signInOnly
        reauthenticate={reauthenticate}
        onClose={() => setLoginOpen(false)}
        onSignedIn={() => {
          setLoginOpen(false);
          setReauthenticate(false);
          setRevision((value) => value + 1);
        }}
      />
    </main>
  );
}
export default function DeviceLinkPage() {
  return (
    <Suspense fallback={<main className="p-6">Loading connection…</main>}>
      <DeviceLinkContent />
    </Suspense>
  );
}
