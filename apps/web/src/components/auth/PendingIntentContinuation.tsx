'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { useAuth } from '@/hooks/useAuth';
import { useLoginModal } from '@/hooks/useLoginModal';
import { usePendingIntent } from '@/hooks/usePendingIntent';
import { getBrowserDevAuthSession } from '@/lib/auth/dev-auth';
import {
  continuationProfileSchema,
  desiredActionUrl,
  isAlreadyDesiredResponse,
} from '@/lib/onboarding/execute-intent';
import {
  cancelPendingIntent,
  claimPendingIntent,
} from '@/lib/onboarding/pending-intent';
import { type User, useAuthStore } from '@/stores/authStore';

export function PendingIntentContinuation() {
  const { authenticated, getAccessToken, user } = useAuth();
  const { session } = useStewardAuthContext();
  const { isOpen } = useLoginModal();
  const router = useRouter();
  const { intent, phase, sessionId, begin, setPhase, clear } =
    usePendingIntent();
  const identity = authenticated
    ? (session?.userId ??
      session?.address ??
      getBrowserDevAuthSession()?.userId ??
      null)
    : null;
  const waitingProfile = useRef<User | null>(null);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;

  useEffect(() => {
    if (!intent) return;
    const timer = window.setTimeout(
      clear,
      Math.max(0, intent.expiresAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [intent, clear]);

  useEffect(() => {
    const cancel = () => {
      cancelPendingIntent();
      clear();
    };
    window.addEventListener('popstate', cancel);
    return () => window.removeEventListener('popstate', cancel);
  }, [clear]);

  useEffect(() => {
    if (sessionId && identity !== sessionId) clear();
    const completed = usePendingIntent.getState().completed;
    if (completed && identity !== completed.sessionId)
      usePendingIntent.getState().clearCompleted();
    if (!identity || isOpen || phase !== 'idle') return;
    const pending = claimPendingIntent();
    if (pending) begin(pending, identity);
  }, [identity, isOpen, phase, sessionId, clear, begin]);

  useEffect(() => {
    if (
      !intent ||
      !identity ||
      identity !== sessionId ||
      (phase !== 'checking' && phase !== 'profile')
    )
      return;
    if (phase === 'profile' && user === waitingProfile.current) return;
    // A synchronous shared-state transition precedes token resolution or any network work.
    if (usePendingIntent.getState().phase === 'running') return;
    setPhase('running');
    const activeId = intent.id;
    const stillCurrent = () =>
      currentIdentity.current === sessionId &&
      usePendingIntent.getState().intent?.id === activeId &&
      Date.now() < intent.expiresAt;
    const run = async () => {
      const token = await getAccessToken();
      if (!token || !stillCurrent()) {
        if (usePendingIntent.getState().intent?.id === activeId) clear();
        return;
      }
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch('/api/users/me', {
        headers,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!stillCurrent()) return;
      if (!response.ok) {
        clear();
        toast.error(
          'Sign-in could not be verified. Please try the action again.'
        );
        return;
      }
      const profile = continuationProfileSchema.safeParse(
        await response.json()
      );
      if (!stillCurrent()) return;
      if (!profile.success || profile.data.needsOnboarding) {
        waitingProfile.current = user;
        useAuthStore.getState().setNeedsOnboarding(true);
        setPhase('profile');
        toast.info(
          'Complete your required profile and Terms before continuing.'
        );
        router.push('/profile');
        return;
      }
      if (intent.ownerId && intent.ownerId !== profile.data.user.id) {
        clear();
        toast.error('Your account changed. Please choose the action again.');
        return;
      }
      const action = intent.action;
      if (action.kind === 'navigate') {
        clear();
        router.push(action.href);
        return;
      }
      const url = desiredActionUrl(action);
      if (!url) {
        if (action.kind === 'reply' || action.kind === 'repost')
          router.push(`/post/${encodeURIComponent(action.postId)}`);
        if (action.kind === 'perp')
          router.push(
            `/markets?filter=perp&marketKind=perp&marketId=${encodeURIComponent(action.ticker)}`
          );
        if (action.kind === 'prediction')
          router.push(
            `/markets?filter=prediction&marketKind=prediction&marketId=${encodeURIComponent(action.marketId)}`
          );
        usePendingIntent.getState().review(profile.data.user.id);
        return;
      }
      const result = await fetch(url, {
        method: 'POST',
        headers,
        credentials: 'omit',
      });
      if (!stillCurrent()) return;
      const body: object = await result.json();
      if (!stillCurrent()) return;
      clear();
      if (
        result.ok ||
        (result.status === 400 && isAlreadyDesiredResponse(action, body))
      ) {
        const counts = z
          .object({ data: z.object({ likeCount: z.number().nonnegative() }) })
          .safeParse(body);
        usePendingIntent.getState().complete({
          action,
          accountId: profile.data.user.id,
          sessionId: identity,
          likeCount: counts.success ? counts.data.data.likeCount : null,
        });
        toast.success(action.kind === 'like' ? 'Liked' : 'Following');
        router.refresh();
      } else
        toast.error(
          'The action could not be completed. Check its status before trying again.'
        );
    };
    void run().catch((error: Error) => {
      if (!stillCurrent()) return;
      clear();
      // A failed response can follow a committed write. Never retry it automatically.
      if (error instanceof TypeError || error instanceof SyntaxError)
        toast.error(
          'Connection interrupted. Check the action before trying again.'
        );
      else throw error;
    });
  }, [
    intent,
    identity,
    sessionId,
    phase,
    user,
    getAccessToken,
    router,
    setPhase,
    clear,
  ]);

  return null;
}
