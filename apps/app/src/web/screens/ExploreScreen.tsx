// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useState, type FormEvent } from "react";
import {
  ArticleCard,
  Avatar,
  Badge,
  Button,
  EmptyState,
  Input,
  MarketCard,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  VerifiedBadge,
  type UiMode,
} from "@repo/ui";
import { SearchIcon, XIcon } from "../icons.tsx";
import { FlatPostList } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppArticle } from "../types.ts";

type BrowseTab = "trending" | "news" | "people" | "orgs" | "markets";
type SearchTab = "top" | "latest" | "people" | "orgs" | "markets";

function renderArticleCards(articles: ReadonlyArray<AppArticle>, mode: UiMode) {
  return articles.map((article) => (
    <ArticleCard
      key={article.id}
      article={article}
      mode={mode}
      onSelect={() => { void storeActions.navigate(`/article/${encodeURIComponent(article.id)}`); }}
    />
  ));
}

function ExplorePeopleList({ hasSearch }: { readonly hasSearch: boolean }) {
  const s = useAppStore();
  if (s.explore.actors.length === 0 && s.explore.accounts.length === 0) {
    return <EmptyState title={hasSearch ? "No matching people" : "Search to find people"} />;
  }
  return (
    <div className="divide-y divide-border">
      {s.explore.actors.map((actor) => (
        <div key={actor.id} className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
          <button
            type="button"
            onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(actor.username)}`); }}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            <Avatar name={actor.name} src={actor.avatarUrl ?? undefined} seed={actor.username} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-sm font-bold text-foreground hover:underline">{actor.name}</span>
                {actor.isParody ? <VerifiedBadge size="sm" /> : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">@{actor.username}</p>
              {actor.description ? <p className="mt-1 line-clamp-2 text-sm text-foreground/90">{actor.description}</p> : null}
            </div>
          </button>
          <Button
            size="sm"
            shape="pill"
            onClick={() => { void storeActions.toggleFollow(actor.username); }}
            className="shrink-0 font-bold"
          >
            Follow
          </Button>
        </div>
      ))}
      {s.explore.accounts.map((acct) => (
        <div key={acct.accountId} className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
          <button
            type="button"
            onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(acct.handle)}`); }}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            <Avatar name={acct.displayName} src={acct.avatarUrl ?? undefined} seed={acct.handle} size="md" />
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-bold text-foreground hover:underline">{acct.displayName}</span>
              <p className="truncate text-xs text-muted-foreground">@{acct.handle}</p>
              {acct.bio ? <p className="mt-1 line-clamp-2 text-sm text-foreground/90">{acct.bio}</p> : null}
            </div>
          </button>
          {s.viewer?.handle.toLowerCase() !== acct.handle.toLowerCase() ? (
            <Button
              size="sm"
              shape="pill"
              onClick={() => { void storeActions.toggleFollow(acct.handle); }}
              className="shrink-0 font-bold"
            >
              Follow
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ExploreOrgsList({ hasSearch, isGame }: { readonly hasSearch: boolean; readonly isGame: boolean }) {
  const s = useAppStore();
  if (s.explore.organizations.length === 0) {
    return <EmptyState title={hasSearch ? "No matching organizations" : "Search to browse organizations"} />;
  }
  return (
    <div className="divide-y divide-border">
      {s.explore.organizations.map((org) => (
        <div key={org.id} className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
          <button
            type="button"
            onClick={() => { void storeActions.navigate(`/orgs/${encodeURIComponent(org.id)}`); }}
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
          >
            <Avatar name={org.name} src={org.avatarUrl ?? undefined} seed={org.id} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-bold text-foreground hover:underline">{org.name}</span>
                <VerifiedBadge size="sm" />
                {isGame && org.ticker ? <Badge variant="info" className="font-mono">${org.ticker}</Badge> : null}
              </div>
              <p className="text-xs text-muted-foreground">{org.orgType}</p>
              {org.description ? <p className="mt-1 line-clamp-2 text-sm text-foreground/90">{org.description}</p> : null}
            </div>
          </button>
          {isGame && org.ticker ? (
            <Button
              size="sm"
              shape="pill"
              variant="outline"
              onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(org.ticker ?? "")}`); }}
            >
              Trade
            </Button>
          ) : (
            <Button
              size="sm"
              shape="pill"
              variant="outline"
              onClick={() => { void storeActions.navigate(`/orgs/${encodeURIComponent(org.id)}`); }}
            >
              View
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function ExploreMarketsList() {
  const s = useAppStore();
  const qLower = s.exploreQuery.trim().toLowerCase();
  const matchedPreds = qLower
    ? s.predictions.filter((m) => m.card.question.toLowerCase().includes(qLower) || m.category.toLowerCase().includes(qLower))
    : s.predictions;
  const matchedPerps = qLower
    ? s.perps.filter((p) => p.ticker.toLowerCase().includes(qLower) || p.card.name.toLowerCase().includes(qLower))
    : s.perps;
  if (matchedPreds.length === 0 && matchedPerps.length === 0) {
    return (
      <EmptyState title="No matching markets">
        <Button variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/markets"); }}>
          Open Markets
        </Button>
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      {matchedPerps.map((perp) => (
        <MarketCard
          key={perp.ticker}
          market={perp.card}
          onSelect={(ticker) => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(ticker)}`); }}
        />
      ))}
      {matchedPreds.map((pred) => (
        <MarketCard
          key={pred.card.id}
          market={pred.card}
          onSelect={(id) => { void storeActions.navigate(`/markets/predictions/${encodeURIComponent(id)}`); }}
        />
      ))}
    </div>
  );
}

export function ExploreScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [draftQuery, setDraftQuery] = useState(s.exploreQuery);
  const [browseTab, setBrowseTab] = useState<BrowseTab>("trending");
  const [searchTab, setSearchTab] = useState<SearchTab>("top");
  const isGame = mode === "GameMode";
  const hasSearch = s.exploreQuery.trim() !== "";

  const visibleTrending = s.explore.trending.filter((item) => isGame || !item.financial);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    storeActions.setExploreUrlQuery(draftQuery);
  };

  const clearSearch = () => {
    setDraftQuery("");
    storeActions.setExploreUrlQuery("");
  };

  const sortedLatestPosts = [...s.explore.posts].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const activeBrowseTab: BrowseTab = !isGame && browseTab === "markets" ? "trending" : browseTab;
  const activeSearchTab: SearchTab = !isGame && searchTab === "markets" ? "top" : searchTab;
  const peopleCount = s.explore.actors.length + s.explore.accounts.length;

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <form onSubmit={handleSearch} className="flex items-center gap-2 px-4 py-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label="Search Feed"
              placeholder={isGame ? "Search posts, @people, #tags, or $tickers" : "Search posts, @people, or #tags"}
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              className="h-10 rounded-full bg-muted/60 pr-9 pl-10"
            />
            {draftQuery ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={clearSearch}
                className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button type="submit" size="sm" shape="pill" loading={s.exploreLoading}>
            Search
          </Button>
        </form>

        <Tabs
          value={hasSearch ? activeSearchTab : activeBrowseTab}
          onValueChange={(next) => {
            if (hasSearch) {
              if (next === "top" || next === "latest" || next === "people" || next === "orgs" || next === "markets") {
                setSearchTab(next);
              }
            } else if (next === "trending" || next === "news" || next === "people" || next === "orgs" || next === "markets") {
              setBrowseTab(next);
            }
          }}
        >
          <TabsList variant="underline" className="border-b-0">
            <TabsTrigger value={hasSearch ? "top" : "trending"}>{hasSearch ? "Top" : "Trending"}</TabsTrigger>
            <TabsTrigger value={hasSearch ? "latest" : "news"}>{hasSearch ? "Latest" : "News"}</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="orgs">Orgs</TabsTrigger>
            {isGame ? <TabsTrigger value="markets">Markets</TabsTrigger> : null}
          </TabsList>
        </Tabs>
      </div>

      {s.activeTrendingTag ? (
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
          <span className="text-sm font-bold text-foreground">#{s.activeTrendingTag.replace(/^#/, "")}</span>
          <Button size="sm" variant="ghost" shape="pill" onClick={clearSearch}>
            Clear tag
          </Button>
        </div>
      ) : null}

      {s.exploreLoading && visibleTrending.length === 0 && s.explore.articles.length === 0 && s.explore.posts.length === 0 ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-24" />
        </div>
      ) : hasSearch ? (
        activeSearchTab === "top" ? (
          <div className="flex flex-col">
            {s.explore.tags.length > 0 ? (
              <section className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                {s.explore.tags.map((tag) => (
                  <Button
                    key={tag}
                    size="sm"
                    variant="outline"
                    shape="pill"
                    onClick={() => {
                      const clean = tag.replace(/^#/, "");
                      setDraftQuery(`#${clean}`);
                      void storeActions.navigate(`/trending/${encodeURIComponent(clean)}`);
                    }}
                  >
                    #{tag.replace(/^#/, "")}
                  </Button>
                ))}
              </section>
            ) : null}
            {peopleCount > 0 ? (
              <section className="border-b border-border">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <h2 className="text-sm font-bold text-foreground">People</h2>
                  <button type="button" onClick={() => setSearchTab("people")} className="text-xs font-medium text-primary hover:underline">
                    View all
                  </button>
                </div>
                <ExplorePeopleList hasSearch />
              </section>
            ) : null}
            {s.explore.organizations.length > 0 ? (
              <section className="border-b border-border">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <h2 className="text-sm font-bold text-foreground">Organizations</h2>
                  <button type="button" onClick={() => setSearchTab("orgs")} className="text-xs font-medium text-primary hover:underline">
                    View all
                  </button>
                </div>
                <ExploreOrgsList hasSearch isGame={isGame} />
              </section>
            ) : null}
            {s.explore.posts.length > 0 ? (
              <FlatPostList posts={s.explore.posts} mode={mode} />
            ) : peopleCount === 0 && s.explore.organizations.length === 0 && s.explore.tags.length === 0 ? (
              <EmptyState title={`No results for "${s.exploreQuery}"`} />
            ) : null}
          </div>
        ) : activeSearchTab === "latest" ? (
          sortedLatestPosts.length === 0 ? (
            <EmptyState title={`No recent posts for "${s.exploreQuery}"`} />
          ) : (
            <FlatPostList posts={sortedLatestPosts} mode={mode} />
          )
        ) : activeSearchTab === "people" ? (
          <ExplorePeopleList hasSearch />
        ) : activeSearchTab === "orgs" ? (
          <ExploreOrgsList hasSearch isGame={isGame} />
        ) : (
          <ExploreMarketsList />
        )
      ) : activeBrowseTab === "trending" ? (
        <div className="flex flex-col">
          {visibleTrending.length === 0 ? (
            <EmptyState title="No trending topics right now" />
          ) : (
            <div className="divide-y divide-border border-b border-border">
              {visibleTrending.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.financial && isGame) {
                      void storeActions.navigate(`/markets?ticker=${encodeURIComponent(item.title.replace(/^\$/, ""))}`);
                      return;
                    }
                    setDraftQuery(item.title);
                    void storeActions.navigate(`/trending/${encodeURIComponent(item.title.replace(/^#/, ""))}`);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-muted/30"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {idx + 1} · {item.financial ? "Markets" : "Trending"}
                    </p>
                    <p className={`truncate text-base font-bold ${item.financial ? "font-mono text-primary" : "text-foreground"}`}>
                      {item.title}
                    </p>
                    {item.subtitle ? <p className="text-xs text-muted-foreground">{item.subtitle}</p> : null}
                  </div>
                  {item.metric && isGame ? (
                    <span className="shrink-0 font-mono text-sm font-semibold text-primary tabular-nums">{item.metric}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}

          {s.explore.articles.length > 0 ? (
            <section className="flex flex-col">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h2 className="text-base font-bold text-foreground">Top Stories</h2>
                <button type="button" onClick={() => setBrowseTab("news")} className="text-xs font-medium text-primary hover:underline">
                  See all
                </button>
              </div>
              {renderArticleCards(s.explore.articles.slice(0, 5), mode)}
            </section>
          ) : null}
        </div>
      ) : activeBrowseTab === "news" ? (
        s.explore.articles.length === 0 ? (
          <EmptyState title="No articles published yet" />
        ) : (
          <div className="flex flex-col">
            {renderArticleCards(s.explore.articles, mode)}
          </div>
        )
      ) : activeBrowseTab === "people" ? (
        <ExplorePeopleList hasSearch={false} />
      ) : activeBrowseTab === "orgs" ? (
        <ExploreOrgsList hasSearch={false} isGame={isGame} />
      ) : (
        <ExploreMarketsList />
      )}
    </div>
  );
}
