# Moderation, notifications, and Social mode

User blocks, mutes, post and user reports, in-app notifications, unread counts, and `SocialMode` presentation filtering for Feed (`feed.fun`) per PRD §11, §12, and D-13.

## Domain

### Accounts, moderation edges, reports, and notifications

Each account stores its presentation mode (`GameMode` or `SocialMode`), open trading position count (owned by the markets domain and preserved across mode switches), and unread notification count. Reports target either a user (`UserTarget`, `targetPostId == 0`) or a specific post (`PostTarget`, `targetPostId > 0`). Notifications cover social/invite events as well as `MarketResolved` and `PnLDigest`.

```quint
type PresentationMode = GameMode | SocialMode
type ReportTargetKind = UserTarget | PostTarget
type ReportCategory = Spam | Harassment | Impersonation | OtherViolation
type ReportStatus = PendingReview | ResolvedActioned | Dismissed
type NotificationKind = SocialReply | SocialMention | SocialLike | SocialFollow | GroupInvite | MarketResolved | PnLDigest

type AccountModeration = {
  id: str,
  mode: PresentationMode,
  openPositionCount: int,
  unreadCount: int,
}
type BlockRecord = { blockerId: str, blockedId: str }
type MuteRecord = { muterId: str, mutedId: str }
type FollowRecord = { followerId: str, followingId: str }
type ModerationReport = {
  id: int,
  reporterId: str,
  targetKind: ReportTargetKind,
  targetUserId: str,
  targetPostId: int,
  category: ReportCategory,
  status: ReportStatus,
}
type Notification = {
  id: int,
  userId: str,
  actorId: str,
  notifKind: NotificationKind,
  read: bool,
}
type ModerationState = {
  accounts: List[AccountModeration],
  blocks: List[BlockRecord],
  mutes: List[MuteRecord],
  follows: List[FollowRecord],
  reports: List[ModerationReport],
  notifications: List[Notification],
  lastReportId: int,
  lastNotificationId: int,
  blocksClearedFollowsCount: int,
}
```

### Initial moderation and notification state

Accounts start in `GameMode` (D-13b), with `"alice"` and `"bob"` holding open positions (`2` and `1`) so Social-mode suppression can be verified without removing positions.

```quint
pure val initial: ModerationState = {
  accounts: List(
    { id: "alice", mode: GameMode, openPositionCount: 2, unreadCount: 0 },
    { id: "bob", mode: GameMode, openPositionCount: 1, unreadCount: 0 },
    { id: "npc1", mode: GameMode, openPositionCount: 0, unreadCount: 0 }
  ),
  blocks: List(),
  mutes: List(),
  follows: List(),
  reports: List(),
  notifications: List(),
  lastReportId: 0,
  lastNotificationId: 0,
  blocksClearedFollowsCount: 0,
}
```

### What the simulator tries

```quint
pure val byValues = Set("alice", "bob", "npc1", "system", "outsider")
pure val accountIdValues = Set("alice", "bob", "npc1", "outsider")
pure val targetIdValues = Set("alice", "bob", "npc1", "outsider")
pure val recipientIdValues = Set("alice", "bob", "npc1", "outsider")
pure val actorIdValues = Set("", "alice", "bob", "npc1", "outsider")
pure val targetUserIdValues = Set("alice", "bob", "npc1", "outsider")
pure val targetPostIdValues = Set(0, 1, 2)
```

### Shared lookups and visibility helpers

```quint
pure def hasAccount(s: ModerationState, accountId: str): bool =
  s.accounts.some(a => a.id == accountId)

pure def hasDirectBlock(s: ModerationState, accountId: str, targetId: str): bool =
  s.blocks.some(b => b.blockerId == accountId and b.blockedId == targetId)

pure def isBlockedBetween(s: ModerationState, accountId: str, targetId: str): bool =
  hasDirectBlock(s, accountId, targetId) or hasDirectBlock(s, targetId, accountId)

pure def hasMute(s: ModerationState, accountId: str, targetId: str): bool =
  s.mutes.some(m => m.muterId == accountId and m.mutedId == targetId)

pure def isFollowing(s: ModerationState, accountId: str, targetId: str): bool =
  s.follows.some(f => f.followerId == accountId and f.followingId == targetId)

pure def isAuthorVisibleToViewer(s: ModerationState, accountId: str, targetId: str): bool =
  not(isBlockedBetween(s, accountId, targetId)) and not(hasMute(s, accountId, targetId))

pure def getAccountMode(s: ModerationState, accountId: str): PresentationMode =
  s.accounts.foldl(GameMode, (acc, a) => if (a.id == accountId) a.mode else acc)

pure def isMarketOrPnLNotif(notifKind: NotificationKind): bool =
  notifKind == MarketResolved or notifKind == PnLDigest

pure def isVisibleInMode(notifKind: NotificationKind, mode: PresentationMode): bool =
  mode == GameMode or not(isMarketOrPnLNotif(notifKind))

pure def visibleNotifications(s: ModerationState, accountId: str): List[Notification] =
  val mode = getAccountMode(s, accountId)
  s.notifications.select(n =>
    n.userId == accountId
      and isVisibleInMode(n.notifKind, mode)
      and (n.actorId == "" or not(isBlockedBetween(s, accountId, n.actorId))))

pure def visibleUnreadCount(s: ModerationState, accountId: str): int =
  visibleNotifications(s, accountId).select(n => not(n.read)).length()

pure def hasPendingReport(s: ModerationState, accountId: str, targetKind: ReportTargetKind, targetUserId: str, targetPostId: int): bool =
  s.reports.some(r =>
    r.reporterId == accountId
      and r.targetKind == targetKind
      and r.targetUserId == targetUserId
      and r.targetPostId == targetPostId
      and r.status == PendingReview)
```

## Story: Block, mute, follow, and report users or posts

> As a user, I want to block or mute abusive accounts (including NPCs) and report posts or users, knowing that blocking removes follow relationships in both directions.

### Blocking prevents self-blocks and atomically removes follow edges in both directions

```quint
pure def canBlock(s: ModerationState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasAccount(s, targetId) and targetId != by and not(hasDirectBlock(s, by, targetId))

pure def block(s: ModerationState, targetId: str, by: str): ModerationState =
  val removedFollows = s.follows.select(f =>
    (f.followerId == by and f.followingId == targetId)
      or (f.followerId == targetId and f.followingId == by)).length()
  { ...s,
    blocks: s.blocks.append({ blockerId: by, blockedId: targetId }),
    follows: s.follows.select(f =>
      not((f.followerId == by and f.followingId == targetId)
        or (f.followerId == targetId and f.followingId == by))),
    blocksClearedFollowsCount: s.blocksClearedFollowsCount + (if (removedFollows > 0) 1 else 0),
  }

pure def canUnblock(s: ModerationState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasDirectBlock(s, by, targetId)

pure def unblock(s: ModerationState, targetId: str, by: str): ModerationState =
  { ...s,
    blocks: s.blocks.select(b => not(b.blockerId == by and b.blockedId == targetId)),
  }
```

### Muting hides an author's feed content without removing follows

```quint
pure def canMute(s: ModerationState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasAccount(s, targetId) and targetId != by and not(hasMute(s, by, targetId))

pure def mute(s: ModerationState, targetId: str, by: str): ModerationState =
  { ...s, mutes: s.mutes.append({ muterId: by, mutedId: targetId }) }

pure def canUnmute(s: ModerationState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasMute(s, by, targetId)

pure def unmute(s: ModerationState, targetId: str, by: str): ModerationState =
  { ...s,
    mutes: s.mutes.select(m => not(m.muterId == by and m.mutedId == targetId)),
  }
```

### Following is refused when blocked

```quint
pure def canFollowUser(s: ModerationState, targetId: str, by: str): bool =
  and {
    hasAccount(s, by),
    hasAccount(s, targetId),
    targetId != by,
    not(isBlockedBetween(s, by, targetId)),
    not(isFollowing(s, by, targetId)),
  }

pure def followUser(s: ModerationState, targetId: str, by: str): ModerationState =
  { ...s, follows: s.follows.append({ followerId: by, followingId: targetId }) }

pure def canUnfollowUser(s: ModerationState, targetId: str, by: str): bool =
  hasAccount(s, by) and isFollowing(s, by, targetId)

pure def unfollowUser(s: ModerationState, targetId: str, by: str): ModerationState =
  { ...s,
    follows: s.follows.select(f => not(f.followerId == by and f.followingId == targetId)),
  }
```

### Reporting covers both user accounts and specific posts without self-reporting or duplicate open filings

```quint
pure def canReport(s: ModerationState, targetKind: ReportTargetKind, targetUserId: str, targetPostId: int, by: str): bool =
  and {
    hasAccount(s, by),
    hasAccount(s, targetUserId),
    targetUserId != by,
    targetKind == UserTarget implies targetPostId == 0,
    targetKind == PostTarget implies targetPostId > 0,
    not(hasPendingReport(s, by, targetKind, targetUserId, targetPostId)),
  }

pure def report(s: ModerationState, targetKind: ReportTargetKind, targetUserId: str, targetPostId: int, category: ReportCategory, by: str): ModerationState =
  val newReportId = s.lastReportId + 1
  { ...s,
    lastReportId: newReportId,
    reports: s.reports.append({
      id: newReportId,
      reporterId: by,
      targetKind: targetKind,
      targetUserId: targetUserId,
      targetPostId: targetPostId,
      category: category,
      status: PendingReview,
    }),
  }
```

## Story: In-app notifications and Social-mode presentation filtering

> As a user, I want in-app notifications respecting blocks and unread counts, and in `SocialMode` I want market-resolution and P&L notifications suppressed from UI and MCP views without touching my open positions.

### Creating notifications skips blocked actors and increments unread count

Only `"system"` dispatches `createNotification`. Social and invite notifications require a non-blocked actor distinct from the recipient; market and P&L notifications are system-sourced (`actorId == ""`).

```quint
pure def canCreateNotification(s: ModerationState, recipientId: str, actorId: str, notifKind: NotificationKind, by: str): bool =
  and {
    by == "system",
    hasAccount(s, recipientId),
    isMarketOrPnLNotif(notifKind) implies actorId == "",
    not(isMarketOrPnLNotif(notifKind)) implies (hasAccount(s, actorId) and actorId != recipientId and not(isBlockedBetween(s, recipientId, actorId))),
  }

pure def createNotification(s: ModerationState, recipientId: str, actorId: str, notifKind: NotificationKind, by: str): ModerationState =
  val newNotifId = s.lastNotificationId + 1
  { ...s,
    lastNotificationId: newNotifId,
    notifications: s.notifications.append({
      id: newNotifId,
      userId: recipientId,
      actorId: actorId,
      notifKind: notifKind,
      read: false,
    }),
    accounts: s.accounts.listMap(a => if (a.id == recipientId) { ...a, unreadCount: a.unreadCount + 1 } else a),
  }
```

### Marking notifications read clears only notifications visible in the account's current mode

In the model, the action requires at least one visible unread notification. It marks unread notifications of kinds the current mode displays. Block filtering applies separately to notification lists and visible unread counts.

```quint
pure def canMarkNotificationsRead(s: ModerationState, by: str): bool =
  hasAccount(s, by) and visibleUnreadCount(s, by) > 0

pure def markNotificationsRead(s: ModerationState, by: str): ModerationState =
  val mode = getAccountMode(s, by)
  val nextNotifications = s.notifications.listMap(n =>
    if (n.userId == by and not(n.read) and isVisibleInMode(n.notifKind, mode)) { ...n, read: true } else n)
  val nextUnread = nextNotifications.select(n => n.userId == by and not(n.read)).length()
  { ...s,
    notifications: nextNotifications,
    accounts: s.accounts.listMap(a => if (a.id == by) { ...a, unreadCount: nextUnread } else a),
  }
```

### Presentation mode toggles without touching open positions

```quint
pure def canSetPresentationMode(s: ModerationState, mode: PresentationMode, by: str): bool =
  hasAccount(s, by) and getAccountMode(s, by) != mode

pure def setPresentationMode(s: ModerationState, mode: PresentationMode, by: str): ModerationState =
  { ...s,
    accounts: s.accounts.listMap(a => if (a.id == by) { ...a, mode: mode } else a),
  }
```

### Block, unread count, report, notification, and Social-mode invariants and laws

```quint
pure def alwaysAccountsValidAndUnique(s: ModerationState): bool =
  s.blocksClearedFollowsCount >= 0
    and s.accounts.every(a =>
      a.id != ""
        and a.openPositionCount >= 0
        and s.accounts.select(b => b.id == a.id).length() == 1)

pure def alwaysCannotBlockMuteOrFollowSelf(s: ModerationState): bool =
  and {
    s.blocks.every(b => b.blockerId != b.blockedId),
    s.mutes.every(m => m.muterId != m.mutedId),
    s.follows.every(f => f.followerId != f.followingId),
  }

pure def alwaysBlockImpliesUnfollow(s: ModerationState): bool =
  s.follows.every(f => not(isBlockedBetween(s, f.followerId, f.followingId)))

pure def alwaysModerationEdgesValidAndUnique(s: ModerationState): bool =
  and {
    s.blocks.every(b =>
      hasAccount(s, b.blockerId)
        and hasAccount(s, b.blockedId)
        and s.blocks.select(c => c.blockerId == b.blockerId and c.blockedId == b.blockedId).length() == 1),
    s.mutes.every(m =>
      hasAccount(s, m.muterId)
        and hasAccount(s, m.mutedId)
        and s.mutes.select(c => c.muterId == m.muterId and c.mutedId == m.mutedId).length() == 1),
    s.follows.every(f =>
      hasAccount(s, f.followerId)
        and hasAccount(s, f.followingId)
        and s.follows.select(c => c.followerId == f.followerId and c.followingId == f.followingId).length() == 1),
  }

pure def alwaysUnreadCountNonNegativeAndAccurate(s: ModerationState): bool =
  s.accounts.every(a =>
    a.unreadCount >= 0
      and a.unreadCount == s.notifications.select(n => n.userId == a.id and not(n.read)).length())

pure def alwaysReportsValid(s: ModerationState): bool =
  s.lastReportId >= 0
    and s.reports.every(r => and {
      1 <= r.id and r.id <= s.lastReportId,
      hasAccount(s, r.reporterId) and hasAccount(s, r.targetUserId),
      r.reporterId != r.targetUserId,
      r.targetKind == UserTarget implies r.targetPostId == 0,
      r.targetKind == PostTarget implies r.targetPostId > 0,
      s.reports.select(b => b.id == r.id).length() == 1,
    })

pure def alwaysNotificationsValid(s: ModerationState): bool =
  s.lastNotificationId >= 0
    and s.notifications.every(n => and {
      1 <= n.id and n.id <= s.lastNotificationId,
      hasAccount(s, n.userId),
      isMarketOrPnLNotif(n.notifKind) implies n.actorId == "",
      not(isMarketOrPnLNotif(n.notifKind)) implies (hasAccount(s, n.actorId) and n.actorId != n.userId),
      s.notifications.select(b => b.id == n.id).length() == 1,
    })

pure def stepModeSwitchPreservesOpenPositions(before: ModerationState, after: ModerationState): bool =
  after.accounts.every(a =>
    before.accounts.some(b => b.id == a.id and b.openPositionCount == a.openPositionCount))

pure def lawSocialModeSuppressesMarketAndPnLNotifications(s: ModerationState, accountId: str): bool =
  getAccountMode(s, accountId) == SocialMode implies
    visibleNotifications(s, accountId).every(n => n.notifKind != MarketResolved and n.notifKind != PnLDigest)

pure def lawVisibleUnreadNonNegativeAndWithinRaw(s: ModerationState, accountId: str): bool =
  val visible = visibleUnreadCount(s, accountId)
  val rawUnread = s.notifications.select(n => n.userId == accountId and not(n.read)).length()
  0 <= visible and visible <= rawUnread

pure def lawBlockedOrMutedAuthorHidden(s: ModerationState, accountId: str, targetId: str): bool =
  (isBlockedBetween(s, accountId, targetId) or hasMute(s, accountId, targetId)) implies
    not(isAuthorVisibleToViewer(s, accountId, targetId))
```

### Block-cleared follows, mutes, reports, read notifications, and Social-mode suppression are reachable

```quint
pure def sometimesBlockClearedFollow(s: ModerationState): bool =
  s.blocks.length() > 0 and s.blocksClearedFollowsCount > 0

pure val eval_witness_sometimesBlockClearedFollow = (
  ("followUser", "bob", "alice"),
  ("block", "bob", "alice")
)

pure def sometimesMuted(s: ModerationState): bool =
  s.mutes.length() > 0

pure val eval_witness_sometimesMuted =
  ("mute", "npc1", "alice")

pure def sometimesPostAndUserReported(s: ModerationState): bool =
  s.reports.some(r => r.targetKind == PostTarget) and s.reports.some(r => r.targetKind == UserTarget)

pure val eval_witness_sometimesPostAndUserReported = (
  ("report", PostTarget, "bob", 1, Spam, "alice"),
  ("report", UserTarget, "npc1", 0, Harassment, "alice")
)

pure def sometimesNotificationsReadInGameMode(s: ModerationState): bool =
  s.notifications.some(n => n.read and n.notifKind == MarketResolved)

pure val eval_witness_sometimesNotificationsReadInGameMode = (
  ("createNotification", "alice", "", MarketResolved, "system"),
  ("markNotificationsRead", "alice")
)

pure def sometimesSocialModeSuppressesMarketNotifWithOpenPositions(s: ModerationState): bool =
  s.accounts.some(a =>
    a.mode == SocialMode
      and a.openPositionCount > 0
      and s.notifications.some(n => n.userId == a.id and not(n.read) and n.notifKind == MarketResolved)
      and visibleUnreadCount(s, a.id) == 0)

pure val eval_witness_sometimesSocialModeSuppressesMarketNotifWithOpenPositions = (
  ("setPresentationMode", SocialMode, "alice"),
  ("createNotification", "alice", "", MarketResolved, "system")
)
```
