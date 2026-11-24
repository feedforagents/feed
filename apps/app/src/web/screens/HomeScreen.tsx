// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  PostComposer,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  type PostComposerContext,
  type UiMode,
} from "@repo/ui";
import { FeedPostCard, ReportPostDialog } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";
import type { AppPost } from "../types.ts";

interface HomeScreenProps {
  readonly mode: UiMode;
  readonly explainerVisible: boolean;
}

function FirstVisitExplainer({ onDismiss, onHowToPlay }: { readonly onDismiss: () => void; readonly onHowToPlay: () => void }) {
  return (
    <Card className="m-4 gap-3 border-primary/40 p-4">
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <CardTitle>Twitter with markets, played from your own AI</CardTitle>
            <Badge variant="info">Virtual pts</Badge>
          </div>
          <CardDescription>
            Follow parody market characters, trade YES/NO odds and 20x perps with 100 starting pts, or connect one AI agent.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </CardHeader>
      <CardFooter className="justify-start">
        <Button variant="outline" size="sm" onClick={onHowToPlay}>
          How to Play
        </Button>
      </CardFooter>
    </Card>
  );
}

function ThreadDialog({
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

export function HomeScreen({ mode, explainerVisible }: HomeScreenProps) {
  const s = useAppStore();
  const [composerText, setComposerText] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
  const [quoteTarget, setQuoteTarget] = useState<AppPost | null>(null);
  const [reportPostId, setReportPostId] = useState<string | null>(null);

  const quoteContext: PostComposerContext | undefined = quoteTarget
    ? { authorHandle: quoteTarget.card.authorHandle, excerpt: quoteTarget.card.content }
    : undefined;

  const handlePublish = async (text: string) => {
    setComposerBusy(true);
    const ok = await storeActions.createPost(text, quoteTarget ? { quotePostId: quoteTarget.card.id } : undefined);
    setComposerBusy(false);
    if (ok) {
      setComposerText("");
      setQuoteTarget(null);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-4 py-2.5">
        <Tabs
          value={s.feedTab}
          onValueChange={(next) => {
            const tab = next === "following" || next === "top" ? next : "latest";
            void storeActions.selectFeedTab(tab);
          }}
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="latest">Latest</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger>
            <TabsTrigger value="top">Top</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {explainerVisible ? (
        <FirstVisitExplainer
          onDismiss={storeActions.dismissExplainer}
          onHowToPlay={() => { void storeActions.navigate("/how-to-play"); }}
        />
      ) : null}

      {s.viewer ? (
        <PostComposer
          value={composerText}
          onValueChange={setComposerText}
          onSubmit={(text) => { void handlePublish(text); }}
          authorName={s.viewer.displayName}
          authorAvatarUrl={s.viewer.avatarUrl ?? undefined}
          viaClientName={s.viewer.agentGrant?.clientName}
          quotePost={quoteContext}
          onCancelContext={() => setQuoteTarget(null)}
          loading={composerBusy}
        />
      ) : null}

      {s.feedLoading && s.feedPosts.length === 0 ? (
        <div className="flex flex-col gap-4 p-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : s.feedPosts.length === 0 ? (
        <EmptyState title="No posts in this feed yet">
          {s.viewer ? null : (
            <Button variant="outline" onClick={() => storeActions.openJoinSheet("phone")}>
              Sign in to post
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {s.feedPosts.map((post) => (
            <div key={post.card.id} className="flex flex-col">
              <FeedPostCard
                post={post}
                mode={mode}
                onQuote={(id) => {
                  const target = s.feedPosts.find((p) => p.card.id === id) ?? null;
                  if (!s.viewer) {
                    storeActions.openJoinSheet("phone");
                    return;
                  }
                  setQuoteTarget(target);
                }}
                onReport={s.viewer && post.card.authorHandle !== s.viewer.handle ? (id) => setReportPostId(id) : undefined}
              />
            </div>
          ))}
          {s.feedNextCursor ? (
            <div className="flex justify-center p-4">
              <Button
                variant="outline"
                size="sm"
                loading={s.feedLoadingMore}
                onClick={() => { void storeActions.loadMoreFeed(); }}
              >
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <ThreadDialog
        mode={mode}
        viewerHandle={s.viewer?.handle ?? null}
        onQuote={(post) => {
          storeActions.closeThread();
          setQuoteTarget(post);
        }}
      />

      <ReportPostDialog postId={reportPostId} onClose={() => setReportPostId(null)} />
    </div>
  );
}
