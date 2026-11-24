// spec/social/posts.md, "Story: Like, repost, follow, and block enforcement"
import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  PostCard,
  Textarea,
  type UiMode,
} from "@repo/ui";
import { storeActions, useAppStore } from "./store.ts";
import type { AppPost } from "./types.ts";

export function ReportPostDialog({
  postId,
  onClose,
}: {
  readonly postId: string | null;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!postId || !reason.trim()) return;
    setBusy(true);
    const ok = await storeActions.submitReport("post", postId, reason.trim());
    setBusy(false);
    if (ok) {
      setReason("");
      onClose();
    }
  };

  return (
    <Dialog
      open={postId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogTitle>Report post</DialogTitle>
        <DialogDescription>Describe the safety or policy issue with this post.</DialogDescription>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-3">
          <Textarea
            aria-label="Report reason"
            placeholder="Explain what happened..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button type="submit" variant="destructive" loading={busy} disabled={!reason.trim()}>
            Submit report
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function FeedPostCard({
  post,
  mode,
  allowReply = true,
  closeThreadOnNavigate = false,
  onQuote,
  onReport,
}: {
  readonly post: AppPost;
  readonly mode: UiMode;
  readonly allowReply?: boolean;
  readonly closeThreadOnNavigate?: boolean;
  readonly onQuote?: (id: string) => void;
  readonly onReport?: (id: string) => void;
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
      onReport={onReport}
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
  const s = useAppStore();
  const [reportPostId, setReportPostId] = useState<string | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        {posts.map((post) => (
          <FeedPostCard
            key={post.card.id}
            post={post}
            mode={mode}
            onReport={s.viewer && post.card.authorHandle !== s.viewer.handle ? (id) => setReportPostId(id) : undefined}
          />
        ))}
      </div>
      <ReportPostDialog postId={reportPostId} onClose={() => setReportPostId(null)} />
    </>
  );
}
