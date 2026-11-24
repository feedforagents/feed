// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { useState } from "react";
import {
  Button,
  EmptyState,
  PostComposer,
  Skeleton,
  type UiMode,
} from "@repo/ui";
import { ArrowLeftIcon } from "../icons.tsx";
import { FeedPostCard } from "../PostList.tsx";
import type { ThreadReplySort } from "../store-core.ts";
import { storeActions, useAppStore } from "../store.ts";
import { formatFullTimestamp } from "../types.ts";

const SORT_OPTIONS: ReadonlyArray<{ readonly id: ThreadReplySort; readonly label: string }> = [
  { id: "popular", label: "Popular" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
];

export function PostDetailScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const thread = s.activeThread;
  const [replyText, setReplyText] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    void storeActions.navigate("/");
  };

  const submitReply = async (text: string) => {
    if (!thread) return;
    setReplyBusy(true);
    const ok = await storeActions.createPost(text, { replyToPostId: thread.post.card.id });
    setReplyBusy(false);
    if (ok) setReplyText("");
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <Button variant="ghost" size="icon" shape="pill" aria-label="Back" onClick={handleBack} className="-ml-2">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <h1 className="text-base font-bold text-foreground">Post</h1>
      </header>

      {s.threadLoading && !thread ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-16" />
          <Skeleton className="h-20" />
        </div>
      ) : !thread ? (
        <EmptyState title="Post not found">
          <Button variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/"); }}>
            Back to Home
          </Button>
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {thread.ancestors.map((ancestor) => (
            <div key={ancestor.card.id} className="relative">
              <div
                aria-hidden
                className="pointer-events-none absolute top-14 bottom-0 left-[35px] z-10 w-0.5 bg-border"
              />
              <FeedPostCard post={ancestor} mode={mode} />
            </div>
          ))}

          <FeedPostCard
            post={thread.post}
            mode={mode}
            variant="detail"
            onReply={() => {
              const input = document.getElementById("thread-reply-composer");
              if (input) input.focus();
            }}
          />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
            {thread.post.createdAtMs > 0 ? (
              <span>{formatFullTimestamp(thread.post.createdAtMs)}</span>
            ) : null}
            <span>
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.repostCount}</strong> Reposts
            </span>
            <span>
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.likeCount}</strong> Likes
            </span>
            <span>
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.replyCount}</strong> Replies
            </span>
          </div>

          <PostComposer
            value={replyText}
            onValueChange={setReplyText}
            onSubmit={(text) => { void submitReply(text); }}
            authorName={s.viewer?.displayName ?? "Guest"}
            authorAvatarUrl={s.viewer?.avatarUrl ?? undefined}
            viaClientName={s.viewer?.agentGrant?.clientName}
            replyTo={{ authorHandle: thread.post.card.authorHandle, excerpt: thread.post.card.content }}
            placeholder="Post your reply"
            submitLabel="Reply"
            loading={replyBusy}
          />

          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold text-muted-foreground">Replies</span>
            <div className="flex items-center gap-1.5">
              {SORT_OPTIONS.map((opt) => (
                <Button
                  key={opt.id}
                  size="sm"
                  shape="pill"
                  variant={s.threadSort === opt.id ? "primary" : "ghost"}
                  onClick={() => { void storeActions.openThread(thread.post.card.id, opt.id); }}
                  className="h-7 px-3 text-xs"
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>

          {thread.replies.length === 0 ? (
            <EmptyState title="No replies yet" />
          ) : (
            <div className="flex flex-col">
              {thread.replies.map((reply) => (
                <FeedPostCard key={reply.card.id} post={reply} mode={mode} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
