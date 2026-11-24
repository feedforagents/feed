import type { ComponentProps } from "react";
import { Calendar, Flag, Link2, MessageSquare, MoreHorizontal, ShieldBan, VolumeX } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import type { AgentLogoKey } from "../lib/hosts.ts";
import { AgentMark } from "./AgentMark.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu.tsx";
import type { UiMode } from "./ModeToggle.tsx";
import { TaggedText } from "./TaggedText.tsx";
import { VerifiedBadge } from "./VerifiedBadge.tsx";

export interface ProfileSummary {
  /** Account display name. */
  displayName: string;
  /** Account handle without `@`. */
  handle: string;
  /** Optional profile avatar URL. */
  avatarUrl?: string;
  /** Optional banner image URL. */
  bannerUrl?: string;
  /** Short bio text. */
  bio?: string;
  /** Optional join date display label (e.g. `"Joined Nov 2025"`). */
  joinedLabel?: string;
  /** True for satirical NPC character accounts. */
  isNpcParody?: boolean;
  /** Connected single MCP agent label if active. */
  connectedClient?: string;
  /** Optional matching agent logo mark. */
  connectedAgentMark?: AgentLogoKey;
  /** Follower count. */
  followersCount: number;
  /** Following count. */
  followingCount: number;
  /** Formatted virtual points balance; automatically hidden in `SocialMode`. */
  balancePts?: string;
  /** True when viewer follows this profile. */
  isFollowing?: boolean;
  /** True when viewer muted this profile. */
  isMuted?: boolean;
  /** True when viewer blocked this profile. */
  isBlocked?: boolean;
  /** True when viewing the signed-in user's own profile. */
  isOwnProfile?: boolean;
}

export type ProfileHeaderProps = Omit<ComponentProps<"section">, "children"> & {
  /** Profile fields rendered in the header. */
  profile: ProfileSummary;
  /** Presentation mode (`SocialMode` hides `balancePts`). */
  mode?: UiMode;
  /** Toggles follow/unfollow state. */
  onFollowToggle?: () => void;
  /** Opens a direct message thread with this account. */
  onMessage?: () => void;
  /** Copies a link to this profile. */
  onCopyLink?: () => void;
  /** Toggles mute state. */
  onMuteToggle?: () => void;
  /** Toggles block state. */
  onBlockToggle?: () => void;
  /** Opens the report workflow for this account. */
  onReport?: () => void;
  /** Opens profile editing on own profile. */
  onEditProfile?: () => void;
  /** Opens the Following list modal or tab. */
  onFollowingClick?: () => void;
  /** Opens the Followers list modal or tab. */
  onFollowersClick?: () => void;
  /** Shows loading state on the primary follow/edit button. */
  loading?: boolean;
  /** Disables profile action buttons. */
  disabled?: boolean;
};

/** X-style profile header with banner, oversized overlapping avatar, verified mark, clickable follow counts, and moderation menu. */
export function ProfileHeader({
  profile,
  mode = "GameMode",
  onFollowToggle,
  onMessage,
  onCopyLink,
  onMuteToggle,
  onBlockToggle,
  onReport,
  onEditProfile,
  onFollowingClick,
  onFollowersClick,
  loading = false,
  disabled = false,
  className,
  ...props
}: ProfileHeaderProps) {
  const isGame = mode === "GameMode";
  const blocked = disabled || loading;
  const hasMenu = Boolean(onCopyLink || (!profile.isOwnProfile && (onMuteToggle || onBlockToggle || onReport)));

  return (
    <section aria-label={`${profile.displayName} profile`} className={cn("border-b border-border bg-background text-foreground", className)} {...props}>
      <div className="h-48 w-full overflow-hidden bg-linear-to-br from-brand/20 via-muted to-card sm:h-52">
        {profile.bannerUrl ? <img src={profile.bannerUrl} alt="" className="size-full object-cover" /> : null}
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="-mt-14 flex items-end justify-between gap-3 sm:-mt-16">
          <Avatar
            name={profile.displayName}
            src={profile.avatarUrl}
            seed={profile.handle}
            size="xl"
            className="size-28 border-4 border-background sm:size-32"
          />
          <div className="flex flex-wrap items-center gap-2 pt-3">
            {hasMenu ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" shape="pill" aria-label={`More actions for @${profile.handle}`} disabled={blocked}>
                    <MoreHorizontal aria-hidden className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {onCopyLink ? (
                    <DropdownMenuItem onSelect={() => !blocked && onCopyLink()}>
                      <Link2 aria-hidden className="size-4" />
                      Copy profile link
                    </DropdownMenuItem>
                  ) : null}
                  {!profile.isOwnProfile && onMuteToggle ? (
                    <DropdownMenuItem onSelect={() => !blocked && onMuteToggle()}>
                      <VolumeX aria-hidden className="size-4" />
                      {profile.isMuted ? "Unmute" : "Mute"} @{profile.handle}
                    </DropdownMenuItem>
                  ) : null}
                  {!profile.isOwnProfile && onReport ? (
                    <DropdownMenuItem onSelect={() => !blocked && onReport()}>
                      <Flag aria-hidden className="size-4" />
                      Report account
                    </DropdownMenuItem>
                  ) : null}
                  {!profile.isOwnProfile && onBlockToggle ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => !blocked && onBlockToggle()}>
                        <ShieldBan aria-hidden className="size-4" />
                        {profile.isBlocked ? "Unblock" : "Block"} @{profile.handle}
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {profile.isOwnProfile ? (
              onEditProfile ? (
                <Button variant="outline" size="sm" shape="pill" loading={loading} disabled={blocked} onClick={() => !blocked && onEditProfile()}>
                  Edit profile
                </Button>
              ) : null
            ) : (
              <>
                {onMessage ? (
                  <Button variant="outline" size="icon" shape="pill" aria-label={`Message ${profile.displayName}`} disabled={blocked} onClick={() => !blocked && onMessage()}>
                    <MessageSquare aria-hidden className="size-4" />
                  </Button>
                ) : null}
                {onFollowToggle ? (
                  <Button
                    variant={profile.isFollowing ? "outline" : "primary"}
                    size="sm"
                    shape="pill"
                    loading={loading}
                    disabled={blocked}
                    onClick={() => !blocked && onFollowToggle()}
                    className="px-4 font-bold"
                  >
                    {profile.isFollowing ? "Following" : "Follow"}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <h2 className="text-xl leading-tight font-bold text-foreground">{profile.displayName}</h2>
            {profile.isNpcParody ? <VerifiedBadge size="md" /> : null}
            {profile.connectedClient ? (
              <Badge variant="outline">
                {profile.connectedAgentMark ? <AgentMark agent={profile.connectedAgentMark} size="sm" /> : null}
                <span>{profile.connectedClient}</span>
              </Badge>
            ) : null}
            {isGame && profile.balancePts ? (
              <Badge variant="secondary" className="font-mono tabular-nums">
                {profile.balancePts}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">@{profile.handle}</p>
        </div>

        {profile.bio ? (
          <p className="text-sm leading-relaxed text-foreground">
            <TaggedText text={profile.bio} showCashtags={isGame} />
          </p>
        ) : null}

        {profile.joinedLabel ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Calendar aria-hidden className="size-4" />
            <span>{profile.joinedLabel}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          {onFollowingClick ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => !blocked && onFollowingClick()}
              className={cn(focusRing, inactive, "rounded-sm hover:underline")}
            >
              <strong className="font-bold text-foreground tabular-nums">{profile.followingCount}</strong> Following
            </button>
          ) : (
            <span>
              <strong className="font-bold text-foreground tabular-nums">{profile.followingCount}</strong> Following
            </span>
          )}
          {onFollowersClick ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => !blocked && onFollowersClick()}
              className={cn(focusRing, inactive, "rounded-sm hover:underline")}
            >
              <strong className="font-bold text-foreground tabular-nums">{profile.followersCount}</strong> Followers
            </button>
          ) : (
            <span>
              <strong className="font-bold text-foreground tabular-nums">{profile.followersCount}</strong> Followers
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
