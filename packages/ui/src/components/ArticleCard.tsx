import type { ComponentProps } from "react";
import { ArrowRight } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import type { UiMode } from "./ModeToggle.tsx";

export interface ArticleItem {
  /** Article or proof record identifier. */
  id: string;
  /** Headline shown on the card. */
  title: string;
  /** Short summary or resolution evidence excerpt. */
  summary: string;
  /** Publisher or parody news desk name. */
  source: string;
  /** Optional publisher avatar URL. */
  orgAvatarUrl?: string;
  /** Optional editorial cover image URL. */
  coverImageUrl?: string;
  /** Optional category or clue phase badge. */
  category?: string;
  /** Formatted publication time. */
  timestamp: string;
  /** Optional market cashtag ticker; hidden in `SocialMode`. */
  ticker?: string;
}

export type ArticleCardProps = Omit<ComponentProps<"article">, "children"> & {
  /** Article or resolution proof summary. */
  article: ArticleItem;
  /** Presentation mode (`SocialMode` hides `ticker` market tags). */
  mode?: UiMode;
  /** Opens the full article or proof detail view. */
  onSelect?: (id: string) => void;
  /** Disables selection action. */
  disabled?: boolean;
};

/** Flat hairline editorial news or resolution proof row with optional cover media and `SocialMode` ticker filtering. */
export function ArticleCard({ article, mode = "GameMode", onSelect, disabled = false, className, ...props }: ArticleCardProps) {
  const isGame = mode === "GameMode";
  const clickable = Boolean(onSelect && !disabled);

  return (
    <article
      onClick={clickable ? () => onSelect?.(article.id) : undefined}
      className={cn(
        "flex flex-col gap-3 border-b border-border bg-background px-4 py-4 text-foreground transition-colors duration-fast hover:bg-muted/30",
        clickable && "cursor-pointer",
        className,
      )}
      {...props}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-2 font-semibold text-foreground">
          <Avatar name={article.source} src={article.orgAvatarUrl} seed={article.source} size="xs" />
          <span className="truncate">{article.source}</span>
          <span aria-hidden className="font-normal text-muted-foreground">
            ·
          </span>
          <span className="font-normal text-muted-foreground">{article.timestamp}</span>
        </span>
        <div className="flex items-center gap-1.5">
          {article.category ? <Badge variant="secondary">{article.category}</Badge> : null}
          {isGame && article.ticker ? (
            <Badge variant="info" className="font-mono">
              ${article.ticker}
            </Badge>
          ) : null}
        </div>
      </div>

      {article.coverImageUrl ? (
        <div className="overflow-hidden rounded-xl border border-border bg-muted">
          <img src={article.coverImageUrl} alt="" className="aspect-video w-full object-cover" />
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <h3 className="text-base leading-snug font-bold text-foreground">{article.title}</h3>
        <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">{article.summary}</p>
      </div>

      {onSelect ? (
        <div>
          <button
            type="button"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              if (!disabled) onSelect(article.id);
            }}
            className={cn(focusRing, inactive, "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline")}
          >
            <span>Read full article</span>
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
    </article>
  );
}
