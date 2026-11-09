'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { PageContainer } from '@/components/shared/PageContainer';
import { FeedLayoutSkeleton } from '@/components/shared/Skeleton';

export function getHomeFeedUrl(searchParams: Pick<URLSearchParams, 'get'>) {
  const ref = searchParams.get('ref');
  const next = new URLSearchParams();
  if (ref) next.set('ref', ref);
  const preview = searchParams.get('onboardingPreview');
  if (
    (process.env.NODE_ENV !== 'production' ||
      process.env.NEXT_PUBLIC_DEPLOYMENT_ENV === 'staging') &&
    (preview === 'signin' || preview === 'agent')
  )
    next.set('onboardingPreview', preview);
  return `/feed${next.size ? `?${next.toString().replace(/\+/g, '%20')}` : ''}`;
}

function HomePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    // replace (not push) so Back does not loop through this redirect.
    router.replace(getHomeFeedUrl(searchParams));
  }, [router, searchParams]);

  // Show feed skeleton while redirecting
  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <FeedLayoutSkeleton />
    </PageContainer>
  );
}

export function HomePageClient() {
  return (
    <Suspense
      fallback={
        <PageContainer noPadding className="flex w-full flex-col">
          <FeedLayoutSkeleton />
        </PageContainer>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
