// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { useState, type FormEvent } from "react";
import {
  Alert,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  PositionRow,
  PostCard,
  ProfileHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type UiMode,
} from "@repo/ui";
import { storeActions, useAppStore } from "../store.ts";

export function ProfileScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [tab, setTab] = useState<"posts" | "positions">("posts");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const isGame = mode === "GameMode";
  const bundle = s.profileBundle;

  const handleReport = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!bundle || !reportReason.trim()) return;
    setReportBusy(true);
    const ok = await storeActions.submitReport("account", bundle.id, reportReason.trim());
    setReportBusy(false);
    if (ok) {
      setReportReason("");
      setReportOpen(false);
    }
  };

  if (s.profileLoading && !bundle) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-44" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (!bundle) {
    return (
      <EmptyState title="Profile not found">
        <Button variant="outline" onClick={() => { void storeActions.navigate("/"); }}>
          Back to Feed
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col">
      <ProfileHeader
        profile={bundle.summary}
        mode={mode}
        onFollowToggle={() => { void storeActions.toggleFollow(bundle.summary.handle, bundle.summary.isFollowing); }}
        onMessage={() => { void storeActions.startDirectChat(bundle.summary.handle); }}
        onMuteToggle={s.viewer ? () => { void storeActions.toggleMute(bundle.summary.handle); } : undefined}
        onBlockToggle={s.viewer ? () => { void storeActions.toggleBlock(bundle.summary.handle); } : undefined}
        onReport={s.viewer ? () => setReportOpen(true) : undefined}
      />

      {bundle.viewerBlockedBy ? (
        <Alert variant="warn" className="m-4">
          This account has restricted who can view their posts.
        </Alert>
      ) : null}

      <div className="p-4">
        <Tabs
          value={isGame ? tab : "posts"}
          onValueChange={(next) => setTab(next === "positions" ? "positions" : "posts")}
        >
          <TabsList className={isGame ? "grid w-full grid-cols-2" : "grid w-full grid-cols-1"}>
            <TabsTrigger value="posts">Posts ({bundle.posts.length})</TabsTrigger>
            {isGame ? <TabsTrigger value="positions">Positions ({bundle.positions.length})</TabsTrigger> : null}
          </TabsList>

          <TabsContent value="posts">
            {bundle.posts.length === 0 ? (
              <EmptyState title="No posts yet" />
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {bundle.posts.map((post) => (
                  <PostCard
                    key={post.card.id}
                    post={post.card}
                    mode={mode}
                    onLike={(id) => { void storeActions.toggleLike(id); }}
                    onRepost={(id) => { void storeActions.repostPost(id); }}
                    onReply={(id) => { void storeActions.openThread(id); }}
                    onAuthorClick={(h) => { void storeActions.navigate(`/u/${encodeURIComponent(h)}`); }}
                    onMarketClick={(t) => { void storeActions.navigate(`/markets?ticker=${encodeURIComponent(t)}`); }}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          {isGame ? (
            <TabsContent value="positions">
              {bundle.positions.length === 0 ? (
                <EmptyState title="No open positions" />
              ) : (
                <Card className="gap-0 overflow-hidden p-0">
                  {bundle.positions.map((pos) => (
                    <PositionRow key={pos.row.id} position={pos.row} />
                  ))}
                </Card>
              )}
            </TabsContent>
          ) : null}
        </Tabs>
      </div>

      <Dialog open={reportOpen} onOpenChange={setReportOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Report @{bundle.summary.handle}</DialogTitle>
          <DialogDescription>Describe the safety or policy issue.</DialogDescription>
          <form onSubmit={(e) => { void handleReport(e); }} className="flex flex-col gap-3">
            <Textarea
              aria-label="Report reason"
              placeholder="Explain what happened..."
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
            />
            <Button type="submit" variant="destructive" loading={reportBusy} disabled={!reportReason.trim()}>
              Submit report
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
