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
import { ArticleDetailScreen } from "./ArticleDetailScreen.tsx";

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

function ExplorePeopleList({ hasSearch, limit }: { readonly hasSearch: boolean; readonly limit?: number }) {
  const s = useAppStore();
  const combined = [
    ...s.explore.actors.map((actor) => ({
      key: `actor:${actor.id}`,
      handle: actor.username,
      displayName: actor.name,
      avatarUrl: actor.avatarUrl ?? undefined,
      bio: actor.description,
      isParody: actor.isParody,
      viewerFollows: actor.viewerFollows,
    })),
    ...s.explore.accounts.map((acct) => ({
      key: `acct:${acct.accountId}`,
      handle: acct.handle,
      displayName: acct.displayName,
      avatarUrl: acct.avatarUrl ?? undefined,
      bio: acct.bio,
      isParody: false,
      viewerFollows: acct.viewerFollows,
    })),
  ];
  const visible = limit !== undefined ? combined.slice(0, limit) : combined;
  if (visible.length === 0) {
    return <EmptyState title={hasSearch ? "No matching people" : "Search to find people"} />;
  }
  return (
    <div className="divide-y divide-border">
      {visible.map((person) => {
        const isSelf = s.viewer?.handle.toLowerCase() === person.handle.toLowerCase();
        return (
          <div key={person.key} className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
            <button
              type="button"
              onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(person.handle)}`); }}
              className="flex min-w-0 flex-1 items-start gap-3 text-left"
            >
              <Avatar name={person.displayName} src={person.avatarUrl} seed={person.handle} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="truncate text-sm font-bold text-foreground hover:underline">{person.displayName}</span>
                  {person.isParody ? <VerifiedBadge size="sm" /> : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">@{person.handle}</p>
                {person.bio ? <p className="mt-1 line-clamp-2 text-sm text-foreground/90">{person.bio}</p> : null}
              </div>
            </button>
            {!isSelf ? (
              <Button
                size="sm"
                shape="pill"
                variant={person.viewerFollows ? "outline" : "primary"}
                onClick={() => { void storeActions.toggleFollow(person.handle, person.viewerFollows); }}
                className="shrink-0 font-bold"
              >
                {person.viewerFollows ? "Following" : "Follow"}
              </Button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface ExploreOrgListItem {
  readonly id: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly orgType: string;
  readonly description: string;
  readonly avatarUrl: string | null;
  readonly markPricePts: string | null;
  readonly change24hPct: number | null;
}

function buildExploreOrgItems(
  s: ReturnType<typeof useAppStore>,
  hasSearch: boolean,
): ReadonlyArray<ExploreOrgListItem> {
  const perpsByTicker = new Map<string, (typeof s.perps)[number]>();
  const perpsByOrgId = new Map<string, (typeof s.perps)[number]>();
  for (const perp of s.perps) {
    perpsByTicker.set(perp.ticker.toUpperCase(), perp);
    if (perp.organizationId) {
      perpsByOrgId.set(perp.organizationId.toLowerCase(), perp);
    }
  }

  const seenIds = new Set<string>();
  const seenTickers = new Set<string>();
  const items: ExploreOrgListItem[] = [];

  for (const org of s.explore.organizations) {
    const matchedPerp =
      (org.ticker ? perpsByTicker.get(org.ticker.toUpperCase()) : undefined) ??
      perpsByOrgId.get(org.id.toLowerCase());
    seenIds.add(org.id.toLowerCase());
    if (org.ticker) seenTickers.add(org.ticker.toUpperCase());
    if (matchedPerp) seenTickers.add(matchedPerp.ticker.toUpperCase());
    items.push({
      id: org.id,
      name: org.name,
      ticker: org.ticker ?? matchedPerp?.ticker ?? null,
      orgType: org.orgType,
      description: org.description,
      avatarUrl: org.avatarUrl ?? matchedPerp?.orgImageUrl ?? null,
      markPricePts: matchedPerp?.card.markPricePts ?? null,
      change24hPct: matchedPerp ? matchedPerp.change24hPct : null,
    });
  }

  const qLower = s.exploreQuery.trim().toLowerCase().replace(/^\$(?=.)/, "");
  for (const perp of s.perps) {
    const orgId = perp.organizationId ?? perp.ticker;
    if (seenIds.has(orgId.toLowerCase()) || seenTickers.has(perp.ticker.toUpperCase())) continue;
    if (
      hasSearch &&
      !perp.ticker.toLowerCase().includes(qLower) &&
      !perp.card.name.toLowerCase().includes(qLower) &&
      !orgId.toLowerCase().includes(qLower)
    ) {
      continue;
    }
    seenIds.add(orgId.toLowerCase());
    seenTickers.add(perp.ticker.toUpperCase());
    items.push({
      id: orgId,
      name: perp.card.name,
      ticker: perp.ticker,
      orgType: "Organization",
      description: "",
      avatarUrl: perp.orgImageUrl,
      markPricePts: perp.card.markPricePts,
      change24hPct: perp.change24hPct,
    });
  }

  return items;
}

function ExploreOrgsList({
  hasSearch,
  isGame,
  limit,
}: {
  readonly hasSearch: boolean;
  readonly isGame: boolean;
  readonly limit?: number;
}) {
  const s = useAppStore();
  const allOrgs = buildExploreOrgItems(s, hasSearch);
  const orgs = limit !== undefined ? allOrgs.slice(0, limit) : allOrgs;
  if (orgs.length === 0) {
    return <EmptyState title={hasSearch ? "No matching organizations" : "No organizations available yet"} />;
  }
  return (
    <div className="divide-y divide-border">
      {orgs.map((org) => {
        const positive = (org.change24hPct ?? 0) >= 0;
        return (
          <div key={org.id} className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
            <button
              type="button"
              onClick={() => { void storeActions.navigate(`/orgs/${encodeURIComponent(org.id)}`); }}
              className="flex min-w-0 flex-1 items-start gap-3 text-left"
            >
              <Avatar name={org.name} src={org.avatarUrl ?? undefined} seed={org.id} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-bold text-foreground hover:underline">{org.name}</span>
                  <VerifiedBadge size="sm" />
                  {isGame && org.ticker ? <Badge variant="info" className="font-mono">${org.ticker}</Badge> : null}
                </div>
                <p className="text-xs text-muted-foreground">{org.orgType}</p>
                {org.description ? <p className="mt-1 line-clamp-2 text-sm text-foreground/90">{org.description}</p> : null}
              </div>
            </button>
            <div className="flex shrink-0 items-center gap-3">
              {isGame && org.markPricePts ? (
                <div className="text-right font-mono text-xs tabular-nums">
                  <span className="block font-semibold text-foreground">{org.markPricePts}</span>
                  {org.change24hPct !== null ? (
                    <span className={positive ? "text-ok" : "text-destructive"}>
                      {positive ? "+" : ""}
                      {org.change24hPct.toFixed(1)}%
                    </span>
                  ) : null}
                </div>
              ) : null}
              {isGame && org.ticker ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(org.ticker ?? "")}`); }}
                >
                  Trade
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { void storeActions.navigate(`/orgs/${encodeURIComponent(org.id)}`); }}
                >
                  View
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExploreMarketsList() {
  const s = useAppStore();
  const qLower = s.exploreQuery.trim().toLowerCase().replace(/^\$(?=.)/, "");
  const matchedPreds = qLower
    ? s.predictions.filter((m) => m.card.question.toLowerCase().includes(qLower) || m.category.toLowerCase().includes(qLower))
    : s.predictions;
  const matchedPerps = qLower
    ? s.perps.filter((p) => p.ticker.toLowerCase().includes(qLower) || p.card.name.toLowerCase().includes(qLower))
    : s.perps;
  if (matchedPreds.length === 0 && matchedPerps.length === 0) {
    return (
      <EmptyState title="No matching markets">
        <Button variant="outline" onClick={() => { void storeActions.navigate("/markets"); }}>
          Open Markets
        </Button>
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col">
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
  const { activeArticleId, exploreNewsRequest } = useAppStore();
  const [browseTab, setBrowseTab] = useState<BrowseTab>(exploreNewsRequest === null ? "trending" : "news");
  const [searchTab, setSearchTab] = useState<SearchTab>("top");
  const [handledNewsRequest, setHandledNewsRequest] = useState(exploreNewsRequest);
  if (exploreNewsRequest !== null && exploreNewsRequest !== handledNewsRequest) {
    setHandledNewsRequest(exploreNewsRequest);
    setBrowseTab("news");
  }
  return activeArticleId
    ? <ArticleDetailScreen mode={mode} />
    : (
      <ExploreBrowseScreen
        mode={mode}
        browseTab={browseTab}
        setBrowseTab={setBrowseTab}
        searchTab={searchTab}
        setSearchTab={setSearchTab}
      />
    );
}

function ExploreBrowseScreen({ mode, browseTab, setBrowseTab, searchTab, setSearchTab }: {
  readonly mode: UiMode;
  readonly browseTab: BrowseTab;
  readonly setBrowseTab: (tab: BrowseTab) => void;
  readonly searchTab: SearchTab;
  readonly setSearchTab: (tab: SearchTab) => void;
}) {
  const s = useAppStore();
  const [draftQuery, setDraftQuery] = useState(s.exploreQuery);
  const [syncedQuery, setSyncedQuery] = useState(s.exploreQuery);

  if (s.exploreQuery !== syncedQuery) {
    setSyncedQuery(s.exploreQuery);
    setDraftQuery(s.exploreQuery);
  }

  const isGame = mode === "GameMode";
  const hasSearch = s.exploreQuery.trim() !== "";
  const qLower = s.exploreQuery.trim().toLowerCase();

  const visibleTrending = s.explore.trending.filter((item) => isGame || !item.financial);
  const visibleTags = s.explore.tags.filter((tag) => isGame || tag.kind !== "ticker");

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
  const searchOrgCount = hasSearch ? buildExploreOrgItems(s, true).length : 0;
  const matchingMarketCount = isGame && hasSearch
    ? s.predictions.filter((m) => m.card.question.toLowerCase().includes(qLower) || m.category.toLowerCase().includes(qLower)).length
      + s.perps.filter((p) => p.ticker.toLowerCase().includes(qLower) || p.card.name.toLowerCase().includes(qLower)).length
    : 0;

  const showLoadingSkeleton =
    s.exploreLoading &&
    (hasSearch || (visibleTrending.length === 0 && s.explore.articles.length === 0 && s.explore.posts.length === 0));

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 flex flex-col border-b border-border bg-background/85 backdrop-blur-md md:top-0">
        <form onSubmit={handleSearch} className="flex items-center gap-2 px-4 py-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              enterKeyHint="search"
              aria-label="Search Feed"
              placeholder={isGame ? "Search posts, @people, #tags, or $tickers" : "Search posts, @people, or #tags"}
              value={draftQuery}
              onChange={(e) => setDraftQuery(e.target.value)}
              className="h-10 rounded-full border-transparent bg-muted pr-9 pl-10 focus-visible:border-feed-brand focus-visible:bg-background"
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
          <Button type="submit" size="sm" loading={s.exploreLoading}>
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
          <Button size="sm" variant="ghost" onClick={clearSearch}>
            Clear tag
          </Button>
        </div>
      ) : null}

      {showLoadingSkeleton ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-24" />
        </div>
      ) : hasSearch ? (
        activeSearchTab === "top" ? (
          <div className="flex flex-col">
            {visibleTags.length > 0 ? (
              <section className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                {visibleTags.map((item) => (
                  <Button
                    key={`${item.kind}:${item.tag}`}
                    size="sm"
                    variant="outline"
                    shape="pill"
                    onClick={() => {
                      if (item.kind === "ticker" && isGame) {
                        void storeActions.navigate(`/markets/perps/${encodeURIComponent(item.tag.toUpperCase())}`);
                        return;
                      }
                      setDraftQuery(`#${item.tag}`);
                      void storeActions.navigate(`/trending/${encodeURIComponent(item.tag)}`);
                    }}
                  >
                    {item.kind === "ticker" ? `$${item.tag.toUpperCase()}` : `#${item.tag}`}
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
                <ExplorePeopleList hasSearch limit={3} />
              </section>
            ) : null}
            {searchOrgCount > 0 ? (
              <section className="border-b border-border">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <h2 className="text-sm font-bold text-foreground">Organizations</h2>
                  <button type="button" onClick={() => setSearchTab("orgs")} className="text-xs font-medium text-primary hover:underline">
                    View all
                  </button>
                </div>
                <ExploreOrgsList hasSearch isGame={isGame} limit={3} />
              </section>
            ) : null}
            {matchingMarketCount > 0 && s.explore.posts.length === 0 ? (
              <section className="border-b border-border">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <h2 className="text-sm font-bold text-foreground">Markets</h2>
                  <button type="button" onClick={() => setSearchTab("markets")} className="text-xs font-medium text-primary hover:underline">
                    View all
                  </button>
                </div>
                <ExploreMarketsList />
              </section>
            ) : null}
            {s.explore.posts.length > 0 ? (
              <FlatPostList posts={s.explore.posts} mode={mode} />
            ) : peopleCount === 0 && searchOrgCount === 0 && visibleTags.length === 0 && matchingMarketCount === 0 ? (
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
                      void storeActions.navigate(`/markets/perps/${encodeURIComponent(item.title.replace(/^\$/, ""))}`);
                      return;
                    }
                    setDraftQuery(item.title);
                    void storeActions.navigate(`/trending/${encodeURIComponent(item.title.replace(/^#/, ""))}`);
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-fast hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">
                      {idx + 1} · {item.financial ? "Markets" : "Trending"}
                    </p>
                    <p className={`truncate text-base font-bold ${item.financial ? "font-mono text-primary" : "text-foreground"}`}>
                      {item.title}
                    </p>
                    {item.subtitle ? (
                      <p className="text-xs text-muted-foreground">{item.subtitle.replace(/\b1 posts\b/giu, "1 post")}</p>
                    ) : null}
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
