'use client';

import type { OnboardingProfilePayload } from '@feed/shared';
import { logger, POINTS } from '@feed/shared';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImportedProfileData } from '@/components/onboarding/UserOnboardingFlow';
import { UserSignupOnboardingContextProvider } from '@/components/onboarding/user-signup-onboarding-context';
import { useAuth } from '@/hooks/useAuth';
import { useSignupTracking } from '@/hooks/usePostHog';
import { safeReturnTo } from '@/lib/auth/safe-return-to';
import {
  hasCompletedGameGuide,
  markGameGuideCompletedLocal,
} from '@/lib/game-guide-completion';
import { useAuthStore } from '@/stores/authStore';
import { apiFetch } from '@/utils/api-fetch';
import { clearReferralCode, getReferralCode } from './ReferralCaptureProvider';

function getSafeReturnTo(): string {
  if (typeof window === 'undefined') return '/feed';
  return safeReturnTo(
    new URLSearchParams(window.location.search).get('returnTo'),
    '/feed'
  );
}

/**
 * Unified first-run flow: profile signup + game guide on `/onboarding` (full page).
 * Optional `?replayGuide=1` re-opens the tour from the user menu.
 */
export function OnboardingProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const {
    authenticated,
    user,
    needsOnboarding,
    loadingProfile,
    profileFetchStatus,
    logout,
  } = useAuth();

  const { setUser, setNeedsOnboarding } = useAuthStore();
  const { trackSignupStarted, trackSignupCompleted, trackOnboardingStep } =
    useSignupTracking();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [guideSubmitting, setGuideSubmitting] = useState(false);
  const guideCompleteInFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [importedProfileData, setImportedProfileData] =
    useState<ImportedProfileData | null>(null);

  const [isReadyToShow, setIsReadyToShow] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const [replayGuide, setReplayGuide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setReplayGuide(
      pathname === '/onboarding' &&
        new URLSearchParams(window.location.search).get('replayGuide') === '1'
    );
  }, [pathname]);

  const guideDone = useMemo(
    () => hasCompletedGameGuide(user?.id, user?.gameGuideCompletedAt),
    [user?.id, user?.gameGuideCompletedAt]
  );

  useEffect(() => {
    if (!authenticated || loadingProfile) {
      setIsReadyToShow(false);
      setHasInitialized(false);
      return;
    }

    if (hasInitialized) {
      setIsReadyToShow(true);
      return;
    }

    // Shorter delay in dev avoids a sluggish redirect while Turbopack compiles.
    const delay = process.env.NODE_ENV === 'development' ? 0 : 1000;
    const timer = setTimeout(() => {
      setIsReadyToShow(true);
      setHasInitialized(true);
    }, delay);

    return () => clearTimeout(timer);
  }, [authenticated, loadingProfile, hasInitialized]);

  useEffect(() => {
    if (
      needsOnboarding &&
      authenticated &&
      !loadingProfile &&
      profileFetchStatus === 'done'
    ) {
      setIsReadyToShow(true);
      setHasInitialized(true);
    }
  }, [needsOnboarding, authenticated, loadingProfile, profileFetchStatus]);

  const shouldShowOnboarding = useMemo(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const isDevMode = params.get('dev') === 'true';
      const isProduction = window.location.hostname === 'feed.fun';
      const isHomePage = window.location.pathname === '/';
      const isWaitlistFlow = params.get('waitlist') === 'true';

      if (isProduction && isHomePage && !isDevMode && !isWaitlistFlow) {
        return false;
      }
    }

    if (!isReadyToShow) {
      return false;
    }

    if (!authenticated || loadingProfile) {
      return false;
    }

    if (profileFetchStatus !== 'done') {
      return false;
    }

    if (user?.isActor) {
      return false;
    }

    if (replayGuide) {
      return true;
    }

    if (needsOnboarding) {
      return true;
    }

    const approvalReturn = getSafeReturnTo().startsWith('/connect?request=');
    if (
      pathname === '/connect' ||
      (pathname === '/onboarding' && approvalReturn)
    ) {
      return false;
    }

    if (!guideDone) {
      return true;
    }

    return false;
  }, [
    isReadyToShow,
    authenticated,
    loadingProfile,
    profileFetchStatus,
    user,
    replayGuide,
    needsOnboarding,
    guideDone,
    pathname,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!shouldShowOnboarding) return;
    if (pathname === '/onboarding' || pathname.startsWith('/onboarding/')) {
      return;
    }

    const currentParams = new URLSearchParams(window.location.search);
    const next = new URLSearchParams();
    const returnPath = `${pathname}${window.location.search}`;
    if (returnPath && returnPath !== '/onboarding') {
      next.set('returnTo', returnPath);
    }
    if (currentParams.get('waitlist') === 'true') {
      next.set('waitlist', 'true');
    }
    if (currentParams.get('dev') === 'true') {
      next.set('dev', 'true');
    }
    const q = next.toString();
    router.replace(`/onboarding${q ? `?${q}` : ''}`);
  }, [shouldShowOnboarding, pathname, router]);

  const phase = useMemo<'profile' | 'guide'>(() => {
    if (replayGuide) return 'guide';
    if (needsOnboarding) return 'profile';
    return 'guide';
  }, [replayGuide, needsOnboarding]);

  const handleProfileSubmit = useCallback(
    async (payload: OnboardingProfilePayload) => {
      setIsSubmitting(true);
      setError(null);
      trackSignupStarted();

      const referralCode = getReferralCode();

      try {
        const response = await apiFetch('/api/users/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            referralCode: referralCode ?? undefined,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          const message =
            data?.error ||
            `Failed to complete signup (status ${response.status})`;
          setIsSubmitting(false);
          throw new Error(message);
        }

        if (data.user) {
          const u = data.user as {
            id: string;
            walletAddress?: string;
            displayName?: string;
            username?: string;
            bio?: string;
            profileImageUrl?: string;
            coverImageUrl?: string;
            profileComplete?: boolean;
            reputationPoints?: number;
            hasTwitter?: boolean;
            twitterUsername?: string;
            nftTokenId?: number;
            createdAt?: string;
            gameGuideCompletedAt?: string | null;
          };
          setUser({
            id: u.id,
            displayName:
              u.displayName ?? payload.displayName ?? payload.username,
            email: user?.email,
            username: u.username ?? payload.username,
            bio: u.bio ?? payload.bio,
            profileImageUrl:
              u.profileImageUrl ?? payload.profileImageUrl ?? undefined,
            coverImageUrl:
              u.coverImageUrl ?? payload.coverImageUrl ?? undefined,
            profileComplete: u.profileComplete ?? true,
            reputationPoints: u.reputationPoints ?? user?.reputationPoints,
            hasTwitter: u.hasTwitter ?? user?.hasTwitter,
            twitterUsername: u.twitterUsername ?? user?.twitterUsername,
            createdAt: u.createdAt ?? user?.createdAt,
            gameGuideCompletedAt: u.gameGuideCompletedAt ?? null,
          });
        }
        setNeedsOnboarding(false);

        clearReferralCode();
        trackOnboardingStep('profile', true);
        trackSignupCompleted(data.user?.id ?? '', {
          hasReferrer: Boolean(referralCode),
          hasTwitter: data.user?.hasTwitter ?? false,
        });
        setIsSubmitting(false);
      } catch (err) {
        setIsSubmitting(false);
        throw err;
      }
    },
    [
      user,
      setUser,
      setNeedsOnboarding,
      trackSignupStarted,
      trackSignupCompleted,
      trackOnboardingStep,
    ]
  );

  // Imported social data and errors belong to one account: reset on logout
  // and on account switch. Social sign-ups are never auto-submitted — the
  // imported profile only pre-fills the form, and the user must accept the
  // Terms and Privacy Policy explicitly.
  const onboardingOwnerId = authenticated ? (user?.id ?? null) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the owning account changes
  useEffect(() => {
    setError(null);
    setImportedProfileData(null);
  }, [onboardingOwnerId]);

  // Phase 2: Auto-import social profile from Feed user record
  // by the Twitter auth routes before this effect runs.
  useEffect(() => {
    if (!authenticated || !needsOnboarding || !user) return;
    if (importedProfileData) return;
    if (loadingProfile) return;

    if (user.hasTwitter && user.twitterUsername) {
      const profileData: ImportedProfileData = {
        platform: 'twitter',
        username: user.twitterUsername,
        displayName: user.displayName || user.twitterUsername,
        bio: undefined,
        profileImageUrl: user.profileImageUrl || null,
        twitterId: undefined,
      };

      logger.info(
        'Auto-imported Twitter profile from Feed user record',
        { username: profileData.username, expectedPoints: POINTS.TWITTER_LINK },
        'OnboardingProvider'
      );

      setImportedProfileData(profileData);
    }
  }, [
    authenticated,
    user,
    needsOnboarding,
    importedProfileData,
    loadingProfile,
  ]);

  const handleGuideComplete = useCallback(
    async (options?: { nextHref?: string }) => {
      if (guideCompleteInFlight.current) return;
      const uid = user?.id;
      const dest = options?.nextHref ?? getSafeReturnTo();

      if (!uid) {
        router.replace(dest);
        return;
      }

      guideCompleteInFlight.current = true;
      setGuideSubmitting(true);
      markGameGuideCompletedLocal(uid);

      try {
        const res = await apiFetch('/api/users/me/game-guide', {
          method: 'POST',
        });
        if (res.ok) {
          const { gameGuideCompletedAt } = (await res.json()) as {
            gameGuideCompletedAt: string;
          };
          const fresh = useAuthStore.getState().user;
          if (fresh) {
            setUser({ ...fresh, gameGuideCompletedAt });
          }
          logger.info(
            'Unified onboarding: game guide marked complete',
            { userId: uid },
            'OnboardingProvider'
          );
        } else {
          logger.error(
            'Game guide API failed (localStorage backup saved)',
            { status: res.status, userId: uid },
            'OnboardingProvider'
          );
        }
      } catch (err) {
        logger.error(
          'Game guide API error',
          {
            error: err instanceof Error ? err.message : String(err),
            userId: uid,
          },
          'OnboardingProvider'
        );
      } finally {
        setGuideSubmitting(false);
        guideCompleteInFlight.current = false;
      }

      trackOnboardingStep('guide', true);
      router.replace(dest);
    },
    [user?.id, router, setUser, trackOnboardingStep]
  );

  const onLogout = useCallback(async () => {
    if (logout) {
      await logout();
    }
  }, [logout]);

  const flowContextValue = useMemo(
    () => ({
      phase,
      isReplayGuide: replayGuide,
      shouldShowOnboarding,
      isOnboardingResolved: isReadyToShow,
      isSubmitting,
      guideSubmitting,
      error,
      onSubmitProfile: handleProfileSubmit,
      onGuideComplete: handleGuideComplete,
      onLogout,
      user,
      importedData: importedProfileData,
    }),
    [
      phase,
      replayGuide,
      shouldShowOnboarding,
      isReadyToShow,
      isSubmitting,
      guideSubmitting,
      error,
      handleProfileSubmit,
      handleGuideComplete,
      onLogout,
      user,
      importedProfileData,
    ]
  );

  return (
    <UserSignupOnboardingContextProvider value={flowContextValue}>
      {children}
    </UserSignupOnboardingContextProvider>
  );
}
