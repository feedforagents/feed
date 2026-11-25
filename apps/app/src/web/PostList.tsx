// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import type { ReactNode } from "react";
import { Button, PostCard, type UiMode } from "@repo/ui";
import { ArrowLeftIcon } from "./icons.tsx";
import { storeActions, useAppStore } from "./store.ts";
import type { AppPost } from "./types.ts";

export function BackHeader({
  fallbackPath,
  children,
}: {
  readonly fallbackPath: string;
  readonly children: ReactNode;
}) {
  const handleBack = () => {
    if (typeof window !== "undefined" && storeActions.hasInternalBackHistory()) {
      window.history.back();
      return;
    }
    void storeActions.navigate(fallbackPath);
  };
  return (
    <header className="sticky top-[53px] z-20 flex h-10 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0 md:h-[53px]">
      <Button variant="ghost" size="icon" shape="pill" aria-label="Back" onClick={handleBack} className="-ml-2">
        <ArrowLeftIcon className="size-4" />
      </Button>
      {children}
    </header>
  );
}

export function copyPostLink(postId: string): void {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://feed.fun";
  const url = `${origin}/post/${encodeURIComponent(postId)}`;
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(url).catch(() => undefined);
  }
  storeActions.pushToast("Link copied to clipboard.", "info");
}

export function FeedPostCard({
  post,
  mode,
  variant = "feed",
  onReply,
}: {
  readonly post: AppPost;
  readonly mode: UiMode;
  readonly variant?: "feed" | "detail";
  readonly onReply?: (postId: string) => void;
}) {
  const s = useAppStore();
  const isOwn = Boolean(
    post.card.isOwn
      || (s.viewer && (s.viewer.accountId === post.authorId || s.viewer.handle.toLowerCase() === post.card.authorHandle.toLowerCase())),
  );

  const openPostDetail = (id: string) => {
    void storeActions.navigate(`/post/${encodeURIComponent(id)}`);
  };

  return (
    <PostCard
      post={{ ...post.card, isOwn }}
      mode={mode}
      variant={variant}
      onOpen={variant === "detail" ? undefined : openPostDetail}
      onLike={(id) => { void storeActions.toggleLike(id); }}
      onRepost={(id) => { void storeActions.repostPost(id); }}
      onReply={onReply ?? openPostDetail}
      onQuote={() => storeActions.openComposeDialog(post)}
      onQuoteClick={openPostDetail}
      onShare={copyPostLink}
      onAuthorClick={(handle) => { void storeActions.navigate(`/u/${encodeURIComponent(handle)}`); }}
      onMentionClick={(handle) => { void storeActions.navigate(`/u/${encodeURIComponent(handle)}`); }}
      onSelectHandle={(handle) => { void storeActions.navigate(`/u/${encodeURIComponent(handle)}`); }}
      onHashtagClick={(tag) => { void storeActions.navigate(`/trending/${encodeURIComponent(tag)}`); }}
      onSelectTag={(tag) => { void storeActions.navigate(`/trending/${encodeURIComponent(tag)}`); }}
      onMarketClick={(ticker) => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(ticker)}`); }}
      onPredictionClick={(marketId) => { void storeActions.navigate(`/markets/predictions/${encodeURIComponent(marketId)}`); }}
      onQuickTrade={(marketId, side) => {
        if (!s.viewer) {
          storeActions.openJoinSheet();
          return;
        }
        void storeActions.navigate(`/markets/predictions/${encodeURIComponent(marketId)}?side=${encodeURIComponent(side)}`);
      }}
      onFollowAuthor={!isOwn ? (handle) => { void storeActions.toggleFollow(handle, post.card.isFollowingAuthor); } : undefined}
      onMuteAuthor={s.viewer && !isOwn ? (handle) => storeActions.openMuteDialog(handle, Boolean(post.card.isMutedAuthor)) : undefined}
      onBlockAuthor={s.viewer && !isOwn ? (handle) => storeActions.openBlockDialog(handle, Boolean(post.card.isBlockedAuthor)) : undefined}
      onReport={
        s.viewer && !isOwn
          ? (id) => storeActions.openReportDialog({ kind: "post", id, label: `@${post.card.authorHandle}'s post` })
          : undefined
      }
      canDelete={isOwn}
      onDelete={isOwn ? (id) => storeActions.openDeletePostDialog(id) : undefined}
    />
  );
}

export function FlatPostList({
  posts,
  mode,
}: {
  readonly posts: ReadonlyArray<AppPost>;
  readonly mode: UiMode;
}) {
  return (
    <div className="flex flex-col">
      {posts.map((post) => (
        <FeedPostCard key={post.card.id} post={post} mode={mode} />
      ))}
    </div>
  );
}
