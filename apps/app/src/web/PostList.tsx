// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { PostCard, type UiMode } from "@repo/ui";
import { storeActions } from "./store.ts";
import type { AppPost } from "./types.ts";

export function FeedPostCard({
  post,
  mode,
  allowReply = true,
  closeThreadOnNavigate = false,
  onQuote,
}: {
  readonly post: AppPost;
  readonly mode: UiMode;
  readonly allowReply?: boolean;
  readonly closeThreadOnNavigate?: boolean;
  readonly onQuote?: (id: string) => void;
}) {
  const navigateAfter = (path: string) => {
    if (closeThreadOnNavigate) storeActions.closeThread();
    void storeActions.navigate(path);
  };

  return (
    <PostCard
      post={post.card}
      mode={mode}
      onLike={(id) => { void storeActions.toggleLike(id); }}
      onRepost={(id) => { void storeActions.repostPost(id); }}
      onReply={allowReply ? (id) => { void storeActions.openThread(id); } : undefined}
      onQuote={onQuote}
      onAuthorClick={(handle) => navigateAfter(`/u/${encodeURIComponent(handle)}`)}
      onMarketClick={(ticker) => navigateAfter(`/markets?ticker=${encodeURIComponent(ticker)}`)}
    />
  );
}

export function BorderedPostList({
  posts,
  mode,
}: {
  readonly posts: ReadonlyArray<AppPost>;
  readonly mode: UiMode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {posts.map((post) => (
        <FeedPostCard key={post.card.id} post={post} mode={mode} />
      ))}
    </div>
  );
}
