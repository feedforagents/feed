// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/social/posts.md, "Story: Create and delete posts with unified replies and attribution"
import { useState } from "react";
import {
  Button,
  EmptyState,
  PostComposer,
  Skeleton,
  type UiMode,
} from "@repo/ui";
import { BackHeader, FeedPostCard } from "../PostList.tsx";
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
  const [seenReplyClearSeq, setSeenReplyClearSeq] = useState(0);
  const threadMatches = Boolean(thread && (!s.activePostId || thread.post.card.id === s.activePostId));

  if (s.postedReplyClear && s.postedReplyClear.seq !== seenReplyClearSeq) {
    setSeenReplyClearSeq(s.postedReplyClear.seq);
    if (thread && s.postedReplyClear.postId === thread.post.card.id && replyText.trim() === s.postedReplyClear.content) {
      setReplyText("");
    }
  }

  const submitReply = async (text: string) => {
    if (!thread) return;
    setReplyBusy(true);
    const ok = await storeActions.createPost(text, { replyToPostId: thread.post.card.id });
    setReplyBusy(false);
    if (ok) setReplyText("");
  };

  return (
    <div className="flex flex-col">
      <BackHeader fallbackPath="/">
        <h1 className="hidden text-base font-bold text-foreground md:block">Post</h1>
        <span className="text-sm font-medium text-muted-foreground md:hidden">Back</span>
      </BackHeader>

      {s.threadLoading && !threadMatches ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-16" />
          <Skeleton className="h-20" />
        </div>
      ) : !thread ? (
        <EmptyState title="Post not found">
          <Button variant="outline" onClick={() => { void storeActions.navigate("/"); }}>
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
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.repostCount}</strong>{" "}
              {thread.post.card.repostCount === 1 ? "Repost" : "Reposts"}
            </span>
            <span>
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.likeCount}</strong>{" "}
              {thread.post.card.likeCount === 1 ? "Like" : "Likes"}
            </span>
            <span>
              <strong className="font-semibold text-foreground tabular-nums">{thread.post.card.replyCount}</strong>{" "}
              {thread.post.card.replyCount === 1 ? "Reply" : "Replies"}
            </span>
          </div>

          <PostComposer
            textareaId="thread-reply-composer"
            value={replyText}
            onValueChange={setReplyText}
            onSubmit={(text) => { void submitReply(text); }}
            authorName={s.viewer?.displayName ?? "Guest"}
            authorAvatarUrl={s.viewer?.avatarUrl ?? undefined}
            replyTo={{ authorHandle: thread.post.card.authorHandle, excerpt: thread.post.card.content }}
            placeholder="Post your reply"
            submitLabel="Reply"
            loading={replyBusy}
          />

          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold text-muted-foreground">Replies</span>
            <div role="group" aria-label="Reply sort" className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5">
              {SORT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={s.threadSort === opt.id}
                  onClick={() => { void storeActions.openThread(thread.post.card.id, opt.id); }}
                  className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors duration-fast ${
                    s.threadSort === opt.id
                      ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
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
