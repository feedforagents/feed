'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import { useStewardAuthContext } from '@/components/providers/StewardAuthProvider';
import { useAuth } from '@/hooks/useAuth';
import { useLoginModal } from '@/hooks/useLoginModal';
import {
  AGENT_INTRO_SEEN_KEY,
  agentEntryView,
} from '@/lib/onboarding/agent-entry';
import { isPrivateAnalyticsPath } from '@/lib/posthog/privacy';
import { readStorageItem, writeStorageItem } from '@/utils/browser-storage';
import { LoginModal } from './LoginModal';

/**
 * Global login modal content component.
 *
 * Connects to the global login modal state and displays LoginModal when needed.
 * Keeps the prompt/sign-in dialog consistent across route transitions.
 * Uses Zustand store for global state management.
 *
 * @returns Global login modal element or null if hidden/not open
 */
function GlobalLoginModalContent() {
  const {
    isOpen,
    queuedModal,
    showLoginModal,
    consumeQueuedLoginModal,
    closeLoginModal,
    title,
    message,
  } = useLoginModal();
  const pathname = usePathname();
  const { authenticated } = useAuth();
  const { isLoading: checkingSession } = useStewardAuthContext();
  const introduced = useRef(false);
  const searchParams = useSearchParams();

  const initialView = agentEntryView(
    searchParams.get('onboardingPreview'),
    process.env.NODE_ENV !== 'production' ||
      process.env.NEXT_PUBLIC_DEPLOYMENT_ENV === 'staging'
  );

  useEffect(() => {
    if (!queuedModal || pathname === '/') {
      return;
    }

    showLoginModal(queuedModal);
    consumeQueuedLoginModal();
  }, [pathname, queuedModal, showLoginModal, consumeQueuedLoginModal]);

  useEffect(() => {
    if (
      pathname !== '/feed' ||
      checkingSession ||
      authenticated ||
      queuedModal ||
      isOpen ||
      introduced.current
    )
      return;
    if (readStorageItem('localStorage', AGENT_INTRO_SEEN_KEY)) return;
    introduced.current = true;
    writeStorageItem('localStorage', AGENT_INTRO_SEEN_KEY, '1');
    showLoginModal({
      title: 'Welcome to Feed',
      message: 'Sign in to play Feed from your account.',
    });
  }, [
    pathname,
    checkingSession,
    authenticated,
    queuedModal,
    isOpen,
    showLoginModal,
  ]);

  const pageOwnsAuthentication = isPrivateAnalyticsPath(pathname);
  useEffect(() => {
    if (pageOwnsAuthentication && (isOpen || queuedModal)) closeLoginModal();
  }, [pageOwnsAuthentication, isOpen, queuedModal, closeLoginModal]);

  if (pageOwnsAuthentication) return null;

  return (
    <LoginModal
      initialView={initialView}
      isOpen={isOpen}
      onClose={closeLoginModal}
      title={title}
      message={message}
    />
  );
}

/**
 * Global login modal component wrapper with Suspense boundary.
 *
 * Wraps GlobalLoginModalContent in a Suspense boundary to handle async navigation
 * hooks gracefully. Provides a global login modal accessible throughout the app.
 *
 * @returns Global login modal element wrapped in Suspense
 */
export function GlobalLoginModal() {
  return (
    <Suspense fallback={null}>
      <GlobalLoginModalContent />
    </Suspense>
  );
}
