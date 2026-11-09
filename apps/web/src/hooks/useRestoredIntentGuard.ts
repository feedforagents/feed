'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { useAuth } from '@/hooks/useAuth';
import { getBrowserDevAuthSession } from '@/lib/auth/dev-auth';

export interface RestoredIntentGuard {
  sessionId: string;
  ownerId: string;
  expiresAt: number;
}
/** A restored draft remains local to the account and sign-in which restored it. */
export function useRestoredIntentGuard(onInvalidate: () => void) {
  const { session } = useStewardAuthContext();
  const { authenticated, user } = useAuth();
  const identity = authenticated
    ? (session?.userId ??
      session?.address ??
      getBrowserDevAuthSession()?.userId ??
      null)
    : null;
  const [guard, setGuard] = useState<RestoredIntentGuard | null>(null);
  const current = useRef({ guard, identity, ownerId: user?.id });
  current.current = { guard, identity, ownerId: user?.id };
  const isCurrent = useCallback(() => {
    const value = current.current;
    return (
      value.guard !== null &&
      value.guard.sessionId === value.identity &&
      value.guard.ownerId === value.ownerId &&
      value.guard.expiresAt > Date.now()
    );
  }, []);
  const callback = useRef(onInvalidate);
  callback.current = onInvalidate;
  const disarm = useCallback(() => {
    current.current.guard = null;
    setGuard(null);
  }, []);
  useEffect(
    () => () => {
      current.current.guard = null;
    },
    []
  );
  const valid =
    guard !== null &&
    guard.sessionId === identity &&
    guard.ownerId === user?.id &&
    guard.expiresAt > Date.now();
  useEffect(() => {
    if (!guard) return;
    const invalidate = () => {
      current.current.guard = null;
      setGuard(null);
      callback.current();
    };
    if (!valid) {
      invalidate();
      return;
    }
    const timer = window.setTimeout(
      invalidate,
      Math.max(0, guard.expiresAt - Date.now())
    );
    window.addEventListener('popstate', invalidate);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', invalidate);
    };
  }, [guard, valid]);
  return { arm: setGuard, disarm, valid, isCurrent };
}
