'use client';

export const dynamic = 'force-dynamic';

import nextDynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LoginButton } from '@/components/auth/LoginButton';
import { PageContainer } from '@/components/shared/PageContainer';
import { BalanceTab } from '@/components/wallet/v2/balance-tab';
import { PnLTab } from '@/components/wallet/v2/pnl-tab';
import { PositionsTab } from '@/components/wallet/v2/positions-tab';
import { useAuth } from '@/hooks/useAuth';
import { useLoginModal } from '@/hooks/useLoginModal';
import { useUserPositionsPolling } from '@/stores/userPositionsStore';
import { useWalletBalancePolling } from '@/stores/walletBalanceStore';

const BuyPointsModal = nextDynamic(
  () =>
    import('@/components/points/BuyPointsModal').then((m) => ({
      default: m.BuyPointsModal,
    })),
  { ssr: false }
);

export default function WalletPage() {
  const router = useRouter();
  const { ready, authenticated, user } = useAuth();
  const queueLoginModal = useLoginModal((state) => state.queueLoginModal);
  const [showBuyPoints, setShowBuyPoints] = useState(false);

  const userId = authenticated ? user?.id : undefined;

  // Start polling for wallet data when authenticated
  useWalletBalancePolling(userId ?? null, 15_000);
  useUserPositionsPolling(userId ?? null);

  // Redirect unauthenticated users
  useEffect(() => {
    if (!ready || authenticated) return;
    queueLoginModal();
    router.replace('/feed');
  }, [ready, authenticated, router, queueLoginModal]);

  if (!ready) {
    return <WalletPageSkeleton />;
  }

  if (!authenticated || !userId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex flex-col items-center justify-center gap-4 text-center">
          <p className="text-muted-foreground text-sm">
            Log in to view your portfolio
          </p>
          <LoginButton />
        </div>
      </div>
    );
  }

  return (
    <PageContainer noPadding className="flex w-full flex-col pt-14 md:pt-0">
      <div className="relative flex flex-1 flex-col xl:flex-row">
        {/* Main wallet content */}
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l xl:border-r-0">
          <div className="space-y-6 p-4 md:space-y-8 md:p-6">
            {/* Balance section */}
            <BalanceTab
              userId={userId}
              onBuyPoints={() => setShowBuyPoints(true)}
            />

            {/* P&L section */}
            <PnLTab userId={userId} />
          </div>
        </div>

        {/* Positions: stacked below on small screens, right sidebar on xl */}
        <section
          aria-label="Positions"
          className="flex w-full flex-col border-border border-t p-4 pb-[calc(1rem+var(--bottom-nav-height))] md:p-6 md:pb-6 lg:border-r lg:border-l xl:w-96 xl:flex-none xl:border-t-0 xl:border-r-0 xl:p-0"
        >
          <div className="xl:sticky xl:top-0 xl:p-4">
            <PositionsTab userId={userId} />
          </div>
        </section>
      </div>

      {showBuyPoints && (
        <BuyPointsModal
          isOpen={showBuyPoints}
          onClose={() => setShowBuyPoints(false)}
        />
      )}
    </PageContainer>
  );
}

function WalletPageSkeleton() {
  return (
    <PageContainer noPadding className="flex w-full flex-col pt-14 md:pt-0">
      <div className="relative flex flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          <div className="space-y-6 p-6">
            <div className="h-24 animate-pulse rounded-xl bg-muted" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
              <div className="h-16 animate-pulse rounded-xl bg-muted" />
            </div>
            <div className="h-40 animate-pulse rounded-xl bg-muted" />
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded bg-muted" />
              ))}
            </div>
          </div>
        </div>
        <div className="hidden w-96 flex-none xl:block" />
      </div>
    </PageContainer>
  );
}
