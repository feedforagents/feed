// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { Fragment, useState } from "react";
import {
  Button,
  EmptyState,
  FeedMarketCard,
  PostCardSkeleton,
  PostComposer,
  Tabs,
  TabsList,
  TabsTrigger,
  type FeedMarketStatus,
  type UiMode,
} from "@repo/ui";
import { FeedPostCard } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPredictionMarket } from "../types.ts";

interface HomeScreenProps {
  readonly mode: UiMode;
}

function toFeedMarketStatus(status: string): FeedMarketStatus {
  const lower = status.toLowerCase();
  if (lower === "cancelled") return "cancelled";
  if (lower === "resolved") return "resolved";
  return "active";
}

function toFeedResolvedOutcome(raw?: "YES" | "NO" | "CANCELLED"): "yes" | "no" | null {
  if (raw === "YES") return "yes";
  if (raw === "NO") return "no";
  return null;
}

export function HomeScreen({ mode }: HomeScreenProps) {
  const s = useAppStore();
  const [composerText, setComposerText] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);

  const handlePublish = async (text: string) => {
    setComposerBusy(true);
    const result = await storeActions.createPost(text);
    setComposerBusy(false);
    if (result.kind === "published") {
      setComposerText("");
    }
  };

  const showFeedMarketCards = mode === "GameMode" && (s.feedTab === "latest" || s.feedTab === "top");
  const embeddedMarketIds = new Set<string>();
  for (const post of s.feedPosts) {
    if (post.card.marketBadge?.kind === "prediction" && post.card.marketBadge.marketId) {
      embeddedMarketIds.add(post.card.marketBadge.marketId);
    } else if (post.marketId) {
      embeddedMarketIds.add(post.marketId);
    }
  }
  const feedMarkets: ReadonlyArray<AppPredictionMarket> = showFeedMarketCards
    ? s.predictions
        .filter((m) => (m.status === "open" || m.status === "resolved") && !embeddedMarketIds.has(m.card.id))
        .slice(0, 6)
    : [];

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 bg-background/85 backdrop-blur-md md:top-0">
        <Tabs
          value={s.feedTab}
          onValueChange={(next) => {
            const tab = next === "following" || next === "top" ? next : "latest";
            void storeActions.selectFeedTab(tab);
          }}
        >
          <TabsList variant="underline" className="h-[53px]">
            <TabsTrigger value="latest">Latest</TabsTrigger>
            <TabsTrigger value="top">For You</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {s.viewer ? (
        <PostComposer
          value={composerText}
          onValueChange={setComposerText}
          onSubmit={(text) => { void handlePublish(text); }}
          authorName={s.viewer.displayName}
          authorAvatarUrl={s.viewer.avatarUrl ?? undefined}
          placeholder="What's happening?"
          submitLabel="Post"
          loading={composerBusy}
        />
      ) : null}

      {s.pendingNewPostCount > 0 ? (
        <div className="sticky top-[106px] z-10 flex justify-center border-b border-border bg-background/85 py-2 backdrop-blur-md md:top-[53px]">
          <Button
            size="sm"
            shape="pill"
            variant="ghost"
            onClick={() => { void storeActions.flushPendingNewPosts(); }}
            className="bg-feed-brand/10 px-4 font-semibold text-primary hover:bg-feed-brand/15"
          >
            Show {s.pendingNewPostCount} new {s.pendingNewPostCount === 1 ? "post" : "posts"}
          </Button>
        </div>
      ) : null}

      {s.feedLoading && s.feedPosts.length === 0 ? (
        <div className="flex flex-col">
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </div>
      ) : s.feedPosts.length === 0 ? (
        <EmptyState title="No posts in this feed yet">
          {s.viewer ? null : (
            <Button variant="outline" shape="pill" onClick={() => storeActions.openJoinSheet()}>
              Sign in to post
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {s.feedPosts.map((post, index) => {
            const marketSlot = (index + 1) % 5 === 0 ? Math.floor((index + 1) / 5) - 1 : -1;
            const interleavedMarket = marketSlot >= 0 ? feedMarkets[marketSlot] ?? null : null;
            return (
              <Fragment key={post.card.id}>
                <FeedPostCard post={post} mode={mode} />
                {interleavedMarket ? (
                  <FeedMarketCard
                    variant="standalone"
                    marketId={interleavedMarket.card.id}
                    question={interleavedMarket.card.question}
                    yesOddsPct={interleavedMarket.card.yesOddsPct}
                    closesAt={interleavedMarket.card.closesIn}
                    status={toFeedMarketStatus(interleavedMarket.status)}
                    resolvedOutcome={toFeedResolvedOutcome(interleavedMarket.card.resolvedOutcome)}
                    volumePts={interleavedMarket.volumeCents > 0 ? interleavedMarket.volumeCents / 100 : undefined}
                    yesShares={interleavedMarket.yesShares > 0 ? interleavedMarket.yesShares : undefined}
                    noShares={interleavedMarket.noShares > 0 ? interleavedMarket.noShares : undefined}
                    category={interleavedMarket.category}
                    onOpen={(marketId) => {
                      void storeActions.navigate(`/markets/predictions/${encodeURIComponent(marketId)}`);
                    }}
                    onQuickTrade={(marketId, side) => storeActions.openPredictionQuickTrade(marketId, side)}
                  />
                ) : null}
              </Fragment>
            );
          })}
          {s.feedNextCursor ? (
            <div className="flex justify-center border-b border-border p-4">
              <Button
                variant="outline"
                size="sm"
                loading={s.feedLoadingMore}
                onClick={() => { void storeActions.loadMoreFeed(); }}
              >
                Load more
              </Button>
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">You&apos;re all caught up.</p>
          )}
        </div>
      )}
    </div>
  );
}
