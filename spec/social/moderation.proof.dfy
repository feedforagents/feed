lemma AccountsBridge(s: ModerationState)
  ensures alwaysAccountsValidAndUnique(s) == ((s.blocksClearedFollowsCount >= 0) && !((exists a :: a in s.accounts && !((((a.id != "") && (a.openPositionCount >= 0)) && (|ProofLib.Filter((b: AccountModeration) => (b.id == a.id), s.accounts)| == 1))))))
{
}

lemma UnreadBridge(s: ModerationState)
  ensures alwaysUnreadCountNonNegativeAndAccurate(s) == !((exists a :: a in s.accounts && !(((a.unreadCount >= 0) && (a.unreadCount == |ProofLib.Filter((n: Notification) => ((n.userId == a.id) && !(n.read)), s.notifications)|)))))
{
}

lemma EdgesBridge(s: ModerationState)
  ensures alwaysModerationEdgesValidAndUnique(s) == ((!((exists b :: b in s.blocks && !(((hasAccount(s, b.blockerId) && hasAccount(s, b.blockedId)) && (|ProofLib.Filter((c: BlockRecord) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks)| == 1))))) && !((exists m :: m in s.mutes && !(((hasAccount(s, m.muterId) && hasAccount(s, m.mutedId)) && (|ProofLib.Filter((c: MuteRecord) => ((c.muterId == m.muterId) && (c.mutedId == m.mutedId)), s.mutes)| == 1)))))) && !((exists f :: f in s.follows && !(((hasAccount(s, f.followerId) && hasAccount(s, f.followingId)) && (|ProofLib.Filter((c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), s.follows)| == 1))))))
{
}

lemma ReportsBridge(s: ModerationState)
  ensures alwaysReportsValid(s) == ((s.lastReportId >= 0) && !((exists r :: r in s.reports && !(((((((((1 <= r.id) && (r.id <= s.lastReportId)) && hasAccount(s, r.reporterId)) && hasAccount(s, r.targetUserId)) && (r.reporterId != r.targetUserId)) && (!(r.targetKind.UserTarget?) || (r.targetPostId == 0))) && (!(r.targetKind.PostTarget?) || (r.targetPostId > 0))) && (|ProofLib.Filter((b: ModerationReport) => (b.id == r.id), s.reports)| == 1))))))
{
}

lemma NotificationsBridge(s: ModerationState)
  ensures alwaysNotificationsValid(s) == ((s.lastNotificationId >= 0) && !((exists n :: n in s.notifications && !(((((((1 <= n.id) && (n.id <= s.lastNotificationId)) && hasAccount(s, n.userId)) && (!(isMarketOrPnLNotif(n.notifKind)) || (n.actorId == ""))) && (!(!(isMarketOrPnLNotif(n.notifKind))) || (hasAccount(s, n.actorId) && (n.actorId != n.userId)))) && (|ProofLib.Filter((b: Notification) => (b.id == n.id), s.notifications)| == 1))))))
{
}

lemma VisibleNotificationsBridge(s: ModerationState, accountId: string)
  ensures visibleNotifications(s, accountId) == (var local_0 := getAccountMode(s, accountId); ProofLib.Filter((n: Notification) => (((n.userId == accountId) && isVisibleInMode(n.notifKind, local_0)) && ((n.actorId == "") || !(isBlockedBetween(s, accountId, n.actorId)))), s.notifications))
{
}

lemma VisibleUnreadCountBridge(s: ModerationState, accountId: string)
  ensures visibleUnreadCount(s, accountId) == |ProofLib.Filter((n: Notification) => !(n.read), visibleNotifications(s, accountId))|
{
}

lemma LawVisibleUnreadBridge(s: ModerationState, accountId: string)
  ensures lawVisibleUnreadNonNegativeAndWithinRaw(s, accountId) == (var local_7 := visibleUnreadCount(s, accountId); var local_8 := |ProofLib.Filter((n: Notification) => ((n.userId == accountId) && !(n.read)), s.notifications)|; ((0 <= local_7) && (local_7 <= local_8)))
{
}

lemma BlockFollowsBridge(s: ModerationState, targetId: string, by_: string)
  ensures block(s, targetId, by_).follows == ProofLib.Filter((f: FollowRecord) => !((((f.followerId == by_) && (f.followingId == targetId)) || ((f.followerId == targetId) && (f.followingId == by_)))), s.follows)
{
}

lemma UnblockBlocksBridge(s: ModerationState, targetId: string, by_: string)
  ensures unblock(s, targetId, by_).blocks == ProofLib.Filter((b: BlockRecord) => !(((b.blockerId == by_) && (b.blockedId == targetId))), s.blocks)
{
}

lemma UnmuteMutesBridge(s: ModerationState, targetId: string, by_: string)
  ensures unmute(s, targetId, by_).mutes == ProofLib.Filter((m: MuteRecord) => !(((m.muterId == by_) && (m.mutedId == targetId))), s.mutes)
{
}

lemma UnfollowFollowsBridge(s: ModerationState, targetId: string, by_: string)
  ensures unfollowUser(s, targetId, by_).follows == ProofLib.Filter((f: FollowRecord) => !(((f.followerId == by_) && (f.followingId == targetId))), s.follows)
{
}

lemma MarkReadCountBridge(s: ModerationState, by_: string)
  ensures forall i :: 0 <= i < |s.accounts| && s.accounts[i].id == by_ ==> markNotificationsRead(s, by_).accounts[i].unreadCount == |ProofLib.Filter((n: Notification) => ((n.userId == by_) && !(n.read)), markNotificationsRead(s, by_).notifications)|
{
}

lemma FilterPreservesSingleMatch<T>(xs: seq<T>, keep: T -> bool, p: T -> bool, b: T)
  requires b in ProofLib.Filter(keep, xs)
  requires p(b)
  requires |ProofLib.Filter(p, xs)| == 1
  ensures |ProofLib.Filter(p, ProofLib.Filter(keep, xs))| == 1
{
  ProofLib.FilterOfFilterShorter(keep, p, xs);
  ProofLib.FilterMember(p, ProofLib.Filter(keep, xs), b);
}

lemma AppendOldSingleMatch<T>(xs: seq<T>, x: T, p: T -> bool)
  requires !p(x)
  requires |ProofLib.Filter(p, xs)| == 1
  ensures |ProofLib.Filter(p, xs + [x])| == 1
{
  ProofLib.FilterAppend(p, xs, x);
}

lemma AppendNewSingleMatch<T>(xs: seq<T>, x: T, p: T -> bool)
  requires p(x)
  requires forall i :: 0 <= i < |xs| ==> !p(xs[i])
  ensures |ProofLib.Filter(p, xs + [x])| == 1
{
  ProofLib.FilterAppend(p, xs, x);
  ProofLib.FilterNone(p, xs);
}

lemma HasAccountEquiv(s: ModerationState, after: ModerationState)
  requires |after.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id
  ensures forall id :: hasAccount(after, id) == hasAccount(s, id)
{
  forall id
    ensures hasAccount(after, id) == hasAccount(s, id)
  {
    if hasAccount(after, id) {
      var a :| a in after.accounts && a.id == id;
      var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
      assert s.accounts[i] in s.accounts && s.accounts[i].id == id;
    }
    if hasAccount(s, id) {
      var a :| a in s.accounts && a.id == id;
      var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
      assert after.accounts[i] in after.accounts && after.accounts[i].id == id;
    }
  }
}

lemma PreserveAccountsValid(s: ModerationState, after: ModerationState)
  requires alwaysAccountsValidAndUnique(s)
  requires after.blocksClearedFollowsCount == s.blocksClearedFollowsCount
  requires |after.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id && after.accounts[i].openPositionCount == s.accounts[i].openPositionCount
  ensures alwaysAccountsValidAndUnique(after)
{
  AccountsBridge(s);
  AccountsBridge(after);
  forall a | a in after.accounts
    ensures |ProofLib.Filter((b: AccountModeration) => (b.id == a.id), after.accounts)| == 1
    ensures a.id != "" && a.openPositionCount >= 0
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    var prev := s.accounts[i];
    assert prev in s.accounts;
    ProofLib.FilterLengthPointwise((b: AccountModeration) => (b.id == prev.id), (b: AccountModeration) => (b.id == a.id), s.accounts, after.accounts);
  }
}

lemma PreserveEdgesValid(s: ModerationState, after: ModerationState)
  requires alwaysModerationEdgesValidAndUnique(s)
  requires forall id :: hasAccount(after, id) == hasAccount(s, id)
  requires after.blocks == s.blocks && after.mutes == s.mutes && after.follows == s.follows
  ensures alwaysModerationEdgesValidAndUnique(after)
{
  EdgesBridge(s);
  EdgesBridge(after);
}

lemma PreserveReportsValid(s: ModerationState, after: ModerationState)
  requires alwaysReportsValid(s)
  requires forall id :: hasAccount(after, id) == hasAccount(s, id)
  requires after.reports == s.reports && after.lastReportId == s.lastReportId
  ensures alwaysReportsValid(after)
{
  ReportsBridge(s);
  ReportsBridge(after);
}

lemma PreserveNotificationsUnchanged(s: ModerationState, after: ModerationState)
  requires alwaysNotificationsValid(s)
  requires forall id :: hasAccount(after, id) == hasAccount(s, id)
  requires after.notifications == s.notifications && after.lastNotificationId == s.lastNotificationId
  ensures alwaysNotificationsValid(after)
{
  NotificationsBridge(s);
  NotificationsBridge(after);
}

lemma PreserveUnreadUnchanged(s: ModerationState, after: ModerationState)
  requires alwaysUnreadCountNonNegativeAndAccurate(s)
  requires after.notifications == s.notifications
  requires |after.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id && after.accounts[i].unreadCount == s.accounts[i].unreadCount
  ensures alwaysUnreadCountNonNegativeAndAccurate(after)
{
  UnreadBridge(s);
  UnreadBridge(after);
  forall a | a in after.accounts
    ensures a.unreadCount >= 0 && a.unreadCount == |ProofLib.Filter((n: Notification) => ((n.userId == a.id) && !(n.read)), after.notifications)|
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    var prev := s.accounts[i];
    assert prev in s.accounts;
    ProofLib.FilterSamePredicate((n: Notification) => ((n.userId == prev.id) && !(n.read)), (n: Notification) => ((n.userId == a.id) && !(n.read)), s.notifications);
  }
}

lemma CreateNotifUnreadValid(s: ModerationState, recipientId: string, actorId: string, notifKind: NotificationKind, by_: string)
  requires alwaysUnreadCountNonNegativeAndAccurate(s)
  ensures alwaysUnreadCountNonNegativeAndAccurate(createNotification(s, recipientId, actorId, notifKind, by_))
{
  var after := createNotification(s, recipientId, actorId, notifKind, by_);
  var nn := Notification(s.lastNotificationId + 1, recipientId, actorId, notifKind, false);
  UnreadBridge(s);
  UnreadBridge(after);
  forall a | a in after.accounts
    ensures a.unreadCount >= 0 && a.unreadCount == |ProofLib.Filter((n: Notification) => ((n.userId == a.id) && !(n.read)), after.notifications)|
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    var prev := s.accounts[i];
    assert prev in s.accounts;
    ProofLib.FilterSamePredicate((n: Notification) => ((n.userId == prev.id) && !(n.read)), (n: Notification) => ((n.userId == a.id) && !(n.read)), s.notifications);
    ProofLib.FilterAppend((n: Notification) => ((n.userId == a.id) && !(n.read)), s.notifications, nn);
  }
}

lemma CreateNotifNotificationsValid(s: ModerationState, recipientId: string, actorId: string, notifKind: NotificationKind, by_: string)
  requires alwaysNotificationsValid(s)
  requires canCreateNotification(s, recipientId, actorId, notifKind, by_)
  requires forall id :: hasAccount(createNotification(s, recipientId, actorId, notifKind, by_), id) == hasAccount(s, id)
  ensures alwaysNotificationsValid(createNotification(s, recipientId, actorId, notifKind, by_))
{
  var after := createNotification(s, recipientId, actorId, notifKind, by_);
  var nn := Notification(s.lastNotificationId + 1, recipientId, actorId, notifKind, false);
  NotificationsBridge(s);
  NotificationsBridge(after);
  forall n | n in after.notifications
    ensures |ProofLib.Filter((b: Notification) => (b.id == n.id), after.notifications)| == 1
  {
    var p := (b: Notification) => (b.id == n.id);
    if n in s.notifications {
      AppendOldSingleMatch(s.notifications, nn, p);
    } else {
      assert n == nn;
      forall i | 0 <= i < |s.notifications|
        ensures !p(s.notifications[i])
      {
        assert s.notifications[i] in s.notifications;
      }
      AppendNewSingleMatch(s.notifications, nn, p);
    }
  }
}

lemma MarkReadUnreadValid(s: ModerationState, by_: string)
  requires alwaysUnreadCountNonNegativeAndAccurate(s)
  ensures alwaysUnreadCountNonNegativeAndAccurate(markNotificationsRead(s, by_))
{
  var after := markNotificationsRead(s, by_);
  UnreadBridge(s);
  UnreadBridge(after);
  MarkReadCountBridge(s, by_);
  forall a | a in after.accounts
    ensures a.unreadCount >= 0 && a.unreadCount == |ProofLib.Filter((n: Notification) => ((n.userId == a.id) && !(n.read)), after.notifications)|
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    var prev := s.accounts[i];
    assert prev in s.accounts;
    if a.id == by_ {
      ProofLib.FilterSamePredicate((n: Notification) => ((n.userId == by_) && !(n.read)), (n: Notification) => ((n.userId == a.id) && !(n.read)), after.notifications);
    } else {
      ProofLib.FilterLengthPointwise((n: Notification) => ((n.userId == prev.id) && !(n.read)), (n: Notification) => ((n.userId == a.id) && !(n.read)), s.notifications, after.notifications);
    }
  }
}

lemma MarkReadNotificationsValid(s: ModerationState, by_: string)
  requires alwaysNotificationsValid(s)
  requires forall id :: hasAccount(markNotificationsRead(s, by_), id) == hasAccount(s, id)
  ensures alwaysNotificationsValid(markNotificationsRead(s, by_))
{
  var after := markNotificationsRead(s, by_);
  NotificationsBridge(s);
  NotificationsBridge(after);
  forall n | n in after.notifications
    ensures |ProofLib.Filter((b: Notification) => (b.id == n.id), after.notifications)| == 1
    ensures (((((1 <= n.id) && (n.id <= after.lastNotificationId)) && hasAccount(after, n.userId)) && (!(isMarketOrPnLNotif(n.notifKind)) || (n.actorId == ""))) && (!(!(isMarketOrPnLNotif(n.notifKind))) || (hasAccount(after, n.actorId) && (n.actorId != n.userId))))
  {
    var i :| 0 <= i < |after.notifications| && after.notifications[i] == n;
    var prev := s.notifications[i];
    assert prev in s.notifications;
    ProofLib.FilterLengthPointwise((b: Notification) => (b.id == prev.id), (b: Notification) => (b.id == n.id), s.notifications, after.notifications);
  }
}

lemma PreserveSelfAndBlockUnfollow(s: ModerationState, after: ModerationState)
  requires alwaysCannotBlockMuteOrFollowSelf(s)
  requires alwaysBlockImpliesUnfollow(s)
  requires after.blocks == s.blocks && after.mutes == s.mutes && after.follows == s.follows
  ensures alwaysCannotBlockMuteOrFollowSelf(after)
  ensures alwaysBlockImpliesUnfollow(after)
{
}

lemma PreserveOpenPositions(s: ModerationState, after: ModerationState)
  requires |after.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id && after.accounts[i].openPositionCount == s.accounts[i].openPositionCount
  ensures stepModeSwitchPreservesOpenPositions(s, after)
{
  forall a | a in after.accounts
    ensures exists b :: b in s.accounts && ((b.id == a.id) && (b.openPositionCount == a.openPositionCount))
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    assert s.accounts[i] in s.accounts;
  }
}

lemma block_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysAccountsValidAndUnique(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysReportsValid(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> alwaysNotificationsValid(block(s, targetId, by_)))
  ensures (inv(s) ==> canBlock(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, block(s, targetId, by_)))
{
  if inv(s) && canBlock(s, targetId, by_) {
    var after := block(s, targetId, by_);
    var nb := BlockRecord(by_, targetId);
    var keepF := (f: FollowRecord) => !((((f.followerId == by_) && (f.followingId == targetId)) || ((f.followerId == targetId) && (f.followingId == by_))));
    BlockFollowsBridge(s, targetId, by_);
    EdgesBridge(s);
    EdgesBridge(after);
    forall b | b in after.blocks
      ensures |ProofLib.Filter((c: BlockRecord) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), after.blocks)| == 1
    {
      var p := (c: BlockRecord) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId));
      if b in s.blocks {
        AppendOldSingleMatch(s.blocks, nb, p);
      } else {
        assert b == nb;
        forall i | 0 <= i < |s.blocks|
          ensures !p(s.blocks[i])
        {
          assert s.blocks[i] in s.blocks;
        }
        AppendNewSingleMatch(s.blocks, nb, p);
      }
    }
    forall f | f in after.follows
      ensures f in s.follows && keepF(f)
      ensures f.followerId != f.followingId
      ensures |ProofLib.Filter((c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), after.follows)| == 1
      ensures !(isBlockedBetween(after, f.followerId, f.followingId))
    {
      ProofLib.FilterMember(keepF, s.follows, f);
      FilterPreservesSingleMatch(s.follows, keepF, (c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), f);
    }
  }
}

lemma unblock_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysAccountsValidAndUnique(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysReportsValid(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> alwaysNotificationsValid(unblock(s, targetId, by_)))
  ensures (inv(s) ==> canUnblock(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, unblock(s, targetId, by_)))
{
  if inv(s) && canUnblock(s, targetId, by_) {
    var after := unblock(s, targetId, by_);
    var keepB := (b: BlockRecord) => !(((b.blockerId == by_) && (b.blockedId == targetId)));
    UnblockBlocksBridge(s, targetId, by_);
    EdgesBridge(s);
    EdgesBridge(after);
    forall b | b in after.blocks
      ensures b in s.blocks
      ensures b.blockerId != b.blockedId
      ensures |ProofLib.Filter((c: BlockRecord) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), after.blocks)| == 1
    {
      ProofLib.FilterMember(keepB, s.blocks, b);
      FilterPreservesSingleMatch(s.blocks, keepB, (c: BlockRecord) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), b);
    }
  }
}

lemma mute_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysAccountsValidAndUnique(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysReportsValid(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> alwaysNotificationsValid(mute(s, targetId, by_)))
  ensures (inv(s) ==> canMute(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, mute(s, targetId, by_)))
{
  if inv(s) && canMute(s, targetId, by_) {
    var after := mute(s, targetId, by_);
    var nm := MuteRecord(by_, targetId);
    EdgesBridge(s);
    EdgesBridge(after);
    forall m | m in after.mutes
      ensures |ProofLib.Filter((c: MuteRecord) => ((c.muterId == m.muterId) && (c.mutedId == m.mutedId)), after.mutes)| == 1
    {
      var p := (c: MuteRecord) => ((c.muterId == m.muterId) && (c.mutedId == m.mutedId));
      if m in s.mutes {
        AppendOldSingleMatch(s.mutes, nm, p);
      } else {
        assert m == nm;
        forall i | 0 <= i < |s.mutes|
          ensures !p(s.mutes[i])
        {
          assert s.mutes[i] in s.mutes;
        }
        AppendNewSingleMatch(s.mutes, nm, p);
      }
    }
  }
}

lemma unmute_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysAccountsValidAndUnique(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysReportsValid(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> alwaysNotificationsValid(unmute(s, targetId, by_)))
  ensures (inv(s) ==> canUnmute(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, unmute(s, targetId, by_)))
{
  if inv(s) && canUnmute(s, targetId, by_) {
    var after := unmute(s, targetId, by_);
    var keepM := (m: MuteRecord) => !(((m.muterId == by_) && (m.mutedId == targetId)));
    UnmuteMutesBridge(s, targetId, by_);
    EdgesBridge(s);
    EdgesBridge(after);
    forall m | m in after.mutes
      ensures m in s.mutes
      ensures m.muterId != m.mutedId
      ensures |ProofLib.Filter((c: MuteRecord) => ((c.muterId == m.muterId) && (c.mutedId == m.mutedId)), after.mutes)| == 1
    {
      ProofLib.FilterMember(keepM, s.mutes, m);
      FilterPreservesSingleMatch(s.mutes, keepM, (c: MuteRecord) => ((c.muterId == m.muterId) && (c.mutedId == m.mutedId)), m);
    }
  }
}

lemma followUser_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysAccountsValidAndUnique(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysReportsValid(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysNotificationsValid(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, followUser(s, targetId, by_)))
{
  if inv(s) && canFollowUser(s, targetId, by_) {
    var after := followUser(s, targetId, by_);
    var nf := FollowRecord(by_, targetId);
    EdgesBridge(s);
    EdgesBridge(after);
    forall f | f in after.follows
      ensures |ProofLib.Filter((c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), after.follows)| == 1
    {
      var p := (c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId));
      if f in s.follows {
        AppendOldSingleMatch(s.follows, nf, p);
      } else {
        assert f == nf;
        forall i | 0 <= i < |s.follows|
          ensures !p(s.follows[i])
        {
          assert s.follows[i] in s.follows;
        }
        AppendNewSingleMatch(s.follows, nf, p);
      }
    }
  }
}

lemma unfollowUser_ensures(s: ModerationState, targetId: string, by_: string)
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysAccountsValidAndUnique(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysBlockImpliesUnfollow(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysModerationEdgesValidAndUnique(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysReportsValid(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysNotificationsValid(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> stepModeSwitchPreservesOpenPositions(s, unfollowUser(s, targetId, by_)))
{
  if inv(s) && canUnfollowUser(s, targetId, by_) {
    var after := unfollowUser(s, targetId, by_);
    var keepF := (f: FollowRecord) => !(((f.followerId == by_) && (f.followingId == targetId)));
    UnfollowFollowsBridge(s, targetId, by_);
    EdgesBridge(s);
    EdgesBridge(after);
    forall f | f in after.follows
      ensures f in s.follows
      ensures f.followerId != f.followingId
      ensures |ProofLib.Filter((c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), after.follows)| == 1
    {
      ProofLib.FilterMember(keepF, s.follows, f);
      FilterPreservesSingleMatch(s.follows, keepF, (c: FollowRecord) => ((c.followerId == f.followerId) && (c.followingId == f.followingId)), f);
    }
  }
}

lemma report_ensures(s: ModerationState, targetKind: ReportTargetKind, targetUserId: string, targetPostId: int, category: ReportCategory, by_: string)
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysAccountsValidAndUnique(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysCannotBlockMuteOrFollowSelf(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysBlockImpliesUnfollow(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysModerationEdgesValidAndUnique(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysReportsValid(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> alwaysNotificationsValid(report(s, targetKind, targetUserId, targetPostId, category, by_)))
  ensures (inv(s) ==> canReport(s, targetKind, targetUserId, targetPostId, by_) ==> stepModeSwitchPreservesOpenPositions(s, report(s, targetKind, targetUserId, targetPostId, category, by_)))
{
  if inv(s) && canReport(s, targetKind, targetUserId, targetPostId, by_) {
    var after := report(s, targetKind, targetUserId, targetPostId, category, by_);
    var nr := ModerationReport(s.lastReportId + 1, by_, targetKind, targetUserId, targetPostId, category, ReportStatus.PendingReview);
    ReportsBridge(s);
    ReportsBridge(after);
    forall r | r in after.reports
      ensures |ProofLib.Filter((b: ModerationReport) => (b.id == r.id), after.reports)| == 1
    {
      var p := (b: ModerationReport) => (b.id == r.id);
      if r in s.reports {
        AppendOldSingleMatch(s.reports, nr, p);
      } else {
        assert r == nr;
        forall i | 0 <= i < |s.reports|
          ensures !p(s.reports[i])
        {
          assert s.reports[i] in s.reports;
        }
        AppendNewSingleMatch(s.reports, nr, p);
      }
    }
  }
}

lemma createNotification_ensures(s: ModerationState, recipientId: string, actorId: string, notifKind: NotificationKind, by_: string)
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysAccountsValidAndUnique(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysCannotBlockMuteOrFollowSelf(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysBlockImpliesUnfollow(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysModerationEdgesValidAndUnique(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysReportsValid(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> alwaysNotificationsValid(createNotification(s, recipientId, actorId, notifKind, by_)))
  ensures (inv(s) ==> canCreateNotification(s, recipientId, actorId, notifKind, by_) ==> stepModeSwitchPreservesOpenPositions(s, createNotification(s, recipientId, actorId, notifKind, by_)))
{
  if inv(s) && canCreateNotification(s, recipientId, actorId, notifKind, by_) {
    hide *;
    reveal inv, createNotification;
    var after := createNotification(s, recipientId, actorId, notifKind, by_);
    HasAccountEquiv(s, after);
    PreserveAccountsValid(s, after);
    PreserveEdgesValid(s, after);
    PreserveReportsValid(s, after);
    PreserveSelfAndBlockUnfollow(s, after);
    PreserveOpenPositions(s, after);
    CreateNotifUnreadValid(s, recipientId, actorId, notifKind, by_);
    CreateNotifNotificationsValid(s, recipientId, actorId, notifKind, by_);
  }
}

lemma markNotificationsRead_ensures(s: ModerationState, by_: string)
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysAccountsValidAndUnique(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysCannotBlockMuteOrFollowSelf(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysBlockImpliesUnfollow(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysModerationEdgesValidAndUnique(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysReportsValid(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> alwaysNotificationsValid(markNotificationsRead(s, by_)))
  ensures (inv(s) ==> canMarkNotificationsRead(s, by_) ==> stepModeSwitchPreservesOpenPositions(s, markNotificationsRead(s, by_)))
{
  if inv(s) && canMarkNotificationsRead(s, by_) {
    var after := markNotificationsRead(s, by_);
    HasAccountEquiv(s, after);
    PreserveAccountsValid(s, after);
    PreserveEdgesValid(s, after);
    PreserveReportsValid(s, after);
    PreserveOpenPositions(s, after);
    MarkReadUnreadValid(s, by_);
    MarkReadNotificationsValid(s, by_);
  }
}

lemma setPresentationMode_ensures(s: ModerationState, mode: PresentationMode, by_: string)
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysAccountsValidAndUnique(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysCannotBlockMuteOrFollowSelf(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysBlockImpliesUnfollow(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysModerationEdgesValidAndUnique(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysUnreadCountNonNegativeAndAccurate(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysReportsValid(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> alwaysNotificationsValid(setPresentationMode(s, mode, by_)))
  ensures (inv(s) ==> canSetPresentationMode(s, mode, by_) ==> stepModeSwitchPreservesOpenPositions(s, setPresentationMode(s, mode, by_)))
{
  if inv(s) && canSetPresentationMode(s, mode, by_) {
    hide *;
    reveal inv, setPresentationMode;
    var after := setPresentationMode(s, mode, by_);
    HasAccountEquiv(s, after);
    PreserveAccountsValid(s, after);
    PreserveSelfAndBlockUnfollow(s, after);
    PreserveUnreadUnchanged(s, after);
    PreserveEdgesValid(s, after);
    PreserveReportsValid(s, after);
    PreserveNotificationsUnchanged(s, after);
    PreserveOpenPositions(s, after);
  }
}

lemma lawVisibleUnreadNonNegativeAndWithinRaw_ensures(s: ModerationState, accountId: string)
  ensures (lawVisibleUnreadNonNegativeAndWithinRaw(s, accountId) == true)
{
  VisibleNotificationsBridge(s, accountId);
  VisibleUnreadCountBridge(s, accountId);
  LawVisibleUnreadBridge(s, accountId);
  var m := getAccountMode(s, accountId);
  ProofLib.FilterOfFilterLength(
    (n: Notification) => (((n.userId == accountId) && isVisibleInMode(n.notifKind, m)) && ((n.actorId == "") || !(isBlockedBetween(s, accountId, n.actorId)))),
    (n: Notification) => !(n.read),
    (n: Notification) => ((n.userId == accountId) && !(n.read)),
    s.notifications
  );
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  AccountsBridge(s);
  ProofLib.FilterOne((b: AccountModeration) => (b.id == s.accounts[0].id), s.accounts, 0);
  ProofLib.FilterOne((b: AccountModeration) => (b.id == s.accounts[1].id), s.accounts, 1);
  ProofLib.FilterOne((b: AccountModeration) => (b.id == s.accounts[2].id), s.accounts, 2);
}
