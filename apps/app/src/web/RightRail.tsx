// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"
import { useState, type FormEvent } from "react";
import { Avatar, Button, Input, VerifiedBadge, WidgetPanelSkeleton, type TrendingItem, type UiMode } from "@repo/ui";
import { SearchIcon } from "./icons.tsx";
import { storeActions, useAppStore } from "./store.ts";
import type { AppWorldStatus } from "./types.ts";

interface SuggestedAccount {
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly isNpc: boolean;
  readonly isFollowing: boolean;
}

function TrendSubtitle({ text }: { readonly text: string }) {
  return <span className="block truncate text-xs text-muted-foreground">{text.replace(/\b1 posts\b/giu, "1 post")}</span>;
}

function RightRailWorldClock({ status }: { readonly status: AppWorldStatus }) {
  return (
    <section
      aria-label="World clock"
      className="flex items-center justify-between gap-2 border-b border-border bg-background pb-3 font-mono text-xs tabular-nums"
    >
      <span className="flex items-center gap-2 text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${status.gameRunning ? "bg-ok" : "bg-muted-foreground"}`}
        />
        <span className="font-semibold text-foreground">Day {status.currentDay}</span>
        <span aria-hidden="true">·</span>
        <span>Hour {status.currentHour}</span>
        <span aria-hidden="true">·</span>
        <span className="capitalize">{status.phase}</span>
      </span>
      <span className="text-muted-foreground">{status.activeMarketsCount} mkts</span>
    </section>
  );
}

function RightRailTrendingSection({
  loading,
  items,
  isGame,
}: {
  readonly loading: boolean;
  readonly items: ReadonlyArray<TrendingItem>;
  readonly isGame: boolean;
}) {
  if (loading && items.length === 0) {
    return <WidgetPanelSkeleton />;
  }
  return (
    <section aria-label="Trending" className="flex flex-col gap-2 border-b border-border bg-background pb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-foreground">Trending</h2>
        <button
          type="button"
          onClick={() => { void storeActions.navigate("/explore"); }}
          className="text-xs font-medium text-primary hover:underline"
        >
          Show more
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No trending topics right now.</p>
      ) : (
        <div className="flex flex-col">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.financial && isGame) {
                  const ticker = item.title.replace(/^\$/, "");
                  void storeActions.navigate(`/markets/perps/${encodeURIComponent(ticker)}`);
                  return;
                }
                void storeActions.navigate(`/trending/${encodeURIComponent(item.title.replace(/^#/, ""))}`);
              }}
              className="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-muted/40"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-foreground">{item.title}</span>
                {item.subtitle ? <TrendSubtitle text={item.subtitle} /> : null}
              </span>
              {item.metric && isGame ? (
                <span className="shrink-0 font-mono text-xs font-semibold text-primary tabular-nums">{item.metric}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function RightRail({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [searchDraft, setSearchDraft] = useState("");
  const isGame = mode === "GameMode";

  const sourceTrending = s.rightRailTrending.length > 0 ? s.rightRailTrending : s.explore.trending;
  const sourceArticles = s.rightRailArticles.length > 0 ? s.rightRailArticles : s.explore.articles;
  const visibleTrending = sourceTrending.filter((item) => isGame || !item.financial).slice(0, 5);
  const latestNews = sourceArticles.slice(0, 5);
  const activePerps = isGame ? s.perps.slice(0, 3) : [];
  const activePredictions = isGame ? s.predictions.filter((p) => p.status === "open").slice(0, 3) : [];

  const suggestedMap = new Map<string, SuggestedAccount>();
  const viewerHandle = s.viewer?.handle.toLowerCase() ?? "";
  for (const post of s.feedPosts) {
    const key = post.card.authorHandle.toLowerCase();
    if (!key || key === viewerHandle || post.card.isFollowingAuthor || suggestedMap.has(key)) continue;
    suggestedMap.set(key, {
      handle: post.card.authorHandle,
      displayName: post.card.authorDisplayName,
      avatarUrl: post.card.authorAvatarUrl,
      isNpc: post.card.isNpcParody,
      isFollowing: Boolean(post.card.isFollowingAuthor),
    });
    if (suggestedMap.size >= 4) break;
  }
  if (suggestedMap.size < 4) {
    for (const actor of s.explore.actors) {
      const key = actor.username.toLowerCase();
      if (!key || key === viewerHandle || actor.viewerFollows || suggestedMap.has(key)) continue;
      suggestedMap.set(key, {
        handle: actor.username,
        displayName: actor.name,
        avatarUrl: actor.avatarUrl ?? undefined,
        isNpc: actor.isParody,
        isFollowing: actor.viewerFollows,
      });
      if (suggestedMap.size >= 4) break;
    }
  }
  const suggestions = [...suggestedMap.values()];

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = searchDraft.trim();
    if (!trimmed) {
      void storeActions.navigate("/explore");
      return;
    }
    void storeActions.navigate(`/explore?q=${encodeURIComponent(trimmed)}`);
  };

  const hideSearchBar = s.route === "Explore" && !s.activeArticleId;

  return (
    <div className="flex flex-col gap-4 pb-6">
      {!hideSearchBar ? (
        <form onSubmit={handleSearchSubmit} className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search Feed"
            placeholder={isGame ? "Search Feed, @handles, $tickers" : "Search Feed"}
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            className="h-10 rounded-full border-transparent bg-muted pr-4 pl-10 focus-visible:border-feed-brand focus-visible:bg-background"
          />
        </form>
      ) : null}

      {isGame && s.worldStatus ? <RightRailWorldClock status={s.worldStatus} /> : null}

      {latestNews.length > 0 ? (
        <section aria-label="Latest news" className="flex flex-col gap-2 border-b border-border bg-background pb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">Latest News</h2>
            <button
              type="button"
              onClick={storeActions.openExploreNews}
              className="text-xs font-medium text-primary hover:underline"
            >
              See all
            </button>
          </div>
          <div className="flex flex-col">
            {latestNews.map((article) => (
              <button
                key={article.id}
                type="button"
                onClick={() => { void storeActions.navigate(`/article/${encodeURIComponent(article.id)}`); }}
                className="-mx-2 flex flex-col gap-1 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-muted/40"
              >
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate font-medium text-foreground/80">{article.source}</span>
                  <span>·</span>
                  <span className="shrink-0">{article.timestamp}</span>
                </div>
                <p className="line-clamp-2 text-sm leading-snug font-semibold text-foreground">{article.title}</p>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <RightRailTrendingSection loading={s.trendingLoading} items={visibleTrending} isGame={isGame} />

      {isGame && (activePredictions.length > 0 || activePerps.length > 0) ? (
        <section aria-label="Active markets" className="flex flex-col gap-2 border-b border-border bg-background pb-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-foreground">Active Markets</h2>
            <button
              type="button"
              onClick={() => { void storeActions.navigate("/markets"); }}
              className="text-xs font-medium text-primary hover:underline"
            >
              Trade
            </button>
          </div>
          <div className="flex flex-col">
            {activePerps.map((perp) => {
              const positive = perp.change24hPct >= 0;
              return (
                <button
                  key={perp.ticker}
                  type="button"
                  onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(perp.ticker)}`); }}
                  className="-mx-2 flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-muted/40"
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-sm font-bold text-foreground">${perp.ticker}</span>
                    <span className="block truncate text-xs text-muted-foreground">{perp.card.name}</span>
                  </span>
                  <span className="shrink-0 text-right font-mono text-xs tabular-nums">
                    <span className="block font-semibold text-foreground">{perp.card.markPricePts}</span>
                    <span className={positive ? "text-ok" : "text-destructive"}>
                      {positive ? "+" : ""}{perp.change24hPct.toFixed(1)}%
                    </span>
                  </span>
                </button>
              );
            })}
            {activePredictions.map((pred) => (
              <button
                key={pred.card.id}
                type="button"
                onClick={() => { void storeActions.navigate(`/markets/predictions/${encodeURIComponent(pred.card.id)}`); }}
                className="-mx-2 flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-fast hover:bg-muted/40"
              >
                <span className="line-clamp-2 min-w-0 text-xs font-semibold text-foreground">{pred.card.question}</span>
                <span className="shrink-0 font-mono text-xs font-bold text-primary tabular-nums">
                  {pred.card.yesOddsPct}% YES
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {suggestions.length > 0 ? (
        <section aria-label="Who to follow" className="flex flex-col gap-2 border-b border-border bg-background pb-4">
          <h2 className="text-base font-bold text-foreground">Who to follow</h2>
          <div className="flex flex-col">
            {suggestions.map((person) => (
              <div key={person.handle} className="-mx-2 flex items-center justify-between gap-2.5 rounded-lg px-2 py-2">
                <button
                  type="button"
                  onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(person.handle)}`); }}
                  className="flex min-w-0 items-center gap-2.5 text-left"
                >
                  <Avatar name={person.displayName} src={person.avatarUrl} seed={person.handle} size="sm" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-sm font-bold text-foreground hover:underline">
                      <span className="truncate">{person.displayName}</span>
                      {person.isNpc ? <VerifiedBadge size="sm" /> : null}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">@{person.handle}</span>
                  </span>
                </button>
                <Button
                  size="sm"
                  shape="pill"
                  variant={person.isFollowing ? "outline" : "primary"}
                  onClick={() => { void storeActions.toggleFollow(person.handle, person.isFollowing); }}
                  className="shrink-0 px-3.5 text-xs font-bold"
                >
                  {person.isFollowing ? "Following" : "Follow"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => { void storeActions.navigate("/how-to-play"); }}
          className="hover:underline"
        >
          How to Play
        </button>
        <span aria-hidden>·</span>
        <a
          href="https://docs.feed.fun/legal/terms-of-service/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          Terms
        </a>
        <span aria-hidden>·</span>
        <a
          href="https://docs.feed.fun/legal/privacy-policy/"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline"
        >
          Privacy
        </a>
      </footer>
    </div>
  );
}
