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
  readonly quoteTarget: AppPost | null;
  readonly onQuoteTargetChange: (post: AppPost | null) => void;
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

export function HomeScreen({ mode, explainerVisible, quoteTarget, onQuoteTargetChange }: HomeScreenProps) {
  const s = useAppStore();
  const [composerText, setComposerText] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);
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
      onQuoteTargetChange(null);
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
          onCancelContext={() => onQuoteTargetChange(null)}
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
                  onQuoteTargetChange(target);
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

      <ReportPostDialog postId={reportPostId} onClose={() => setReportPostId(null)} />
    </div>
  );
}
