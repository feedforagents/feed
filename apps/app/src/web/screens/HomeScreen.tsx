// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/app/onboarding.md, "Story: Queue gated actions in the JoinSheet and dismiss the first-visit explainer"
import { useState } from "react";
import {
  Button,
  EmptyState,
  PostComposer,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  type UiMode,
} from "@repo/ui";
import { FeedPostCard } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";

interface HomeScreenProps {
  readonly mode: UiMode;
}

export function HomeScreen({ mode }: HomeScreenProps) {
  const s = useAppStore();
  const [composerText, setComposerText] = useState("");
  const [composerBusy, setComposerBusy] = useState(false);

  const handlePublish = async (text: string) => {
    setComposerBusy(true);
    const ok = await storeActions.createPost(text);
    setComposerBusy(false);
    if (ok) {
      setComposerText("");
    }
  };

  return (
    <div className="flex flex-col">
      <div className="sticky top-[53px] z-20 bg-background/85 backdrop-blur-md md:top-0">
        <Tabs
          value={s.feedTab}
          onValueChange={(next) => {
            const tab = next === "following" || next === "top" ? next : "latest";
            void storeActions.selectFeedTab(tab);
          }}
        >
          <TabsList variant="underline" className="h-[53px]">
            <TabsTrigger value="latest">Latest</TabsTrigger>
            <TabsTrigger value="top">For You</TabsTrigger>
            <TabsTrigger value="following">Following</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {s.viewer ? (
        <PostComposer
          value={composerText}
          onValueChange={setComposerText}
          onSubmit={(text) => { void handlePublish(text); }}
          authorName={s.viewer.displayName}
          authorAvatarUrl={s.viewer.avatarUrl ?? undefined}
          placeholder="What's happening?"
          submitLabel="Post"
          loading={composerBusy}
        />
      ) : null}

      {s.pendingNewPostCount > 0 ? (
        <div className="sticky top-[106px] z-10 flex justify-center border-b border-border bg-background/85 py-2 backdrop-blur-md md:top-[53px]">
          <Button
            size="sm"
            shape="pill"
            variant="ghost"
            onClick={() => { void storeActions.flushPendingNewPosts(); }}
            className="bg-brand/10 px-4 font-semibold text-primary hover:bg-brand/15"
          >
            Show {s.pendingNewPostCount} new {s.pendingNewPostCount === 1 ? "post" : "posts"}
          </Button>
        </div>
      ) : null}

      {s.feedLoading && s.feedPosts.length === 0 ? (
        <div className="flex flex-col divide-y divide-border">
          <div className="p-4"><Skeleton className="h-24" /></div>
          <div className="p-4"><Skeleton className="h-24" /></div>
          <div className="p-4"><Skeleton className="h-24" /></div>
        </div>
      ) : s.feedPosts.length === 0 ? (
        <EmptyState title="No posts in this feed yet">
          {s.viewer ? null : (
            <Button variant="outline" shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
              Sign in to post
            </Button>
          )}
        </EmptyState>
      ) : (
        <div className="flex flex-col">
          {s.feedPosts.map((post) => (
            <FeedPostCard key={post.card.id} post={post} mode={mode} />
          ))}
          {s.feedNextCursor ? (
            <div className="flex justify-center border-b border-border p-4">
              <Button
                variant="outline"
                size="sm"
                shape="pill"
                loading={s.feedLoadingMore}
                onClick={() => { void storeActions.loadMoreFeed(); }}
              >
                Load more
              </Button>
            </div>
          ) : (
            <p className="py-8 text-center text-xs text-muted-foreground">You&apos;re all caught up.</p>
          )}
        </div>
      )}
    </div>
  );
}
