// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/navigation.md, "Story: Switch between Game mode and Social mode"
import { useState, type FormEvent } from "react";
import { Avatar, Button, Input, VerifiedBadge, type UiMode } from "@repo/ui";
import { SearchIcon } from "./icons.tsx";
import { storeActions, useAppStore } from "./store.ts";

interface SuggestedAccount {
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly isNpc: boolean;
  readonly isFollowing: boolean;
}

export function RightRail({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [searchDraft, setSearchDraft] = useState("");
  const isGame = mode === "GameMode";

  const visibleTrending = s.explore.trending.filter((item) => isGame || !item.financial).slice(0, 5);
  const latestNews = s.explore.articles.slice(0, 5);
  const activePerps = isGame ? s.perps.slice(0, 3) : [];
  const activePredictions = isGame ? s.predictions.filter((p) => p.status === "open").slice(0, 3) : [];

  const suggestedMap = new Map<string, SuggestedAccount>();
  const viewerHandle = s.viewer?.handle.toLowerCase() ?? "";
  for (const post of s.feedPosts) {
    const key = post.card.authorHandle.toLowerCase();
    if (!key || key === viewerHandle || suggestedMap.has(key)) continue;
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
      if (!key || key === viewerHandle || suggestedMap.has(key)) continue;
      suggestedMap.set(key, {
        handle: actor.username,
        displayName: actor.name,
        avatarUrl: actor.avatarUrl ?? undefined,
        isNpc: actor.isParody,
        isFollowing: false,
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

  return (
    <div className="flex flex-col gap-4 pb-6">
      <form onSubmit={handleSearchSubmit} className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search Feed"
          placeholder={isGame ? "Search Feed, @handles, $tickers" : "Search Feed"}
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          className="h-10 rounded-full bg-muted/60 pr-4 pl-10"
        />
      </form>

      {latestNews.length > 0 ? (
        <section aria-label="Latest news" className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-base font-bold text-foreground">Latest News</h2>
            <button
              type="button"
              onClick={() => { void storeActions.navigate("/explore"); }}
              className="text-xs font-medium text-primary hover:underline"
            >
              See all
            </button>
          </div>
          <div className="divide-y divide-border">
            {latestNews.map((article) => (
              <button
                key={article.id}
                type="button"
                onClick={() => { void storeActions.navigate(`/article/${encodeURIComponent(article.id)}`); }}
                className="flex w-full flex-col gap-1 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent/60"
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

      <section aria-label="Trending" className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-base font-bold text-foreground">Trending</h2>
          <button
            type="button"
            onClick={() => { void storeActions.navigate("/explore"); }}
            className="text-xs font-medium text-primary hover:underline"
          >
            Show more
          </button>
        </div>
        {visibleTrending.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-muted-foreground">No trending topics right now.</p>
        ) : (
          <div className="divide-y divide-border">
            {visibleTrending.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.financial && isGame) {
                    const ticker = item.title.replace(/^\$/, "");
                    void storeActions.navigate(`/markets?ticker=${encodeURIComponent(ticker)}`);
                    return;
                  }
                  void storeActions.navigate(`/trending/${encodeURIComponent(item.title.replace(/^#/, ""))}`);
                }}
                className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent/60"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-foreground">{item.title}</span>
                  {item.subtitle ? <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span> : null}
                </span>
                {item.metric && isGame ? (
                  <span className="shrink-0 font-mono text-xs font-semibold text-primary tabular-nums">{item.metric}</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>

      {isGame && (activePredictions.length > 0 || activePerps.length > 0) ? (
        <section aria-label="Active markets" className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-base font-bold text-foreground">Active Markets</h2>
            <button
              type="button"
              onClick={() => { void storeActions.navigate("/markets"); }}
              className="text-xs font-medium text-primary hover:underline"
            >
              Trade
            </button>
          </div>
          <div className="divide-y divide-border">
            {activePerps.map((perp) => {
              const positive = perp.change24hPct >= 0;
              return (
                <button
                  key={perp.ticker}
                  type="button"
                  onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(perp.ticker)}`); }}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent/60"
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
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors duration-fast hover:bg-accent/60"
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
        <section aria-label="Who to follow" className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="px-4 py-3">
            <h2 className="text-base font-bold text-foreground">Who to follow</h2>
          </div>
          <div className="divide-y divide-border">
            {suggestions.map((person) => (
              <div key={person.handle} className="flex items-center justify-between gap-2.5 px-4 py-2.5">
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

      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 text-xs text-muted-foreground">
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
