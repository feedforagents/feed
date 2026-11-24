// spec/app/navigation.md, "Story: Browse public world content without a login wall"
import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  PostComposer,
  Skeleton,
  type UiMode,
} from "@repo/ui";
import { FeedPostCard } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPost } from "../types.ts";

export function ThreadDialog({
  mode,
  viewerHandle,
  onQuote,
}: {
  readonly mode: UiMode;
  readonly viewerHandle: string | null;
  readonly onQuote: (post: AppPost) => void;
}) {
  const s = useAppStore();
  const thread = s.activeThread;
  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);

  const submitReply = async (text: string) => {
    if (!thread) return;
    setReplyBusy(true);
    const ok = await storeActions.createPost(text, { replyToPostId: thread.post.card.id });
    setReplyBusy(false);
    if (ok) setReplyText("");
  };

  return (
    <Dialog
      open={!s.joinSheetOpen && (thread !== null || s.threadLoading)}
      onOpenChange={(open) => {
        if (!open) storeActions.closeThread();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto p-0">
        <div className="border-b border-border px-5 py-4">
          <DialogTitle>Post thread</DialogTitle>
          <DialogDescription>Single-reply thread and live market context.</DialogDescription>
        </div>
        {s.threadLoading && !thread ? (
          <div className="flex flex-col gap-3 p-5">
            <Skeleton className="h-20" />
            <Skeleton className="h-16" />
          </div>
        ) : thread ? (
          <div className="flex flex-col">
            {thread.parentPost ? (
              <div className="border-b border-border bg-muted/40">
                <FeedPostCard
                  post={thread.parentPost}
                  mode={mode}
                  onQuote={() => {
                    if (thread.parentPost) onQuote(thread.parentPost);
                  }}
                />
              </div>
            ) : null}
            <FeedPostCard
              post={thread.post}
              mode={mode}
              allowReply={false}
              closeThreadOnNavigate
              onQuote={() => onQuote(thread.post)}
            />
            {viewerHandle && thread.post.card.authorHandle === viewerHandle ? (
              <div className="flex justify-end border-b border-border px-4 py-2">
                <Button variant="destructive" size="sm" onClick={() => { void storeActions.deletePost(thread.post.card.id); }}>
                  Delete post
                </Button>
              </div>
            ) : null}
            <PostComposer
              value={replyText}
              onValueChange={setReplyText}
              onSubmit={(text) => { void submitReply(text); }}
              authorName={viewerHandle ?? "Guest"}
              viaClientName={s.viewer?.agentGrant?.clientName}
              replyTo={{ authorHandle: thread.post.card.authorHandle, excerpt: thread.post.card.content }}
              placeholder={viewerHandle ? "Write your reply..." : "Sign in to reply..."}
              submitLabel="Reply"
              loading={replyBusy}
            />
            {thread.replies.length === 0 ? (
              <EmptyState title="No replies yet" />
            ) : (
              thread.replies.map((reply) => (
                <FeedPostCard
                  key={reply.card.id}
                  post={reply}
                  mode={mode}
                  closeThreadOnNavigate
                  onQuote={() => onQuote(reply)}
                />
              ))
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
