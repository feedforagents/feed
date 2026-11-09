'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { consumeConnectReturn } from '@/lib/auth/connect-return';
import { safeReturnTo } from '@/lib/auth/safe-return-to';
import { stewardCallbackParams } from '@/lib/auth/steward-exchange';

/**
 * OAuth callback page for Steward OAuth providers (Google, Discord, Twitter/X).
 *
 * Steward redirects with #code=<one-time-code>&state=<state>, or an error.
 * The SDK verifies state and exchanges the code with its stored PKCE verifier.
 *
 * Security: Immediately sanitizes the URL via replaceState() to prevent
 * the one-time code from remaining in browser history.
 */
export default function OAuthCallbackPage() {
  const { stewardAuth, onLoginSuccess } = useStewardAuthContext();
  const { provider } = useParams<{ provider: string }>();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const url = new URL(window.location.href);
    const params = url.searchParams;
    const callback = stewardCallbackParams(url);
    const errorParam = callback.error;
    const stateParam = callback.state;
    const destination = safeReturnTo(params.get('returnTo'));

    // Sanitize URL immediately — remove sensitive query params from history
    window.history.replaceState(null, '', window.location.pathname);

    if (window.opener) {
      window.opener.postMessage(
        { type: 'steward-oauth-callback', ...callback },
        window.location.origin
      );
      window.close();
      return;
    }

    if (stateParam) {
      setState(stateParam);
    }

    if (errorParam) {
      setError(errorParam);
      return;
    }

    if (!callback.code || !callback.state) {
      setError('Missing sign-in code or state. Please start sign-in again.');
      return;
    }

    stewardAuth
      .handleOAuthCallback(provider, callback)
      .then((result) => {
        if ('mfaRequired' in result) {
          throw new Error(
            'Additional verification is required. Restart sign-in from the login dialog.'
          );
        }
        return onLoginSuccess(result.token, result.refreshToken);
      })
      .then(() => {
        window.location.assign(consumeConnectReturn() ?? destination);
      })
      .catch((err: Error) => {
        setError(err.message);
      });
  }, [stewardAuth, onLoginSuccess, provider]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        {error ? (
          <>
            <p className="font-semibold text-destructive">Sign-in failed</p>
            <p className="mt-2 max-w-sm text-muted-foreground text-sm">
              {error}
            </p>
            {state ? (
              <p className="mt-2 max-w-sm text-muted-foreground text-xs">
                State: {state}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-muted-foreground text-sm">Completing sign-in…</p>
          </>
        )}
      </div>
    </div>
  );
}
