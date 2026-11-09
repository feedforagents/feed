'use client';

export const dynamic = 'force-dynamic';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { UserOnboardingFlow } from '@/components/onboarding/UserOnboardingFlow';
import { useUserSignupOnboarding } from '@/components/onboarding/user-signup-onboarding-context';
import { PageContainer } from '@/components/shared/PageContainer';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useLoginModal } from '@/hooks/useLoginModal';
import { safeReturnTo } from '@/lib/auth/safe-return-to';

export default function OnboardingPage() {
  const router = useRouter();
  const flow = useUserSignupOnboarding();
  const { ready, authenticated, loadingProfile, profileFetchStatus, refresh } =
    useAuth();
  const queueLoginModal = useLoginModal((state) => state.queueLoginModal);

  useEffect(() => {
    if (!ready || authenticated) return;
    queueLoginModal();
    router.replace('/feed');
  }, [ready, authenticated, router, queueLoginModal]);

  useEffect(() => {
    if (!ready || !authenticated || loadingProfile) return;
    if (profileFetchStatus !== 'done') return;
    if (!flow) return;
    // Wait for the provider to finish initialising — avoids a one-tick race where
    // loadingProfile is already false but isReadyToShow hasn't been set yet.
    if (!flow.isOnboardingResolved) return;
    if (flow.shouldShowOnboarding) return;
    router.replace(
      safeReturnTo(
        new URLSearchParams(window.location.search).get('returnTo'),
        '/feed'
      )
    );
  }, [ready, authenticated, loadingProfile, profileFetchStatus, flow, router]);

  if (!ready || !authenticated) {
    return null;
  }

  if (!loadingProfile && profileFetchStatus === 'error') {
    return (
      <PageContainer noPadding>
        <div
          className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center"
          role="alert"
        >
          <p className="font-semibold text-foreground">
            We couldn't load your profile.
          </p>
          <p className="text-muted-foreground text-sm">
            Check your connection and try again.
          </p>
          <Button type="button" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      </PageContainer>
    );
  }

  // Show loading shell while profile is still resolving.
  // Once flow is ready and shouldShowOnboarding is true, skip straight to the flow.
  const stillResolving = loadingProfile || profileFetchStatus !== 'done';

  if (stillResolving) {
    return (
      <PageContainer noPadding>
        <div
          className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6"
          aria-busy="true"
          aria-live="polite"
        >
          <Loader2
            className="h-8 w-8 animate-spin text-muted-foreground"
            aria-hidden
          />
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      </PageContainer>
    );
  }

  if (!flow?.shouldShowOnboarding) {
    return null;
  }

  return (
    <PageContainer noPadding>
      <UserOnboardingFlow
        phase={flow.phase}
        isReplayGuide={flow.isReplayGuide}
        isSubmitting={flow.isSubmitting}
        guideSubmitting={flow.guideSubmitting}
        error={flow.error}
        onSubmitProfile={flow.onSubmitProfile}
        onGuideComplete={flow.onGuideComplete}
        onLogout={flow.onLogout}
        user={flow.user}
        importedData={flow.importedData}
      />
    </PageContainer>
  );
}
