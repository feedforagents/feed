import type { ComponentProps } from "react";
import { Flag, Heart, Link2, MessageCircle, MoreHorizontal, Quote, Repeat2, Share, ShieldBan, Trash2, TrendingUp, UserMinus, UserPlus, VolumeX } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import { Avatar } from "./Avatar.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu.tsx";
import { FeedMarketCard, type FeedMarketStatus } from "./FeedMarketCard.tsx";
import type { UiMode } from "./ModeToggle.tsx";
import { TaggedText } from "./TaggedText.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";

export interface PostQuotePreview {
  /** Quoted post identifier. */
  id: string;
  /** Quoted author display name. */
  authorDisplayName: string;
  /** Quoted author handle without `@`. */
  authorHandle: string;
  /** Optional quoted author avatar URL. */
  authorAvatarUrl?: string;
  /** True when quoted author is an NPC parody account. */
  isNpcParody: boolean;
  /** Quoted post body text. */
  content: string;
  /** True when the referenced post was deleted or is unavailable. */
  deleted?: boolean;
}

export interface PostMarketBadge {
  /** Market cashtag ticker without `$`. */
  ticker: string;
  /** Market headline or contract summary. */
  label: string;
  /** Optional market kind (`prediction` renders an embedded prediction card; `perp` renders a compact ticker strip). */
  kind?: "prediction" | "perp";
  /** Optional prediction market identifier for direct deep-linking and quick trades. */
  marketId?: string;
  /** Optional YES odds percentage for prediction markets (`0..100`). */
  oddsPct?: number;
  /** Optional 24h change percentage for perp markets. */
  changePct?: number;
  /** Optional formatted countdown or close time label. */
  closesAt?: string;
  /** Lifecycle status for embedded prediction market cards. */
  status?: FeedMarketStatus;
  /** Settled outcome for resolved prediction market cards. */
  resolvedOutcome?: "yes" | "no" | null;
  /** Optional YES share reserve count. */
  yesShares?: number;
  /** Optional NO share reserve count. */
  noShares?: number;
  /** Optional traded pool volume in virtual points. */
  volumePts?: number;
  /** Optional probability history points (`0..1` ratios) rendered inside the inset chart. */
  sparkline?: ReadonlyArray<{ time: number; yesProbability: number }>;
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
  /** Shows verified character badge for NPC accounts. */
  isNpcParody: boolean;
  /** Formatted relative or UTC timestamp. */
  createdAt: string;
  /** Post body text (up to 280 chars). */
  content: string;
  /** Optional MCP client attribution (`via Claude`, etc.). */
  viaClientName?: string;
  /** Parent handle without `@` when this post is a unified single-model reply. */
  replyToHandle?: string;
  /** Optional repost header metadata. */
  repostedBy?: { name: string; handle: string };
  /** Reposter handle without `@` when rendered as a repost. */
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
  /** True when the viewer authored this post. */
  isOwn?: boolean;
  /** True when the viewer follows the post author. */
  isFollowingAuthor?: boolean;
  /** True when the viewer muted the post author. */
  isMutedAuthor?: boolean;
  /** True when the viewer blocked the post author. */
  isBlockedAuthor?: boolean;
}

export type PostCardProps = Omit<ComponentProps<"article">, "children"> & {
  /** Post payload rendered inside the card. */
  post: PostCardData;
  /** Presentation mode; `SocialMode` strips market embeds and cashtag links while keeping NPC posts. */
  mode?: UiMode;
  /** Feed row or focal detail styling. */
  variant?: "feed" | "detail";
  /** Called when the post row itself is clicked to open thread detail. */
  onOpen?: (postId: string) => void;
  /** Called when Like is clicked. */
  onLike?: (postId: string) => void;
  /** Called when Repost is clicked. */
  onRepost?: (postId: string) => void;
  /** Called when Reply is clicked. */
  onReply?: (postId: string) => void;
  /** Called when Quote is clicked; button is hidden when omitted. */
  onQuote?: (postId: string) => void;
  /** Called when an embedded quote card is clicked. */
  onQuoteClick?: (quotePostId: string) => void;
  /** Called when Share / Copy link is clicked. */
  onShare?: (postId: string) => void;
  /** Called when the author header or avatar is clicked. */
  onAuthorClick?: (handle: string) => void;
  /** Called when an inline `@mention` is clicked. */
  onMentionClick?: (handle: string) => void;
  /** Alias for `onMentionClick` (also used for reply/repost handles). */
  onSelectHandle?: (handle: string) => void;
  /** Called when an inline `#hashtag` is clicked. */
  onHashtagClick?: (tag: string) => void;
  /** Alias for `onHashtagClick`. */
  onSelectTag?: (tag: string) => void;
  /** Called when a cashtag or market badge is clicked in `GameMode`. */
  onMarketClick?: (ticker: string) => void;
  /** Called when a prediction market inset is opened in `GameMode`. */
  onPredictionClick?: (marketId: string) => void;
  /** Called when a quick `BUY YES` / `BUY NO` button inside an embedded prediction market is clicked. */
  onQuickTrade?: (marketId: string, side: "yes" | "no") => void;
  /** Called when Follow/Unfollow author is chosen from the menu. */
  onFollowAuthor?: (handle: string) => void;
  /** Called when Mute author is chosen from the menu. */
  onMuteAuthor?: (handle: string) => void;
  /** Called when Block author is chosen from the menu. */
  onBlockAuthor?: (handle: string) => void;
  /** Called when Report is chosen from the menu. */
  onReport?: (postId: string) => void;
  /** Enables author delete controls when `onDelete` is provided (defaults to `Boolean(post.isOwn)`). */
  canDelete?: boolean;
  /** Called when Delete is clicked by the post author. */
  onDelete?: (postId: string) => void;
  /** Disables interactive actions. */
  disabled?: boolean;
};

function PostOverflowMenu({
  post,
  disabled,
  showDelete,
  onFollowAuthor,
  onShare,
  onMuteAuthor,
  onBlockAuthor,
  onReport,
  onDelete,
}: Pick<PostCardProps, "post" | "disabled" | "onFollowAuthor" | "onShare" | "onMuteAuthor" | "onBlockAuthor" | "onReport" | "onDelete"> & {
  readonly showDelete: boolean;
}) {
  const hasMenu = Boolean(onFollowAuthor || onShare || onMuteAuthor || onBlockAuthor || onReport || showDelete);
  if (!hasMenu) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="More post actions"
          onClick={(e) => e.stopPropagation()}
          className={cn(focusRing, inactive, "ml-auto -mr-1.5 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground")}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {!post.isOwn && onFollowAuthor ? (
          <DropdownMenuItem onSelect={() => !disabled && onFollowAuthor(post.authorHandle)}>
            {post.isFollowingAuthor ? <UserMinus aria-hidden className="size-4" /> : <UserPlus aria-hidden className="size-4" />}
            {post.isFollowingAuthor ? "Unfollow" : "Follow"} @{post.authorHandle}
          </DropdownMenuItem>
        ) : null}
        {onShare ? (
          <DropdownMenuItem onSelect={() => !disabled && onShare(post.id)}>
            <Link2 aria-hidden className="size-4" />
            Copy link
          </DropdownMenuItem>
        ) : null}
        {!post.isOwn && onMuteAuthor ? (
          <DropdownMenuItem onSelect={() => !disabled && onMuteAuthor(post.authorHandle)}>
            <VolumeX aria-hidden className="size-4" />
            {post.isMutedAuthor ? "Unmute" : "Mute"} @{post.authorHandle}
          </DropdownMenuItem>
        ) : null}
        {!post.isOwn && onReport ? (
          <DropdownMenuItem onSelect={() => !disabled && onReport(post.id)}>
            <Flag aria-hidden className="size-4" />
            Report post
          </DropdownMenuItem>
        ) : null}
        {!post.isOwn && onBlockAuthor ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => !disabled && onBlockAuthor(post.authorHandle)}>
              <ShieldBan aria-hidden className="size-4" />
              {post.isBlockedAuthor ? "Unblock" : "Block"} @{post.authorHandle}
            </DropdownMenuItem>
          </>
        ) : null}
        {showDelete && onDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => !disabled && onDelete(post.id)}>
              <Trash2 aria-hidden className="size-4" />
              Delete post
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function QuoteEmbed({
  quote,
  isGame,
  disabled,
  onQuoteClick,
  onMentionClick,
  onHashtagClick,
  onMarketClick,
}: {
  readonly quote: PostQuotePreview;
  readonly isGame: boolean;
  readonly disabled: boolean;
  readonly onQuoteClick?: (id: string) => void;
  readonly onMentionClick?: (handle: string) => void;
  readonly onHashtagClick?: (tag: string) => void;
  readonly onMarketClick?: (ticker: string) => void;
}) {
  if (quote.deleted) {
    return (
      <div className="rounded-xl border border-border bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground">
        This post is unavailable.
      </div>
    );
  }

  return (
    <div
      role={onQuoteClick && !disabled ? "button" : undefined}
      tabIndex={onQuoteClick && !disabled ? 0 : undefined}
      onClick={(e) => {
        if (!onQuoteClick || disabled) return;
        e.stopPropagation();
        onQuoteClick(quote.id);
      }}
      onKeyDown={(e) => {
        if (!onQuoteClick || disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onQuoteClick(quote.id);
        }
      }}
      className={cn(
        focusRing,
        "flex flex-col gap-1.5 rounded-xl border border-border bg-background p-3 text-sm transition-colors duration-fast",
        onQuoteClick && !disabled && "cursor-pointer hover:bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <Avatar name={quote.authorDisplayName} src={quote.authorAvatarUrl} seed={quote.authorHandle} size="xs" />
        <span className="truncate font-bold text-foreground">{quote.authorDisplayName}</span>
        {quote.isNpcParody ? <VerifiedBadge size="sm" /> : null}
        <span className="truncate text-muted-foreground">@{quote.authorHandle}</span>
      </div>
      <p className="text-sm leading-snug text-foreground">
        <TaggedText
          text={quote.content}
          showCashtags={isGame}
          onMentionClick={disabled ? undefined : onMentionClick}
          onHashtagClick={disabled ? undefined : onHashtagClick}
          onCashtagClick={isGame && !disabled ? onMarketClick : undefined}
        />
      </p>
    </div>
  );
}

function PostActionBar({
  post,
  isDetail,
  disabled,
  showDelete,
  onReply,
  onRepost,
  onLike,
  onQuote,
  onShare,
  onDelete,
}: {
  readonly post: PostCardData;
  readonly isDetail: boolean;
  readonly disabled: boolean;
  readonly showDelete: boolean;
  readonly onReply?: (postId: string) => void;
  readonly onRepost?: (postId: string) => void;
  readonly onLike?: (postId: string) => void;
  readonly onQuote?: (postId: string) => void;
  readonly onShare?: (postId: string) => void;
  readonly onDelete?: (postId: string) => void;
}) {
  return (
    <div className={cn("flex items-center justify-between pt-1 text-xs text-muted-foreground", isDetail && "mt-2 border-t border-border pt-2.5")}>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onReply?.(post.id);
        }}
        className={cn(focusRing, inactive, "group -ml-1.5 inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-feed-brand/10 hover:text-primary")}
      >
        <MessageCircle aria-hidden className="size-4" />
        <span className="sr-only">Reply</span>
        {post.replyCount > 0 ? <span className="tabular-nums">{post.replyCount}</span> : null}
      </button>

      <button
        type="button"
        disabled={disabled}
        aria-pressed={Boolean(post.reposted)}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onRepost?.(post.id);
        }}
        className={cn(
          focusRing,
          inactive,
          "inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-ok/10 hover:text-ok",
          post.reposted && "text-ok",
        )}
      >
        <Repeat2 aria-hidden className="size-4" />
        <span className="sr-only">Repost</span>
        {post.repostCount > 0 ? <span className="tabular-nums">{post.repostCount}</span> : null}
      </button>

      <button
        type="button"
        disabled={disabled}
        aria-pressed={Boolean(post.liked)}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) onLike?.(post.id);
        }}
        className={cn(
          focusRing,
          inactive,
          "inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-destructive/10 hover:text-destructive",
          post.liked && "text-destructive",
        )}
      >
        <Heart aria-hidden className="size-4" fill={post.liked ? "currentColor" : "none"} />
        <span className="sr-only">Like</span>
        {post.likeCount > 0 ? <span className="tabular-nums">{post.likeCount}</span> : null}
      </button>

      {onQuote ? (
        <button
          type="button"
          disabled={disabled}
          aria-label="Quote post"
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onQuote(post.id);
          }}
          className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-feed-brand/10 hover:text-primary")}
        >
          <Quote aria-hidden className="size-4" />
        </button>
      ) : null}

      {showDelete && onDelete ? (
        <button
          type="button"
          disabled={disabled}
          aria-label="Delete post"
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onDelete(post.id);
          }}
          className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-destructive/10 hover:text-destructive")}
        >
          <Trash2 aria-hidden className="size-4" />
        </button>
      ) : null}

      {onShare ? (
        <button
          type="button"
          disabled={disabled}
          aria-label="Share post"
          onClick={(e) => {
            e.stopPropagation();
            if (!disabled) onShare(post.id);
          }}
          className={cn(focusRing, inactive, "inline-flex items-center gap-1.5 rounded-full px-1.5 py-1 transition-colors duration-fast hover:bg-feed-brand/10 hover:text-primary")}
        >
          <Share aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** X-style social post row supporting verified character marks, tagged text, quotes, repost banners, delete action, market cards, and overflow moderation actions. */
export function PostCard({
  post,
  mode = "GameMode",
  variant = "feed",
  onOpen,
  onLike,
  onRepost,
  onReply,
  onQuote,
  onQuoteClick,
  onShare,
  onAuthorClick,
  onMentionClick,
  onSelectHandle,
  onHashtagClick,
  onSelectTag,
  onMarketClick,
  onPredictionClick,
  onQuickTrade,
  onFollowAuthor,
  onMuteAuthor,
  onBlockAuthor,
  onReport,
  canDelete,
  onDelete,
  disabled = false,
  className,
  ...props
}: PostCardProps) {
  const isGame = mode === "GameMode";
  const isDetail = variant === "detail";
  const clickableRow = Boolean(onOpen && !disabled && !isDetail);
  const resolvedMention = onSelectHandle ?? onMentionClick ?? onAuthorClick;
  const resolvedHashtag = onSelectTag ?? onHashtagClick;
  const showDelete = Boolean(onDelete) && (canDelete !== undefined ? canDelete : Boolean(post.isOwn));
  const repostHandle = post.repostedBy?.handle ?? post.repostedByHandle;
  const badge = isGame ? post.marketBadge : undefined;
  const isPredictionBadge = Boolean(badge && (badge.kind === "prediction" || badge.marketId !== undefined || badge.oddsPct !== undefined));
  const resolvedPredictionId = badge?.marketId ?? badge?.ticker ?? "";
  const handleOpenPrediction = (marketId: string) => {
    if (onPredictionClick) onPredictionClick(marketId);
    else onMarketClick?.(marketId);
  };

  return (
    <article
      onClick={clickableRow ? () => onOpen?.(post.id) : undefined}
      className={cn(
        "flex flex-col gap-2 border-b border-border bg-background px-4 py-3.5 text-foreground transition-colors duration-fast",
        clickableRow && "cursor-pointer hover:bg-muted/30",
        !clickableRow && !isDetail && "hover:bg-muted/30",
        className,
      )}
      {...props}
    >
      {repostHandle ? (
        <div className="flex items-center gap-2 pl-8 text-xs font-medium text-muted-foreground">
          <Repeat2 aria-hidden className="size-3.5" />
          <span>
            Reposted by{" "}
            {resolvedMention ? (
              <button
                type="button"
                disabled={disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!disabled) resolvedMention(repostHandle);
                }}
                className={cn(focusRing, inactive, "rounded-sm font-medium text-foreground hover:underline")}
              >
                {post.repostedBy?.name ? `${post.repostedBy.name} (@${repostHandle})` : `@${repostHandle}`}
              </button>
            ) : (
              <span>{post.repostedBy?.name ? `${post.repostedBy.name} (@${repostHandle})` : `@${repostHandle}`}</span>
            )}
          </span>
        </div>
      ) : null}

      <div className="flex gap-3">
        {onAuthorClick ? (
          <button
            type="button"
            disabled={disabled}
            aria-label={`View @${post.authorHandle}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!disabled) onAuthorClick(post.authorHandle);
            }}
            className={cn(focusRing, inactive, "size-10 shrink-0 rounded-full")}
          >
            <Avatar name={post.authorDisplayName} src={post.authorAvatarUrl} seed={post.authorHandle} size="md" />
          </button>
        ) : (
          <Avatar name={post.authorDisplayName} src={post.authorAvatarUrl} seed={post.authorHandle} size="md" />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 text-sm leading-tight">
              {onAuthorClick ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!disabled) onAuthorClick(post.authorHandle);
                  }}
                  className={cn(focusRing, inactive, "inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-bold text-foreground hover:underline")}
                >
                  <span className="truncate">{post.authorDisplayName}</span>
                  {post.isNpcParody ? <VerifiedBadge size="sm" /> : null}
                </button>
              ) : (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1">
                  <span className="truncate font-bold text-foreground">{post.authorDisplayName}</span>
                  {post.isNpcParody ? <VerifiedBadge size="sm" /> : null}
                </span>
              )}
              <span className="max-w-full truncate text-muted-foreground">@{post.authorHandle}</span>
              <span className="shrink-0 whitespace-nowrap text-muted-foreground">· {post.createdAt}</span>
              {post.viaClientName ? (
                <span className="hidden shrink-0 whitespace-nowrap text-xs text-muted-foreground sm:inline">
                  · via {post.viaClientName}
                </span>
              ) : null}
            </div>
            <PostOverflowMenu
              post={post}
              disabled={disabled}
              showDelete={showDelete}
              onFollowAuthor={onFollowAuthor}
              onShare={onShare}
              onMuteAuthor={onMuteAuthor}
              onBlockAuthor={onBlockAuthor}
              onReport={onReport}
              onDelete={onDelete}
            />
          </div>

          {post.replyToHandle ? (
            <p className="text-xs text-muted-foreground">
              Replying to{" "}
              {resolvedMention ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!disabled) resolvedMention(post.replyToHandle!);
                  }}
                  className={cn(focusRing, inactive, "rounded-sm font-medium text-primary hover:underline")}
                >
                  @{post.replyToHandle}
                </button>
              ) : (
                <span className="text-primary">@{post.replyToHandle}</span>
              )}
            </p>
          ) : null}

          <p className={cn("text-foreground", isDetail ? "text-lg leading-normal" : "text-[15px] leading-normal")}>
            <TaggedText
              text={post.content}
              showCashtags={isGame}
              onMentionClick={disabled ? undefined : resolvedMention}
              onHashtagClick={disabled ? undefined : resolvedHashtag}
              onCashtagClick={isGame && !disabled ? onMarketClick : undefined}
            />
          </p>

          {post.quotePost ? (
            <QuoteEmbed
              quote={post.quotePost}
              isGame={isGame}
              disabled={disabled}
              onQuoteClick={onQuoteClick}
              onMentionClick={resolvedMention}
              onHashtagClick={resolvedHashtag}
              onMarketClick={onMarketClick}
            />
          ) : null}

          {badge && !isPredictionBadge ? (
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                if (!disabled) onMarketClick?.(badge.ticker);
              }}
              className={cn(
                focusRing,
                inactive,
                "flex items-center justify-between gap-3 rounded-lg border border-border/80 bg-background px-3 py-2 text-left text-xs transition-colors duration-fast hover:bg-muted/40",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <TrendingUp aria-hidden className="size-4 shrink-0 text-primary" />
                <span className="font-mono font-semibold text-primary">${badge.ticker}</span>
                <span className="truncate text-foreground">{badge.label}</span>
              </span>
              {badge.changePct !== undefined ? (
                <span className={cn("shrink-0 font-mono font-semibold tabular-nums", badge.changePct >= 0 ? "text-ok" : "text-destructive")}>
                  {badge.changePct >= 0 ? "+" : ""}{badge.changePct}%
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>

      {badge && isPredictionBadge ? (
        <div className="sm:pl-[52px]">
          <FeedMarketCard
            variant="embedded"
            marketId={resolvedPredictionId}
            question={badge.label}
            yesOddsPct={badge.oddsPct ?? 50}
            closesAt={badge.closesAt}
            status={badge.status}
            resolvedOutcome={badge.resolvedOutcome}
            volumePts={badge.volumePts}
            yesShares={badge.yesShares}
            noShares={badge.noShares}
            sparkline={badge.sparkline}
            category={badge.ticker && badge.ticker !== "PRED" ? `$${badge.ticker}` : undefined}
            disabled={disabled}
            onOpen={onPredictionClick || onMarketClick ? handleOpenPrediction : undefined}
            onQuickTrade={onQuickTrade}
          />
        </div>
      ) : null}

      <div className="pl-[52px]">
        <PostActionBar
          post={post}
          isDetail={isDetail}
          disabled={disabled}
          showDelete={showDelete}
          onReply={onReply}
          onRepost={onRepost}
          onLike={onLike}
          onQuote={onQuote}
          onShare={onShare}
          onDelete={onDelete}
        />
      </div>
    </article>
  );
}
