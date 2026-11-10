'use client';

import { usePathname } from 'next/navigation';
/**
 * PostHog provider component for initializing PostHog analytics.
 *
 * Initializes PostHog analytics client and automatically tracks page views
 * as users navigate. Provides PostHog context to child components.
 *
 * Features:
 * - PostHog initialization
 * - Page view tracking
 * - Authentication-route privacy and URL redaction
 * - Automatic navigation tracking
 *
 * @param props - PostHogProvider component props
 * @returns PostHog provider element
 */
import { useEffect, useRef } from 'react';
import { useLoginModal } from '@/hooks/useLoginModal';
import { initPostHog, posthog } from '@/lib/posthog';
import { isPrivateAnalyticsPath } from '@/lib/posthog/privacy';

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const loginOpen = useLoginModal((state) => state.isOpen);
  const initialized = useRef(false);

  // Initialize PostHog once
  useEffect(() => {
    if (!initialized.current) {
      initPostHog();
      initialized.current = true;
    }
  }, []);

  useEffect(() => {
    const privatePage =
      !pathname || isPrivateAnalyticsPath(pathname) || loginOpen;
    posthog.set_config({ disable_session_recording: privatePage });
    if (privatePage) {
      posthog.stopSessionRecording();
      return;
    }
    posthog.capture('$pageview', {
      $current_url: window.origin + pathname,
      $pathname: pathname,
    });
  }, [pathname, loginOpen]);

  return <>{children}</>;
}
