'use client';

import { useEffect, useRef, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { consumeConnectReturn } from '@/lib/auth/connect-return';

/**
 * Email magic-link callback page.
 *
 * Steward redirects here after a user clicks the magic link in their email:
 *   ?token=<verification_token>&email=<email>
 *
 * Calls stewardAuth.verifyEmailCallback() to exchange the token for a session
 * JWT, then POSTs to /api/auth/session to set the httpOnly cookie.
 */
export default function EmailCallbackPage() {
  const { stewardAuth, onLoginSuccess } = useStewardAuthContext();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const processed = useRef(false);

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const email = params.get('email');
    const errorParam = params.get('error');
    const stateParam = params.get('state');

    // Sanitize URL immediately
    window.history.replaceState(null, '', window.location.pathname);

    if (stateParam) {
      setState(stateParam);
    }

    if (errorParam) {
      setError(errorParam);
      return;
    }

    if (!token || !email) {
      setError('missing_params');
      return;
    }

    stewardAuth
      .verifyEmailCallback(token, email)
      .then((result) => {
        if ('mfaRequired' in result) {
          throw new Error(
            'Additional verification is required. Enter the email code in the login dialog.'
          );
        }
        return onLoginSuccess(result.token, result.refreshToken);
      })
      .then(() => window.location.assign(consumeConnectReturn() ?? '/'))
      .catch((err: Error) => {
        setError(err.message);
      });
  }, [stewardAuth, onLoginSuccess]);

  return (
    <div className="flex min-h-dvh items-center justify-center">
      <div className="text-center">
        {error ? (
          <>
            <p className="font-semibold text-destructive">
              Email sign-in failed
            </p>
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
            <p className="text-muted-foreground text-sm">
              Verifying your email…
            </p>
          </>
        )}
      </div>
    </div>
  );
}
