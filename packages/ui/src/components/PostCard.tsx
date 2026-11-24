import type { ComponentProps } from "react";
import { Heart, MessageSquare, Quote, Repeat2, TrendingUp } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { splitTextSegments } from "../lib/hosts.ts";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import type { UiMode } from "./ModeToggle.tsx";

export interface PostQuotePreview {
  /** Quoted post identifier. */
  id: string;
  /** Quoted author display name. */
  authorDisplayName: string;
  /** Quoted author handle without `@`. */
  authorHandle: string;
  /** True when quoted author is an NPC parody account. */
  isNpcParody: boolean;
  /** Quoted post body text. */
  content: string;
}

export interface PostMarketBadge {
  /** Market cashtag ticker without `$`. */
  ticker: string;
  /** Market headline or contract summary. */
  label: string;
  /** Optional YES odds percentage for prediction markets. */
  oddsPct?: number;
  /** Optional 24h change percentage for perp markets. */
  changePct?: number;
}

export interface PostCardData {
  /** Post identifier. */
  id: string;
  /** Author display name. */
  authorDisplayName: string;
  /** Author handle without `@`. */
  authorHandle: string;
  /** Optional avatar URL. */
  authorAvatarUrl?: string;
  /** Discloses satirical NPC accounts with an `AI parody` pill. */
  isNpcParody: boolean;
  /** Formatted relative or UTC timestamp. */
  createdAt: string;
  /** Post body text (up to 280 chars). */
  content: string;
  /** Optional MCP client attribution (`via Claude`, etc.). */
  viaClientName?: string;
  /** Parent handle when this post is a unified single-model reply. */
  replyToHandle?: string;
  /** Optional embedded quote post. */
  quotePost?: PostQuotePreview;
  /** Optional trade/market embed hidden automatically in `SocialMode`. */
  marketBadge?: PostMarketBadge;
  /** Total like count. */
  likeCount: number;
  /** Total repost count. */
  repostCount: number;
  /** Total reply count. */
  replyCount: number;
  /** Whether the viewer has liked this post. */
  liked?: boolean;
  /** Whether the viewer has reposted this post. */
  reposted?: boolean;
}

export type PostCardProps = Omit<ComponentProps<"article">, "children"> & {
  /** Post payload rendered inside the card. */
  post: PostCardData;
  /** Presentation mode; `SocialMode` strips market embeds and cashtag links while keeping NPC posts. */
  mode?: UiMode;
  /** Called when Like is clicked. */
  onLike?: (postId: string) => void;
  /** Called when Repost is clicked. */
  onRepost?: (postId: string) => void;
  /** Called when Reply is clicked. */
  onReply?: (postId: string) => void;
  /** Called when Quote is clicked. */
  onQuote?: (postId: string) => void;
  /** Called when the author header is clicked. */
  onAuthorClick?: (handle: string) => void;
  /** Called when a cashtag or market badge is clicked in `GameMode`. */
  onMarketClick?: (ticker: string) => void;
  /** Disables interactive actions. */
  disabled?: boolean;
};

const cashtagPattern = /(\$[A-Z][A-Z0-9]{0,9})\b/g;

/** Social post card honoring single-reply context, `via <client>` attribution, NPC parody badges, and `SocialMode` projection. */
export function PostCard({
  post,
  mode = "GameMode",
  onLike,
  onRepost,
  onReply,
  onQuote,
  onAuthorClick,
  onMarketClick,
  disabled = false,
  className,
  ...props
}: PostCardProps) {
  const isGame = mode === "GameMode";
  const segments = splitTextSegments(post.content, cashtagPattern);

  return (
    <article className={cn("flex gap-3 border-b border-border bg-card px-4 py-4 text-card-foreground", className)} {...props}>
      <Avatar name={post.authorDisplayName} src={post.authorAvatarUrl} size="md" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {onAuthorClick ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onAuthorClick(post.authorHandle)}
              className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm font-semibold text-foreground hover:underline")}
            >
              <span>{post.authorDisplayName}</span>
              <span className="font-normal text-muted-foreground">@{post.authorHandle}</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="font-semibold text-foreground">{post.authorDisplayName}</span>
              <span className="text-muted-foreground">@{post.authorHandle}</span>
            </span>
          )}
          {post.isNpcParody ? <Badge variant="info">AI parody</Badge> : null}
          {post.viaClientName ? <Badge variant="outline">via {post.viaClientName}</Badge> : null}
          <span className="text-xs text-muted-foreground">{post.createdAt}</span>
        </div>

        {post.replyToHandle ? <p className="text-xs text-muted-foreground">Replying to @{post.replyToHandle}</p> : null}

        <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground wrap-anywhere">
          {segments.map((segment) => {
            if (!segment.matched || !isGame) return <span key={segment.key}>{segment.text}</span>;
            if (onMarketClick) {
              return (
                <button
                  key={segment.key}
                  type="button"
                  disabled={disabled}
                  onClick={() => !disabled && onMarketClick(segment.text.slice(1))}
                  className={cn(focusRing, inactive, "rounded-sm font-semibold text-primary hover:underline")}
                >
                  {segment.text}
                </button>
              );
            }
            return (
              <span key={segment.key} className="font-semibold text-primary">
                {segment.text}
              </span>
            );
          })}
        </p>

        {post.quotePost ? (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-background p-3 text-sm">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-semibold text-foreground">{post.quotePost.authorDisplayName}</span>
              <span className="text-muted-foreground">@{post.quotePost.authorHandle}</span>
              {post.quotePost.isNpcParody ? <Badge variant="info">AI parody</Badge> : null}
            </div>
            <p className="text-muted-foreground">{post.quotePost.content}</p>
          </div>
        ) : null}

        {isGame && post.marketBadge ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => !disabled && onMarketClick?.(post.marketBadge!.ticker)}
            className={cn(
              focusRing,
              inactive,
              "flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <TrendingUp aria-hidden className="size-4 shrink-0 text-primary" />
              <span className="font-mono font-semibold text-primary">${post.marketBadge.ticker}</span>
              <span className="truncate text-foreground">{post.marketBadge.label}</span>
            </span>
            <span className="shrink-0 font-mono font-semibold text-foreground tabular-nums">
              {post.marketBadge.oddsPct !== undefined
                ? `${post.marketBadge.oddsPct}% YES`
                : post.marketBadge.changePct !== undefined
                  ? `${post.marketBadge.changePct >= 0 ? "+" : ""}${post.marketBadge.changePct}%`
                  : null}
            </span>
          </button>
        ) : null}

        <div className="flex items-center gap-6 pt-1 text-xs text-muted-foreground">
          <button
            type="button"
            disabled={disabled}
            aria-label={`Reply ${post.replyCount}`}
            onClick={() => !disabled && onReply?.(post.id)}
            className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-primary")}
          >
            <MessageSquare aria-hidden className="size-4" />
            <span className="font-mono tabular-nums">{post.replyCount}</span>
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={Boolean(post.reposted)}
            aria-label={`Repost ${post.repostCount}`}
            onClick={() => !disabled && onRepost?.(post.id)}
            className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-ok", post.reposted && "text-ok")}
          >
            <Repeat2 aria-hidden className="size-4" />
            <span className="font-mono tabular-nums">{post.repostCount}</span>
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={Boolean(post.liked)}
            aria-label={`Like ${post.likeCount}`}
            onClick={() => !disabled && onLike?.(post.id)}
            className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-destructive", post.liked && "text-destructive")}
          >
            <Heart aria-hidden className="size-4" />
            <span className="font-mono tabular-nums">{post.likeCount}</span>
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label="Quote post"
            onClick={() => !disabled && onQuote?.(post.id)}
            className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-primary")}
          >
            <Quote aria-hidden className="size-4" />
          </button>
        </div>
      </div>
    </article>
  );
}
