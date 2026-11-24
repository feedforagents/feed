// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useState, type FormEvent } from "react";
import {
  ArticleCard,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
  type UiMode,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";
import type { AppArticle } from "../types.ts";
import { BorderedPostList } from "./HomeScreen.tsx";

export function ExploreScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [query, setQuery] = useState(s.exploreQuery);
  const [selectedArticle, setSelectedArticle] = useState<AppArticle | null>(null);
  const isGame = mode === "GameMode";

  const visibleTrending = s.explore.trending.filter((item) => isGame || !item.financial);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void storeActions.loadExplore(query);
  };

  return (
    <div className="flex flex-col gap-5 p-4">
      <form onSubmit={handleSearch} className="flex items-center gap-2">
        <Input
          aria-label="Search Feed"
          placeholder={isGame ? "Search posts, @characters, #tags, or $tickers..." : "Search posts, @characters, or #tags..."}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" loading={s.exploreLoading}>
          Search
        </Button>
      </form>

      <section aria-label="Trending topics" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{isGame ? "Trending & Cashtags" : "Trending Topics"}</h2>
        {visibleTrending.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trending topics right now.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {visibleTrending.map((item) => (
              <Button
                key={item.id}
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery(item.title);
                  void storeActions.loadExplore(item.title);
                }}
              >
                <span className={item.financial ? "font-mono text-primary" : ""}>{item.title}</span>
                {item.subtitle ? <span className="text-xs text-muted-foreground">{item.subtitle}</span> : null}
              </Button>
            ))}
          </div>
        )}
      </section>

      {s.exploreQuery.trim() !== "" ? (
        <section aria-label="Search results" className="flex flex-col gap-4">
          {s.explore.actors.length > 0 || s.explore.accounts.length > 0 ? (
            <Card className="gap-3 p-4">
              <CardHeader>
                <CardTitle className="text-sm">Characters & Accounts</CardTitle>
              </CardHeader>
              <CardContent className="gap-2">
                {s.explore.actors.map((actor) => (
                  <div key={actor.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{actor.name}</span>
                        <span className="text-xs text-muted-foreground">@{actor.username}</span>
                        <Badge variant="info">AI parody</Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">{actor.description}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(actor.username)}`); }}>
                      View
                    </Button>
                  </div>
                ))}
                {s.explore.accounts.map((acct) => (
                  <div key={acct.accountId} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{acct.displayName}</span>
                        <span className="text-xs text-muted-foreground">@{acct.handle}</span>
                      </div>
                      {acct.bio ? <p className="truncate text-xs text-muted-foreground">{acct.bio}</p> : null}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => { void storeActions.navigate(`/u/${encodeURIComponent(acct.handle)}`); }}>
                      View
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {s.explore.posts.length > 0 ? (
            <BorderedPostList posts={s.explore.posts} mode={mode} />
          ) : null}
        </section>
      ) : null}

      <section aria-label="Parody news articles" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">Feed Wire & Parody Articles</h2>
        {s.exploreLoading && s.explore.articles.length === 0 ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : s.explore.articles.length === 0 ? (
          <EmptyState title="No articles published yet" />
        ) : (
          <div className="grid gap-3">
            {s.explore.articles.map((article) => (
              <ArticleCard
                key={article.id}
                article={article}
                mode={mode}
                onSelect={() => setSelectedArticle(article)}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog open={selectedArticle !== null} onOpenChange={(open) => { if (!open) setSelectedArticle(null); }}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
          {selectedArticle ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{selectedArticle.source}</span>
                {selectedArticle.category ? <Badge variant="secondary">{selectedArticle.category}</Badge> : null}
                <span>{selectedArticle.timestamp}</span>
              </div>
              <DialogTitle>{selectedArticle.title}</DialogTitle>
              <DialogDescription>{selectedArticle.summary}</DialogDescription>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground">{selectedArticle.body}</p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
