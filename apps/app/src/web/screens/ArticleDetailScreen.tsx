// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import {
  ArticleCard,
  Avatar,
  Badge,
  Button,
  EmptyState,
  MarketCard,
  Skeleton,
  type UiMode,
} from "@repo/ui";
import { BackHeader } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import { formatFullTimestamp } from "../types.ts";

export function ArticleDetailScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const article = s.activeArticle;
  const isGame = mode === "GameMode";

  const relatedPrediction = isGame && article?.relatedMarketId
    ? s.predictions.find((m) => m.card.id === article.relatedMarketId) ?? null
    : null;
  const relatedPerp = isGame && article?.ticker
    ? s.perps.find((p) => p.ticker.toUpperCase() === article.ticker?.toUpperCase()) ?? null
    : null;
  const moreArticles = s.explore.articles.filter((a) => a.id !== article?.id).slice(0, 4);
  const rawBlocks = (article?.body ?? "").split(/\n{2,}/u).map((b) => b.trim()).filter(Boolean);
  const blockCounts = new Map<string, number>();
  const blocks = rawBlocks.map((text) => {
    const count = blockCounts.get(text) ?? 0;
    blockCounts.set(text, count + 1);
    return { key: `${text.slice(0, 32)}#${count}`, text };
  });

  return (
    <div className="flex flex-col">
      <BackHeader fallbackPath="/explore">
        <h1 className="truncate text-base font-bold text-foreground">Article</h1>
      </BackHeader>

      {s.articleLoading && !article ? (
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-48" />
          <Skeleton className="h-24" />
        </div>
      ) : !article ? (
        <EmptyState title="Article not found">
          <Button variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/explore"); }}>
            Back to Explore
          </Button>
        </EmptyState>
      ) : (
        <article className="flex flex-col gap-5 px-4 py-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <Avatar name={article.source} src={article.orgAvatarUrl} seed={article.source} size="sm" />
              <div className="flex flex-col">
                <span className="text-sm font-bold text-foreground">{article.source}</span>
                <span className="text-xs text-muted-foreground">
                  {article.publishedAtMs > 0 ? formatFullTimestamp(article.publishedAtMs) : article.timestamp}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {article.category ? <Badge variant="secondary">{article.category}</Badge> : null}
              {isGame && article.ticker ? (
                <button
                  type="button"
                  onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(article.ticker ?? "")}`); }}
                >
                  <Badge variant="info" className="font-mono">${article.ticker}</Badge>
                </button>
              ) : null}
            </div>
          </div>

          <h2 className="text-2xl leading-tight font-bold tracking-tight text-foreground">{article.title}</h2>

          {article.summary ? (
            <p className="text-base leading-relaxed text-muted-foreground">{article.summary}</p>
          ) : null}

          {article.coverImageUrl ? (
            <div className="overflow-hidden rounded-xl border border-border bg-muted">
              <img src={article.coverImageUrl} alt="" className="aspect-video w-full object-cover" />
            </div>
          ) : null}

          <div className="flex flex-col gap-4 text-base leading-relaxed text-foreground">
            {blocks.map((block) => {
              if (block.text.startsWith("## ")) {
                return (
                  <h3 key={block.key} className="pt-2 text-lg font-bold text-foreground">
                    {block.text.slice(3)}
                  </h3>
                );
              }
              if (block.text.startsWith("# ")) {
                return (
                  <h3 key={block.key} className="pt-2 text-xl font-bold text-foreground">
                    {block.text.slice(2)}
                  </h3>
                );
              }
              return (
                <p key={block.key} className="whitespace-pre-wrap">
                  {block.text}
                </p>
              );
            })}
          </div>

          {relatedPrediction ? (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-bold text-foreground">Related Market</h3>
              <MarketCard
                market={relatedPrediction.card}
                onSelect={(id) => { void storeActions.navigate(`/markets/predictions/${encodeURIComponent(id)}`); }}
              />
            </section>
          ) : relatedPerp ? (
            <section className="flex flex-col gap-2 border-t border-border pt-4">
              <h3 className="text-sm font-bold text-foreground">Related Market</h3>
              <MarketCard
                market={relatedPerp.card}
                onSelect={(ticker) => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(ticker)}`); }}
              />
            </section>
          ) : null}

          {moreArticles.length > 0 ? (
            <section className="-mx-4 mt-2 border-t border-border pt-4">
              <h3 className="px-4 pb-2 text-base font-bold text-foreground">More Articles</h3>
              <div className="flex flex-col">
                {moreArticles.map((item) => (
                  <ArticleCard
                    key={item.id}
                    article={item}
                    mode={mode}
                    onSelect={() => { void storeActions.navigate(`/article/${encodeURIComponent(item.id)}`); }}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </article>
      )}
    </div>
  );
}
