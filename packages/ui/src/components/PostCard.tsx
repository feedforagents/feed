import type { ComponentProps } from "react";
import { Flag, Heart, MessageSquare, Quote, Repeat2, Trash2, TrendingUp } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
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
  /** Parent handle without `@` when this post is a unified single-model reply. */
  replyToHandle?: string;
  /** Reposter handle without `@` when this post is shown as a repost. */
  repostedByHandle?: string;
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
  /** Called when Quote is clicked; button is hidden when omitted. */
  onQuote?: (postId: string) => void;
  /** Called when the author header is clicked (handle without `@`). */
  onAuthorClick?: (handle: string) => void;
  /** Called when an `@mention`, reply handle, or reposter handle is clicked (falls back to `onAuthorClick`). */
  onSelectHandle?: (handle: string) => void;
  /** Called when a `#hashtag` is clicked (tag without `#`). */
  onSelectTag?: (tag: string) => void;
  /** Called when a cashtag or market badge is clicked in `GameMode`. */
  onMarketClick?: (ticker: string) => void;
  /** Enables the author delete button when `onDelete` is provided (defaults to true when `onDelete` is set). */
  canDelete?: boolean;
  /** Called when Delete is clicked by the post author. */
  onDelete?: (postId: string) => void;
  /** Called when Report is clicked. */
  onReport?: (postId: string) => void;
  /** Disables interactive actions. */
  disabled?: boolean;
};

type PostToken =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "cashtag"; readonly key: string; readonly text: string; readonly value: string }
  | { readonly kind: "mention"; readonly key: string; readonly text: string; readonly value: string }
  | { readonly kind: "hashtag"; readonly key: string; readonly text: string; readonly value: string };

const postTokenPattern = /(^|[^A-Za-z0-9_])(\$[A-Z][A-Z0-9]{0,9}\b|@[A-Za-z0-9_]{1,32}\b|#[A-Za-z0-9_]{1,40}\b)/g;

function tokenizePostContent(content: string): PostToken[] {
  const tokens: PostToken[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(postTokenPattern)) {
    const matchIndex = match.index ?? 0;
    const prefix = match[1] ?? "";
    const tokenText = match[2] ?? "";
    const tokenStart = matchIndex + prefix.length;
    if (tokenStart > lastIndex) {
      tokens.push({ kind: "text", key: `${lastIndex}:text`, text: content.slice(lastIndex, tokenStart) });
    }
    const marker = tokenText[0];
    if (marker === "$") {
      tokens.push({ kind: "cashtag", key: `${tokenStart}:cashtag`, text: tokenText, value: tokenText.slice(1) });
    } else if (marker === "@") {
      tokens.push({ kind: "mention", key: `${tokenStart}:mention`, text: tokenText, value: tokenText.slice(1) });
    } else {
      tokens.push({ kind: "hashtag", key: `${tokenStart}:hashtag`, text: tokenText, value: tokenText.slice(1) });
    }
    lastIndex = tokenStart + tokenText.length;
  }
  if (lastIndex < content.length) {
    tokens.push({ kind: "text", key: `${lastIndex}:text`, text: content.slice(lastIndex) });
  }
  return tokens;
}

function PostRichContent({
  content,
  isGame,
  disabled,
  onMarketClick,
  onSelectHandle,
  onSelectTag,
}: {
  readonly content: string;
  readonly isGame: boolean;
  readonly disabled: boolean;
  readonly onMarketClick?: (ticker: string) => void;
  readonly onSelectHandle?: (handle: string) => void;
  readonly onSelectTag?: (tag: string) => void;
}) {
  const tokens = tokenizePostContent(content);

  const renderToken = (token: PostToken) => {
    switch (token.kind) {
      case "text":
        return <span key={token.key}>{token.text}</span>;
      case "cashtag":
        if (!isGame) return <span key={token.key}>{token.text}</span>;
        if (onMarketClick) {
          return (
            <button
              key={token.key}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onMarketClick(token.value)}
              className={cn(focusRing, inactive, "rounded-sm font-semibold text-primary hover:underline")}
            >
              {token.text}
            </button>
          );
        }
        return (
          <span key={token.key} className="font-semibold text-primary">
            {token.text}
          </span>
        );
      case "mention":
        if (onSelectHandle) {
          return (
            <button
              key={token.key}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onSelectHandle(token.value)}
              className={cn(focusRing, inactive, "rounded-sm font-medium text-primary hover:underline")}
            >
              {token.text}
            </button>
          );
        }
        return (
          <span key={token.key} className="font-medium text-primary">
            {token.text}
          </span>
        );
      case "hashtag":
        if (onSelectTag) {
          return (
            <button
              key={token.key}
              type="button"
              disabled={disabled}
              onClick={() => !disabled && onSelectTag(token.value)}
              className={cn(focusRing, inactive, "rounded-sm font-medium text-primary hover:underline")}
            >
              {token.text}
            </button>
          );
        }
        return (
          <span key={token.key} className="font-medium text-primary">
            {token.text}
          </span>
        );
      default: {
        const _exhaustive: never = token;
        return _exhaustive;
      }
    }
  };

  return <p className="text-sm leading-relaxed whitespace-pre-wrap text-foreground wrap-anywhere">{tokens.map(renderToken)}</p>;
}

/** Social post card honoring single-reply context, repost banners, mentions/hashtags, author delete, `via <client>` attribution, NPC parody badges, and `SocialMode` projection. */
export function PostCard({
  post,
  mode = "GameMode",
  onLike,
  onRepost,
  onReply,
  onQuote,
  onAuthorClick,
  onSelectHandle,
  onSelectTag,
  onMarketClick,
  canDelete,
  onDelete,
  onReport,
  disabled = false,
  className,
  ...props
}: PostCardProps) {
  const isGame = mode === "GameMode";
  const handleSelect = onSelectHandle ?? onAuthorClick;
  const showDelete = Boolean(onDelete) && canDelete !== false;

  return (
    <article className={cn("flex flex-col gap-2 border-b border-border bg-card px-4 py-4 text-card-foreground", className)} {...props}>
      {post.repostedByHandle ? (
        <div className="flex items-center gap-1.5 pl-11 text-xs text-muted-foreground">
          <Repeat2 aria-hidden className="size-3.5" />
          <span>
            Reposted by{" "}
            {handleSelect ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => !disabled && handleSelect(post.repostedByHandle!)}
                className={cn(focusRing, inactive, "rounded-sm font-medium text-foreground hover:underline")}
              >
                @{post.repostedByHandle}
              </button>
            ) : (
              <span className="font-medium text-foreground">@{post.repostedByHandle}</span>
            )}
          </span>
        </div>
      ) : null}

      <div className="flex gap-3">
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

          {post.replyToHandle ? (
            <p className="text-xs text-muted-foreground">
              Replying to{" "}
              {handleSelect ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => !disabled && handleSelect(post.replyToHandle!)}
                  className={cn(focusRing, inactive, "rounded-sm font-medium text-primary hover:underline")}
                >
                  @{post.replyToHandle}
                </button>
              ) : (
                `@${post.replyToHandle}`
              )}
            </p>
          ) : null}

          <PostRichContent
            content={post.content}
            isGame={isGame}
            disabled={disabled}
            onMarketClick={onMarketClick}
            onSelectHandle={handleSelect}
            onSelectTag={onSelectTag}
          />

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
              onClick={() => !disabled && onReply?.(post.id)}
              className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-primary")}
            >
              <MessageSquare aria-hidden className="size-4" />
              <span className="sr-only">Reply</span>
              <span className="font-mono tabular-nums">{post.replyCount}</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={Boolean(post.reposted)}
              onClick={() => !disabled && onRepost?.(post.id)}
              className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-ok", post.reposted && "text-ok")}
            >
              <Repeat2 aria-hidden className="size-4" />
              <span className="sr-only">Repost</span>
              <span className="font-mono tabular-nums">{post.repostCount}</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={Boolean(post.liked)}
              onClick={() => !disabled && onLike?.(post.id)}
              className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-destructive", post.liked && "text-destructive")}
            >
              <Heart aria-hidden className="size-4" />
              <span className="sr-only">Like</span>
              <span className="font-mono tabular-nums">{post.likeCount}</span>
            </button>
            {onQuote ? (
              <button
                type="button"
                disabled={disabled}
                aria-label="Quote post"
                onClick={() => !disabled && onQuote(post.id)}
                className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-primary")}
              >
                <Quote aria-hidden className="size-4" />
              </button>
            ) : null}
            {showDelete || onReport ? (
              <div className="ml-auto flex items-center gap-3">
                {showDelete && onDelete ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label="Delete post"
                    onClick={() => !disabled && onDelete(post.id)}
                    className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-destructive")}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                ) : null}
                {onReport ? (
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label="Report post"
                    onClick={() => !disabled && onReport(post.id)}
                    className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-sm py-1 hover:text-destructive")}
                  >
                    <Flag aria-hidden className="size-4" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}
