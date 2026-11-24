import type { ComponentProps } from "react";
import { Flag, MessageSquare, MoreHorizontal, ShieldBan, VolumeX } from "lucide-react";
import { cn, focusRing, inactive } from "../lib/cn.ts";
import type { AgentLogoKey } from "../lib/hosts.ts";
import { AgentMark } from "./AgentMark.tsx";
import { Avatar } from "./Avatar.tsx";
import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./DropdownMenu.tsx";
import type { UiMode } from "./ModeToggle.tsx";

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
  /** Toggles mute state. */
  onMuteToggle?: () => void;
  /** Toggles block state. */
  onBlockToggle?: () => void;
  /** Opens the report workflow for this account. */
  onReport?: () => void;
  /** Opens profile editing on own profile. */
  onEditProfile?: () => void;
  /** Opens the followers list when the Followers count is clicked. */
  onOpenFollowers?: () => void;
  /** Opens the following list when the Following count is clicked. */
  onOpenFollowing?: () => void;
  /** Shows loading state on the primary follow/edit button. */
  loading?: boolean;
  /** Disables profile action buttons. */
  disabled?: boolean;
};

/** X-style profile header with parody/agent attribution badges, moderation menu, and `SocialMode` balance hiding. */
export function ProfileHeader({
  profile,
  mode = "GameMode",
  onFollowToggle,
  onMessage,
  onMuteToggle,
  onBlockToggle,
  onReport,
  onEditProfile,
  onOpenFollowers,
  onOpenFollowing,
  loading = false,
  disabled = false,
  className,
  ...props
}: ProfileHeaderProps) {
  const isGame = mode === "GameMode";
  const blocked = disabled || loading;

  return (
    <section aria-label={`${profile.displayName} profile`} className={cn("border-b border-border bg-card text-card-foreground", className)} {...props}>
      <div className="h-28 w-full overflow-hidden bg-muted sm:h-36">
        {profile.bannerUrl ? <img src={profile.bannerUrl} alt="" className="size-full object-cover" /> : null}
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="-mt-10 flex items-end justify-between gap-3">
          <Avatar name={profile.displayName} src={profile.avatarUrl} size="xl" className="border-4 border-card" />
          <div className="flex flex-wrap items-center gap-2 pt-2">
            {profile.isOwnProfile ? (
              onEditProfile ? (
                <Button variant="outline" size="sm" loading={loading} disabled={blocked} onClick={() => !blocked && onEditProfile()}>
                  Edit profile
                </Button>
              ) : null
            ) : (
              <>
                {onMessage ? (
                  <Button variant="outline" size="icon" aria-label={`Message ${profile.displayName}`} disabled={blocked} onClick={() => !blocked && onMessage()}>
                    <MessageSquare aria-hidden className="size-4" />
                  </Button>
                ) : null}
                {onFollowToggle ? (
                  <Button
                    variant={profile.isFollowing ? "outline" : "primary"}
                    size="sm"
                    loading={loading}
                    disabled={blocked}
                    onClick={() => !blocked && onFollowToggle()}
                  >
                    {profile.isFollowing ? "Following" : "Follow"}
                  </Button>
                ) : null}
                {onMuteToggle || onBlockToggle || onReport ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" aria-label={`More actions for @${profile.handle}`} disabled={blocked}>
                        <MoreHorizontal aria-hidden className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {onMuteToggle ? (
                        <DropdownMenuItem onSelect={() => !blocked && onMuteToggle()}>
                          <VolumeX aria-hidden className="size-4" />
                          {profile.isMuted ? "Unmute" : "Mute"} @{profile.handle}
                        </DropdownMenuItem>
                      ) : null}
                      {onReport ? (
                        <DropdownMenuItem onSelect={() => !blocked && onReport()}>
                          <Flag aria-hidden className="size-4" />
                          Report account
                        </DropdownMenuItem>
                      ) : null}
                      {onBlockToggle ? (
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
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-foreground">{profile.displayName}</h2>
            {profile.isNpcParody ? <Badge variant="info">AI parody</Badge> : null}
            {profile.connectedClient ? (
              <Badge variant="outline">
                {profile.connectedAgentMark ? <AgentMark agent={profile.connectedAgentMark} size="sm" /> : null}
                <span>Agent: {profile.connectedClient}</span>
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

        {profile.bio ? <p className="text-sm text-foreground">{profile.bio}</p> : null}

        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
          {onOpenFollowing ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => !blocked && onOpenFollowing()}
              className={cn(focusRing, inactive, "rounded-sm hover:underline")}
            >
              <strong className="font-mono font-semibold text-foreground tabular-nums">{profile.followingCount}</strong> Following
            </button>
          ) : (
            <span>
              <strong className="font-mono font-semibold text-foreground tabular-nums">{profile.followingCount}</strong> Following
            </span>
          )}
          {onOpenFollowers ? (
            <button
              type="button"
              disabled={blocked}
              onClick={() => !blocked && onOpenFollowers()}
              className={cn(focusRing, inactive, "rounded-sm hover:underline")}
            >
              <strong className="font-mono font-semibold text-foreground tabular-nums">{profile.followersCount}</strong> Followers
            </button>
          ) : (
            <span>
              <strong className="font-mono font-semibold text-foreground tabular-nums">{profile.followersCount}</strong> Followers
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
