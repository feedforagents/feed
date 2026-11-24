// spec/app/navigation.md, "Story: Browse public world content without a login wall"; spec/social/moderation.md, "Story: Block, mute, follow, and report users or posts"
import { useState, type FormEvent } from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
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
  TabsList,
  TabsTrigger,
  Textarea,
  VerifiedBadge,
  type UiMode,
} from "@repo/ui";
import { ArrowLeftIcon } from "../icons.tsx";
import { FlatPostList } from "../PostList.tsx";
import { storeActions, useAppStore } from "../store.ts";

export const PRESET_AVATARS = [
  "/assets/user-pfps/pfp-001.jpg",
  "/assets/user-pfps/pfp-002.jpg",
  "/assets/user-pfps/pfp-003.jpg",
  "/assets/user-pfps/pfp-004.jpg",
  "/assets/user-pfps/pfp-005.jpg",
  "/assets/user-pfps/pfp-006.jpg",
  "/assets/user-pfps/pfp-007.jpg",
  "/assets/user-pfps/pfp-010.jpg",
] as const;

export const PRESET_BANNERS = [
  "/assets/user-banners/banner-1.jpg",
  "/assets/user-banners/banner-10.jpg",
  "/assets/user-banners/banner-11.jpg",
  "/assets/user-banners/banner-12.jpg",
  "/assets/user-banners/banner-13.jpg",
  "/assets/user-banners/banner-14.jpg",
] as const;

type ProfileTab = "posts" | "replies" | "likes" | "trades" | "positions";

function FollowListDialog() {
  const s = useAppStore();
  const open = s.followListKind !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) storeActions.closeFollowList();
      }}
    >
      <DialogContent className="max-h-[80vh] max-w-md overflow-hidden p-0">
        <div className="border-b border-border px-4 py-3">
          <DialogTitle>
            {s.followListKind === "followers" ? "Followers" : "Following"}
            {s.followListHandle ? ` · @${s.followListHandle}` : ""}
          </DialogTitle>
          <DialogDescription className="sr-only">Account follow list</DialogDescription>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {s.followListLoading ? (
            <div className="flex flex-col gap-3 p-4">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : s.followListItems.length === 0 ? (
            <EmptyState title={s.followListKind === "followers" ? "No followers yet" : "Not following anyone yet"} />
          ) : (
            <div className="divide-y divide-border">
              {s.followListItems.map((entry) => {
                const isSelf = s.viewer?.handle.toLowerCase() === entry.handle.toLowerCase();
                return (
                  <div key={`${entry.kind}:${entry.id}`} className="flex items-center justify-between gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        storeActions.closeFollowList();
                        void storeActions.navigate(`/u/${encodeURIComponent(entry.handle)}`);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                    >
                      <Avatar name={entry.displayName} src={entry.avatarUrl ?? undefined} seed={entry.handle} size="sm" />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1 text-sm font-bold text-foreground hover:underline">
                          <span className="truncate">{entry.displayName}</span>
                          {entry.isParody ? <VerifiedBadge size="sm" /> : null}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">@{entry.handle}</span>
                      </span>
                    </button>
                    {!isSelf ? (
                      <Button
                        size="sm"
                        shape="pill"
                        variant={entry.viewerFollows ? "outline" : "primary"}
                        onClick={() => { void storeActions.toggleFollow(entry.handle, entry.viewerFollows); }}
                      >
                        {entry.viewerFollows ? "Following" : "Follow"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditProfileDialog({
  open,
  onOpenChange,
  initialDisplayName,
  initialBio,
  initialAvatarUrl,
  initialBannerUrl,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialDisplayName: string;
  readonly initialBio: string;
  readonly initialAvatarUrl: string;
  readonly initialBannerUrl: string;
}) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [bio, setBio] = useState(initialBio);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [bannerUrl, setBannerUrl] = useState(initialBannerUrl);
  const [busy, setBusy] = useState(false);

  const handleSave = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmedName = displayName.trim();
    if (!trimmedName) return;
    setBusy(true);
    const ok = await storeActions.updateOwnProfile({
      displayName: trimmedName,
      bio: bio.trim(),
      avatarUrl: avatarUrl.trim() || null,
      bannerUrl: bannerUrl.trim() || null,
    });
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogTitle>Edit profile</DialogTitle>
        <DialogDescription>Update your display name, bio, avatar, and banner.</DialogDescription>
        <form onSubmit={(e) => { void handleSave(e); }} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-profile-name">Display name</Label>
            <Input
              id="edit-profile-name"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-profile-bio">Bio</Label>
            <Textarea
              id="edit-profile-bio"
              maxLength={280}
              placeholder="Write a short bio..."
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Avatar preset</span>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {PRESET_AVATARS.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setAvatarUrl(url)}
                  className={`overflow-hidden rounded-full border-2 p-0.5 transition-colors ${avatarUrl === url ? "border-brand" : "border-transparent hover:border-border"}`}
                >
                  <img src={url} alt="" className="size-10 rounded-full object-cover" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-muted-foreground">Banner preset</span>
            <div className="grid grid-cols-3 gap-2">
              {PRESET_BANNERS.map((url) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setBannerUrl(url)}
                  className={`overflow-hidden rounded-lg border-2 transition-colors ${bannerUrl === url ? "border-brand" : "border-border hover:border-foreground/40"}`}
                >
                  <img src={url} alt="" className="h-12 w-full object-cover" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" size="sm" shape="pill" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" shape="pill" loading={busy} disabled={!displayName.trim()}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProfileScreen({ mode }: { readonly mode: UiMode }) {
  const s = useAppStore();
  const [tab, setTab] = useState<ProfileTab>("posts");
  const [editOpen, setEditOpen] = useState(false);
  const isGame = mode === "GameMode";
  const bundle = s.profileBundle;

  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
      return;
    }
    void storeActions.navigate("/");
  };

  if (!s.viewer && !s.profileHandle && !bundle) {
    return (
      <div className="flex flex-col">
        <header className="sticky top-[53px] z-20 flex h-[53px] items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
          <h1 className="text-base font-bold text-foreground">Profile</h1>
        </header>
        <EmptyState title="Sign in to view your profile">
          <Button shape="pill" onClick={() => storeActions.openJoinSheet("phone")}>
            Sign in
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (s.profileLoading && !bundle) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-48" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (!bundle) {
    return (
      <EmptyState title="Profile not found">
        <Button variant="outline" shape="pill" onClick={() => { void storeActions.navigate("/"); }}>
          Back to Feed
        </Button>
      </EmptyState>
    );
  }

  const activeTab: ProfileTab = !isGame && (tab === "trades" || tab === "positions") ? "posts" : tab;
  const topLevelPosts = bundle.posts.filter((p) => !p.replyToPostId);
  const replyPosts = s.profileReplies.length > 0 ? s.profileReplies : bundle.posts.filter((p) => Boolean(p.replyToPostId));
  const likedPosts = bundle.posts.filter((p) => Boolean(p.card.liked));
  const openPositions = bundle.positions.filter((p) => !p.isClosed);
  const closedPositions = bundle.positions.filter((p) => p.isClosed);
  const orgTicker = bundle.orgMeta?.ticker ?? null;

  const copyProfileLink = () => {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://feed.fun";
    const url = `${origin}/u/${encodeURIComponent(bundle.summary.handle)}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(url).catch(() => undefined);
    }
    storeActions.pushToast("Profile link copied.", "info");
  };

  return (
    <div className="flex flex-col">
      <header className="sticky top-[53px] z-20 flex h-[53px] items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur-md md:top-0">
        <Button variant="ghost" size="icon" shape="pill" aria-label="Back" onClick={handleBack} className="-ml-2">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-base leading-tight font-bold text-foreground">{bundle.summary.displayName}</h1>
          <p className="text-xs text-muted-foreground tabular-nums">
            {bundle.postsCount} {bundle.postsCount === 1 ? "post" : "posts"}
          </p>
        </div>
      </header>

      <ProfileHeader
        profile={bundle.summary}
        mode={mode}
        onFollowToggle={() => { void storeActions.toggleFollow(bundle.summary.handle, bundle.summary.isFollowing); }}
        onMessage={() => { void storeActions.startDirectChat(bundle.summary.handle); }}
        onCopyLink={copyProfileLink}
        onMuteToggle={s.viewer ? () => storeActions.openMuteDialog(bundle.summary.handle, Boolean(bundle.summary.isMuted)) : undefined}
        onBlockToggle={s.viewer ? () => storeActions.openBlockDialog(bundle.summary.handle, Boolean(bundle.summary.isBlocked)) : undefined}
        onReport={
          s.viewer
            ? () => storeActions.openReportDialog({ kind: "account", id: bundle.id, label: `@${bundle.summary.handle}` })
            : undefined
        }
        onEditProfile={bundle.summary.isOwnProfile ? () => setEditOpen(true) : undefined}
        onFollowersClick={() => { void storeActions.loadFollowList(bundle.summary.handle, "followers"); }}
        onFollowingClick={() => { void storeActions.loadFollowList(bundle.summary.handle, "following"); }}
      />

      {bundle.actorMeta && (bundle.actorMeta.tier || bundle.actorMeta.affiliations.length > 0) ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-xs">
          {bundle.actorMeta.tier ? <Badge variant="secondary">{bundle.actorMeta.tier}</Badge> : null}
          {bundle.actorMeta.affiliations.map((aff) => (
            <Badge key={aff} variant="outline">{aff}</Badge>
          ))}
        </div>
      ) : null}

      {isGame && orgTicker ? (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-card/50 px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge variant="info" className="font-mono">{`$${orgTicker}`}</Badge>
            <span className="text-xs text-muted-foreground">{bundle.orgMeta?.orgType}</span>
          </div>
          <Button
            size="sm"
            shape="pill"
            onClick={() => { void storeActions.navigate(`/markets/perps/${encodeURIComponent(orgTicker)}`); }}
          >
            {`Trade $${orgTicker}`}
          </Button>
        </div>
      ) : null}

      {bundle.viewerBlockedBy ? (
        <Alert variant="warn" className="m-4">
          This account has restricted who can view their posts.
        </Alert>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(next) => {
          if (next === "posts" || next === "replies" || next === "likes" || next === "trades" || next === "positions") {
            setTab(next);
            if (next === "replies") {
              void storeActions.loadProfileReplies(bundle.summary.handle);
            }
          }
        }}
      >
        <TabsList variant="underline">
          <TabsTrigger value="posts">Posts</TabsTrigger>
          <TabsTrigger value="replies">Replies</TabsTrigger>
          <TabsTrigger value="likes">Likes</TabsTrigger>
          {isGame ? <TabsTrigger value="trades">Trades</TabsTrigger> : null}
          {isGame ? <TabsTrigger value="positions">Positions</TabsTrigger> : null}
        </TabsList>
      </Tabs>

      {activeTab === "posts" ? (
        topLevelPosts.length === 0 ? (
          <EmptyState title="No posts yet" />
        ) : (
          <div className="flex flex-col">
            <FlatPostList posts={topLevelPosts} mode={mode} />
            {bundle.postsNextCursor ? (
              <div className="flex justify-center border-b border-border p-4">
                <Button
                  variant="outline"
                  size="sm"
                  shape="pill"
                  loading={s.profileLoadingMore}
                  onClick={() => { void storeActions.loadMoreProfilePosts(); }}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )
      ) : activeTab === "replies" ? (
        s.profileRepliesLoading && replyPosts.length === 0 ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : replyPosts.length === 0 ? (
          <EmptyState title="No replies yet" />
        ) : (
          <FlatPostList posts={replyPosts} mode={mode} />
        )
      ) : activeTab === "likes" ? (
        likedPosts.length === 0 ? (
          <EmptyState title="No liked posts visible yet" />
        ) : (
          <FlatPostList posts={likedPosts} mode={mode} />
        )
      ) : activeTab === "trades" ? (
        closedPositions.length === 0 ? (
          <EmptyState title={bundle.tradeCount ? `${bundle.tradeCount} total trades recorded` : "No settled trades yet"} />
        ) : (
          <div className="divide-y divide-border">
            {closedPositions.map((pos) => (
              <PositionRow key={pos.row.id} position={pos.row} />
            ))}
          </div>
        )
      ) : openPositions.length === 0 ? (
        <EmptyState title="No open positions" />
      ) : (
        <div className="divide-y divide-border">
          {openPositions.map((pos) => (
            <PositionRow key={pos.row.id} position={pos.row} />
          ))}
        </div>
      )}

      <FollowListDialog />

      {editOpen ? (
        <EditProfileDialog
          key={`${bundle.id}:${bundle.summary.displayName}`}
          open={editOpen}
          onOpenChange={setEditOpen}
          initialDisplayName={bundle.summary.displayName}
          initialBio={bundle.summary.bio ?? ""}
          initialAvatarUrl={bundle.summary.avatarUrl ?? ""}
          initialBannerUrl={bundle.summary.bannerUrl ?? ""}
        />
      ) : null}
    </div>
  );
}
