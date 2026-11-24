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
  Input,
  Label,
  PositionRow,
  ProfileHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type UiMode,
} from "@repo/ui";
import { BorderedPostList } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";

export function ProfileScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [tab, setTab] = useState<"posts" | "positions">("posts");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editBusy, setEditBusy] = useState(false);
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

  const openEditProfile = () => {
    if (!bundle) return;
    setEditDisplayName(bundle.summary.displayName);
    setEditBio(bundle.summary.bio ?? "");
    setEditOpen(true);
  };

  const handleSaveProfile = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedName = editDisplayName.trim();
    if (!trimmedName) return;
    setEditBusy(true);
    const ok = await storeActions.updateOwnProfile({
      displayName: trimmedName,
      bio: editBio.trim(),
    });
    setEditBusy(false);
    if (ok) setEditOpen(false);
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
        onEditProfile={bundle.summary.isOwnProfile ? openEditProfile : undefined}
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
              <div className="flex flex-col gap-3">
                <BorderedPostList posts={bundle.posts} mode={mode} />
                {bundle.postsNextCursor ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={s.profileLoadingMore}
                      onClick={() => { void storeActions.loadMoreProfilePosts(); }}
                    >
                      Load more
                    </Button>
                  </div>
                ) : null}
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

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>Update your public display name and bio.</DialogDescription>
          <form onSubmit={(e) => { void handleSaveProfile(e); }} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-profile-name">Display name</Label>
              <Input
                id="edit-profile-name"
                maxLength={60}
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-profile-bio">Bio</Label>
              <Textarea
                id="edit-profile-bio"
                maxLength={280}
                placeholder="Tell Feed about your strategy..."
                value={editBio}
                onChange={(e) => setEditBio(e.target.value)}
              />
            </div>
            <Button type="submit" loading={editBusy} disabled={!editDisplayName.trim()}>
              Save changes
            </Button>
          </form>
        </DialogContent>
      </Dialog>

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
