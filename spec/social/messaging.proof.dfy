lemma AccountIdsBridge(s: MessagingState)
  ensures alwaysAccountIdsUnique(s) == !((exists a :: a in s.accounts && !(((a.id != "") && (|ProofLib.Filter((b: Account) => (b.id == a.id), s.accounts)| == 1)))))
{
  hide *;
  reveal alwaysAccountIdsUnique, ProofLib.Filter;
}

lemma ChatIdsBridge(s: MessagingState)
  ensures alwaysChatIdsUnique(s) == (((s.lastChatId >= 0) && !((exists c :: c in s.chats && !(((1 <= c.id) && (c.id <= s.lastChatId)))))) && !((exists a :: a in s.chats && !((|ProofLib.Filter((b: Chat) => (b.id == a.id), s.chats)| == 1)))))
{
  hide *;
  reveal alwaysChatIdsUnique, ProofLib.Filter;
}

lemma DmMembersBridge(s: MessagingState)
  ensures alwaysDmHasExactTwoMembers(s) == !((exists c :: c in s.chats && !((!(c.chatType.Direct?) || ((((((((((c.ownerId == "") && (c.peerA != "")) && (c.peerB != "")) && (c.peerA != c.peerB)) && hasAccount(s, c.peerA)) && hasAccount(s, c.peerB)) && isActiveMember(s, c.id, c.peerA)) && isActiveMember(s, c.id, c.peerB)) && (|ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members)| == 2)) && (|ProofLib.Filter((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), s.chats)| == 1))))))
{
  hide *;
  reveal alwaysDmHasExactTwoMembers, ProofLib.Filter;
}

lemma MembersBridge(s: MessagingState)
  ensures alwaysMembersValidAndUnique(s) == !((exists m :: m in s.members && !((((hasChat(s, m.chatId) && hasAccount(s, m.userId)) && (!(isDirectChat(s, m.chatId)) || m.active)) && (|ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members)| == 1)))))
{
  hide *;
  reveal alwaysMembersValidAndUnique, ProofLib.Filter;
}

lemma MessagesBridge(s: MessagingState)
  ensures alwaysMessagesValid(s) == ((s.lastMessageId >= 0) && !((exists msg :: msg in s.messages && !((((((((1 <= msg.id) && (msg.id <= s.lastMessageId)) && (1 <= msg.textLen)) && (msg.textLen <= maxMessageChars)) && hasChat(s, msg.chatId)) && hasAccount(s, msg.senderId)) && (|ProofLib.Filter((b: ChatMessage) => (b.id == msg.id), s.messages)| == 1))))))
{
  hide *;
  reveal alwaysMessagesValid, ProofLib.Filter;
}

lemma ReactionsBridge(s: MessagingState)
  ensures alwaysReactionsValidAndUnique(s) == !((exists r :: r in s.reactions && !((((hasMessage(s, r.messageId) && hasAccount(s, r.userId)) && (r.emoji != "")) && (|ProofLib.Filter((b: MessageReaction) => (((b.messageId == r.messageId) && (b.userId == r.userId)) && (b.emoji == r.emoji)), s.reactions)| == 1)))))
{
  hide *;
  reveal alwaysReactionsValidAndUnique, ProofLib.Filter;
}

lemma BlocksBridge(s: MessagingState)
  ensures alwaysBlocksValid(s) == !((exists b :: b in s.blocks && !(((((b.blockerId != b.blockedId) && hasAccount(s, b.blockerId)) && hasAccount(s, b.blockedId)) && (|ProofLib.Filter((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks)| == 1)))))
{
  hide *;
  reveal alwaysBlocksValid, ProofLib.Filter;
}

lemma PendingInvitesBridge(s: MessagingState)
  ensures alwaysPendingInvitesValidAndDisjointFromActiveMembers(s) == ((((s.lastInviteId >= 0) && (s.acceptedInvitesCount >= 0)) && (s.declinedInvitesCount >= 0)) && !((exists invite :: invite in s.pendingInvites && !(((((((((((1 <= invite.id) && (invite.id <= s.lastInviteId)) && hasGroupChat(s, invite.chatId)) && hasAccount(s, invite.invitedUserId)) && hasAccount(s, invite.invitedBy)) && (invite.invitedUserId != invite.invitedBy)) && (invite.isAlpha == isNpcAlphaChat(s, invite.chatId))) && !(isActiveMember(s, invite.chatId, invite.invitedUserId))) && (|ProofLib.Filter((b: PendingInvite) => (b.id == invite.id), s.pendingInvites)| == 1)) && (|ProofLib.Filter((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), s.pendingInvites)| == 1))))))
{
  hide *;
  reveal alwaysPendingInvitesValidAndDisjointFromActiveMembers, ProofLib.Filter;
}

lemma RespondInvitesFilterBridge(s: MessagingState, inviteId: int, response: InviteResponse, by_: string)
  ensures respondInvite(s, inviteId, response, by_).pendingInvites == ProofLib.Filter((invite: PendingInvite) => (invite.id != inviteId), s.pendingInvites)
{
  hide *;
  reveal respondInvite, ProofLib.Filter;
}

lemma UnblockBlocksBridge(s: MessagingState, targetId: string, by_: string)
  ensures unblockUser(s, targetId, by_).blocks == ProofLib.Filter((b: BlockPair) => !(((b.blockerId == by_) && (b.blockedId == targetId))), s.blocks)
{
  hide *;
  reveal unblockUser, ProofLib.Filter;
}

lemma FrameAccountIds(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts
  requires alwaysAccountIdsUnique(a)
  ensures alwaysAccountIdsUnique(b)
{
  hide *;
  reveal alwaysAccountIdsUnique;
}

lemma FrameNoTeamChats(a: MessagingState, b: MessagingState)
  requires a.chats == b.chats
  requires alwaysNoTeamChats(a)
  ensures alwaysNoTeamChats(b)
{
  hide *;
  reveal alwaysNoTeamChats;
}

lemma FrameChatIds(a: MessagingState, b: MessagingState)
  requires a.chats == b.chats && a.lastChatId == b.lastChatId
  requires alwaysChatIdsUnique(a)
  ensures alwaysChatIdsUnique(b)
{
  hide *;
  reveal alwaysChatIdsUnique;
}

lemma FrameDmMembers(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.chats == b.chats && a.members == b.members
  requires alwaysDmHasExactTwoMembers(a)
  ensures alwaysDmHasExactTwoMembers(b)
{
  hide *;
  reveal alwaysDmHasExactTwoMembers, hasAccount, isActiveMember;
}

lemma FrameAlphaOwners(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.chats == b.chats && a.members == b.members
  requires alwaysAlphaGroupsOwnedByNpcs(a)
  ensures alwaysAlphaGroupsOwnedByNpcs(b)
{
  hide *;
  reveal alwaysAlphaGroupsOwnedByNpcs, isNpc, isActiveMember;
}

lemma FrameGroupOwners(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.chats == b.chats && a.members == b.members
  requires alwaysGroupOwnersStayActive(a)
  ensures alwaysGroupOwnersStayActive(b)
{
  hide *;
  reveal alwaysGroupOwnersStayActive, hasAccount, isActiveMember;
}

lemma FrameMembersValid(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.chats == b.chats && a.members == b.members
  requires alwaysMembersValidAndUnique(a)
  ensures alwaysMembersValidAndUnique(b)
{
  hide *;
  reveal alwaysMembersValidAndUnique, hasChat, hasAccount, isDirectChat;
}

lemma FrameMessagesValid(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.messages == b.messages && a.lastMessageId == b.lastMessageId
  requires forall c :: c in a.chats ==> c in b.chats
  requires alwaysMessagesValid(a)
  ensures alwaysMessagesValid(b)
{
  hide *;
  reveal alwaysMessagesValid, hasChat, hasAccount;
}

lemma FrameReactionsValid(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.reactions == b.reactions
  requires forall m :: m in a.messages ==> m in b.messages
  requires alwaysReactionsValidAndUnique(a)
  ensures alwaysReactionsValidAndUnique(b)
{
  hide *;
  reveal alwaysReactionsValidAndUnique, hasMessage, hasAccount;
}

lemma FrameBlocksValid(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.blocks == b.blocks
  requires alwaysBlocksValid(a)
  ensures alwaysBlocksValid(b)
{
  hide *;
  reveal alwaysBlocksValid, hasAccount;
}

lemma FramePendingInvites(a: MessagingState, b: MessagingState)
  requires a.accounts == b.accounts && a.chats == b.chats && a.pendingInvites == b.pendingInvites
  requires a.lastInviteId == b.lastInviteId && a.acceptedInvitesCount == b.acceptedInvitesCount && a.declinedInvitesCount == b.declinedInvitesCount
  requires forall cid, uid :: isActiveMember(b, cid, uid) ==> isActiveMember(a, cid, uid)
  requires alwaysPendingInvitesValidAndDisjointFromActiveMembers(a)
  ensures alwaysPendingInvitesValidAndDisjointFromActiveMembers(b)
{
  hide *;
  reveal alwaysPendingInvitesValidAndDisjointFromActiveMembers, hasGroupChat, isUserGroupChat, isNpcAlphaChat, hasAccount;
}

lemma StepNonRespondInvite(before: MessagingState, via: string, after: MessagingState)
  requires via != "respondInvite"
  ensures stepDeclinedInviteDoesNotAddMember(before, via, after)
  ensures stepAcceptedInviteAddsMemberAndRemovesPending(before, via, after)
{
  hide *;
  reveal stepDeclinedInviteDoesNotAddMember, stepAcceptedInviteAddsMemberAndRemovesPending;
}

lemma StepNonSend(before: MessagingState, via: string, after: MessagingState)
  requires via != "sendMessage" && via != "sendDm"
  ensures stepMessageOnlyFromActiveMember(before, via, after)
{
  hide *;
  reveal stepMessageOnlyFromActiveMember;
}

lemma ChatIdsDistinct(s: MessagingState)
  requires alwaysChatIdsUnique(s)
  ensures ProofLib.DistinctBy(s.chats, (c: Chat) => c.id)
{
  hide *;
  reveal ProofLib.DistinctBy;
  ChatIdsBridge(s);
  var key := (c: Chat) => c.id;
  forall i, j | 0 <= i < |s.chats| && 0 <= j < |s.chats| && i != j
    ensures key(s.chats[i]) != key(s.chats[j])
  {
    var a := s.chats[i];
    ProofLib.FilterCountOneIffUnique((b: Chat) => (b.id == a.id), s.chats, key, i);
  }
}

lemma ChatOwnerFoldNone(xs: seq<Chat>, chatId: int, init: string)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != chatId
  ensures Std.Collections.Seq.FoldLeft((acc: string, c: Chat) => (if (c.id == chatId) then c.ownerId else acc), init, xs) == init
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    ChatOwnerFoldNone(xs[1..], chatId, init);
  }
}

lemma ChatOwnerFoldMatch(xs: seq<Chat>, chatId: int, init: string, target: Chat)
  requires ProofLib.DistinctBy(xs, (c: Chat) => c.id)
  requires target in xs && target.id == chatId
  ensures Std.Collections.Seq.FoldLeft((acc: string, c: Chat) => (if (c.id == chatId) then c.ownerId else acc), init, xs) == target.ownerId
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft, ProofLib.DistinctBy;
  if xs[0].id == chatId {
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k == 0;
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][i].id != chatId;
    ChatOwnerFoldNone(xs[1..], chatId, target.ownerId);
  } else {
    assert ProofLib.DistinctBy(xs[1..], (c: Chat) => c.id) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j
        ensures xs[1..][i].id != xs[1..][j].id
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k > 0 && xs[1..][k - 1] == target;
    ChatOwnerFoldMatch(xs[1..], chatId, init, target);
  }
}

lemma FindDmFoldNone(xs: seq<Chat>, a: string, b: string, init: int)
  requires forall i :: 0 <= i < |xs| ==> !sameDmPeers(xs[i], a, b)
  ensures Std.Collections.Seq.FoldLeft((acc: int, c: Chat) => (if sameDmPeers(c, a, b) then c.id else acc), init, xs) == init
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FindDmFoldNone(xs[1..], a, b, init);
  }
}

lemma FindDmFoldPos(xs: seq<Chat>, a: string, b: string, init: int)
  requires exists c :: c in xs && sameDmPeers(c, a, b)
  ensures var r := Std.Collections.Seq.FoldLeft((acc: int, c: Chat) => (if sameDmPeers(c, a, b) then c.id else acc), init, xs);
    exists c :: c in xs && sameDmPeers(c, a, b) && c.id == r
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  var nextInit := if sameDmPeers(xs[0], a, b) then xs[0].id else init;
  assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
  if exists c :: c in xs[1..] && sameDmPeers(c, a, b) {
    FindDmFoldPos(xs[1..], a, b, nextInit);
    var r := Std.Collections.Seq.FoldLeft((acc: int, c: Chat) => (if sameDmPeers(c, a, b) then c.id else acc), nextInit, xs[1..]);
    var c :| c in xs[1..] && sameDmPeers(c, a, b) && c.id == r;
    assert c in xs;
  } else {
    var c :| c in xs && sameDmPeers(c, a, b);
    var k :| 0 <= k < |xs| && xs[k] == c;
    assert k == 0;
    FindDmFoldNone(xs[1..], a, b, nextInit);
  }
}

lemma FindDmFoldResult(xs: seq<Chat>, a: string, b: string, init: int)
  requires init >= 0
  requires forall i :: 0 <= i < |xs| ==> xs[i].id >= 1
  ensures var r := Std.Collections.Seq.FoldLeft((acc: int, c: Chat) => (if sameDmPeers(c, a, b) then c.id else acc), init, xs);
    (init > 0 ==> r > 0) &&
    ((exists c :: c in xs && sameDmPeers(c, a, b)) ==> r > 0) &&
    ((init == 0 && r > 0) ==> exists c :: c in xs && sameDmPeers(c, a, b) && c.id == r) &&
    ((init == 0 && r <= 0) ==> forall c :: c in xs ==> !sameDmPeers(c, a, b))
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  if |xs| > 0 {
    var nextInit := if sameDmPeers(xs[0], a, b) then xs[0].id else init;
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FindDmFoldResult(xs[1..], a, b, nextInit);
    var r := Std.Collections.Seq.FoldLeft((acc: int, c: Chat) => (if sameDmPeers(c, a, b) then c.id else acc), nextInit, xs[1..]);
    if init == 0 && r > 0 {
      if sameDmPeers(xs[0], a, b) {
        if exists c :: c in xs[1..] && sameDmPeers(c, a, b) {
          FindDmFoldPos(xs[1..], a, b, nextInit);
        } else {
          FindDmFoldNone(xs[1..], a, b, nextInit);
          assert r == xs[0].id;
        }
      } else {
        var c :| c in xs[1..] && sameDmPeers(c, a, b) && c.id == r;
        assert c in xs;
      }
    }
    if exists c :: c in xs && sameDmPeers(c, a, b) {
      var c :| c in xs && sameDmPeers(c, a, b);
      var k :| 0 <= k < |xs| && xs[k] == c;
      if k > 0 {
        assert xs[1..][k - 1] == c;
      }
    }
  }
}

lemma InviteIdFoldNone(xs: seq<PendingInvite>, inviteId: int, init: int)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != inviteId
  ensures Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), init, xs) == init
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft;
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    InviteIdFoldNone(xs[1..], inviteId, init);
  }
}

lemma InviteIdFoldMatch(xs: seq<PendingInvite>, inviteId: int, init: int, target: PendingInvite)
  requires ProofLib.DistinctBy(xs, (inv0: PendingInvite) => inv0.id)
  requires target in xs && target.id == inviteId
  ensures Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), init, xs) == target.chatId
  decreases |xs|
{
  hide *;
  reveal Std.Collections.Seq.FoldLeft, ProofLib.DistinctBy;
  if xs[0].id == inviteId {
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k == 0;
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][i].id != inviteId;
    InviteIdFoldNone(xs[1..], inviteId, target.chatId);
  } else {
    assert ProofLib.DistinctBy(xs[1..], (inv0: PendingInvite) => inv0.id) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j
        ensures xs[1..][i].id != xs[1..][j].id
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k > 0 && xs[1..][k - 1] == target;
    InviteIdFoldMatch(xs[1..], inviteId, init, target);
  }
}

lemma FilterAllKept<T>(p: T -> bool, xs: seq<T>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  hide *;
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FilterAllKept(p, xs[1..]);
  }
}

lemma InviteRemoveOneLength(xs: seq<PendingInvite>, inviteId: int, target: PendingInvite)
  requires ProofLib.DistinctBy(xs, (inv0: PendingInvite) => inv0.id)
  requires target in xs && target.id == inviteId
  ensures |ProofLib.Filter((invite: PendingInvite) => (invite.id != inviteId), xs)| == |xs| - 1
  decreases |xs|
{
  hide *;
  reveal ProofLib.DistinctBy;
  ProofLib.FilterCons((invite: PendingInvite) => (invite.id != inviteId), xs);
  if xs[0].id == inviteId {
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k == 0;
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][i].id != inviteId;
    FilterAllKept((invite: PendingInvite) => (invite.id != inviteId), xs[1..]);
  } else {
    assert ProofLib.DistinctBy(xs[1..], (inv0: PendingInvite) => inv0.id) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j
        ensures xs[1..][i].id != xs[1..][j].id
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k > 0 && xs[1..][k - 1] == target;
    InviteRemoveOneLength(xs[1..], inviteId, target);
  }
}

lemma InviteIdCountToDistinct(xs: seq<PendingInvite>)
  requires forall invite :: invite in xs ==> |ProofLib.Filter((b: PendingInvite) => (b.id == invite.id), xs)| == 1
  ensures ProofLib.DistinctBy(xs, (invite: PendingInvite) => invite.id)
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (invite: PendingInvite) => invite.id;
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var invite := xs[i];
    ProofLib.FilterCountOneIffUnique((b: PendingInvite) => (b.id == invite.id), xs, key, i);
  }
}

lemma InviteIdDistinctToCount(xs: seq<PendingInvite>)
  requires ProofLib.DistinctBy(xs, (invite: PendingInvite) => invite.id)
  ensures forall invite :: invite in xs ==> |ProofLib.Filter((b: PendingInvite) => (b.id == invite.id), xs)| == 1
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (invite: PendingInvite) => invite.id;
  forall invite | invite in xs
    ensures |ProofLib.Filter((b: PendingInvite) => (b.id == invite.id), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == invite;
    ProofLib.FilterCountOneIffUnique((b: PendingInvite) => (b.id == invite.id), xs, key, i);
  }
}

lemma InvitePairCountToDistinct(xs: seq<PendingInvite>)
  requires forall invite :: invite in xs ==> |ProofLib.Filter((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), xs)| == 1
  ensures ProofLib.DistinctBy(xs, (invite: PendingInvite) => (invite.chatId, invite.invitedUserId))
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (invite: PendingInvite) => (invite.chatId, invite.invitedUserId);
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var invite := xs[i];
    ProofLib.FilterCountOneIffUnique((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), xs, key, i);
  }
}

lemma InvitePairDistinctToCount(xs: seq<PendingInvite>)
  requires ProofLib.DistinctBy(xs, (invite: PendingInvite) => (invite.chatId, invite.invitedUserId))
  ensures forall invite :: invite in xs ==> |ProofLib.Filter((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), xs)| == 1
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (invite: PendingInvite) => (invite.chatId, invite.invitedUserId);
  forall invite | invite in xs
    ensures |ProofLib.Filter((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == invite;
    ProofLib.FilterCountOneIffUnique((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), xs, key, i);
  }
}

lemma BlockCountUnique(xs: seq<BlockPair>)
  requires forall b :: b in xs ==> |ProofLib.Filter((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
  ensures ProofLib.DistinctBy(xs, (b: BlockPair) => (b.blockerId, b.blockedId))
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (b: BlockPair) => (b.blockerId, b.blockedId);
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var b := xs[i];
    ProofLib.FilterCountOneIffUnique((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs, key, i);
  }
}

lemma BlockUniqueToCount(xs: seq<BlockPair>)
  requires ProofLib.DistinctBy(xs, (b: BlockPair) => (b.blockerId, b.blockedId))
  ensures forall b :: b in xs ==> |ProofLib.Filter((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
{
  hide *;
  reveal ProofLib.DistinctBy;
  var key := (b: BlockPair) => (b.blockerId, b.blockedId);
  forall b | b in xs
    ensures |ProofLib.Filter((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == b;
    ProofLib.FilterCountOneIffUnique((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs, key, i);
  }
}

lemma SameMembersActiveEquiv(s: MessagingState, after: MessagingState)
  requires |after.members| == |s.members|
  requires forall i :: 0 <= i < |s.members| ==>
    after.members[i].chatId == s.members[i].chatId &&
    after.members[i].userId == s.members[i].userId &&
    after.members[i].active == s.members[i].active
  ensures forall cid, uid :: isActiveMember(after, cid, uid) == isActiveMember(s, cid, uid)
{
  hide *;
  reveal isActiveMember;
  forall cid, uid
    ensures isActiveMember(after, cid, uid) == isActiveMember(s, cid, uid)
  {
    if isActiveMember(after, cid, uid) {
      var m :| m in after.members && m.chatId == cid && m.userId == uid && m.active;
      var i :| 0 <= i < |after.members| && after.members[i] == m;
      assert s.members[i] in s.members && s.members[i].chatId == cid && s.members[i].userId == uid && s.members[i].active;
    }
    if isActiveMember(s, cid, uid) {
      var m :| m in s.members && m.chatId == cid && m.userId == uid && m.active;
      var i :| 0 <= i < |s.members| && s.members[i] == m;
      assert after.members[i] in after.members && after.members[i].chatId == cid && after.members[i].userId == uid && after.members[i].active;
    }
  }
}

lemma SameMembersDmExactTwo(s: MessagingState, after: MessagingState)
  requires alwaysDmHasExactTwoMembers(s)
  requires after.chats == s.chats && after.accounts == s.accounts
  requires |after.members| == |s.members|
  requires forall i :: 0 <= i < |s.members| ==>
    after.members[i].chatId == s.members[i].chatId &&
    after.members[i].userId == s.members[i].userId &&
    after.members[i].active == s.members[i].active
  ensures alwaysDmHasExactTwoMembers(after)
{
  hide *;
  reveal hasAccount;
  SameMembersActiveEquiv(s, after);
  DmMembersBridge(s);
  DmMembersBridge(after);
  forall c | c in after.chats && c.chatType.Direct?
    ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
  {
    ProofLib.FilterLengthPointwise((m: ChatMember) => ((m.chatId == c.id) && m.active), (m: ChatMember) => ((m.chatId == c.id) && m.active), after.members, s.members);
  }
}

lemma SameMembersAlphaOwners(s: MessagingState, after: MessagingState)
  requires alwaysAlphaGroupsOwnedByNpcs(s)
  requires after.chats == s.chats && after.accounts == s.accounts
  requires forall cid, uid :: isActiveMember(s, cid, uid) ==> isActiveMember(after, cid, uid)
  ensures alwaysAlphaGroupsOwnedByNpcs(after)
{
  hide *;
  reveal alwaysAlphaGroupsOwnedByNpcs, isNpc;
}

lemma SameMembersGroupOwners(s: MessagingState, after: MessagingState)
  requires alwaysGroupOwnersStayActive(s)
  requires after.chats == s.chats && after.accounts == s.accounts
  requires forall cid, uid :: isActiveMember(s, cid, uid) ==> isActiveMember(after, cid, uid)
  ensures alwaysGroupOwnersStayActive(after)
{
  hide *;
  reveal alwaysGroupOwnersStayActive, hasAccount;
}

lemma SameMembersValidAndUnique(s: MessagingState, after: MessagingState)
  requires alwaysMembersValidAndUnique(s)
  requires after.chats == s.chats && after.accounts == s.accounts
  requires |after.members| == |s.members|
  requires forall i :: 0 <= i < |s.members| ==>
    after.members[i].chatId == s.members[i].chatId &&
    after.members[i].userId == s.members[i].userId &&
    after.members[i].active == s.members[i].active
  ensures alwaysMembersValidAndUnique(after)
{
  hide *;
  reveal hasChat, hasAccount, isDirectChat;
  MembersBridge(s);
  MembersBridge(after);
  forall m | m in after.members
    ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
  {
    var i :| 0 <= i < |after.members| && after.members[i] == m;
    var m0 := s.members[i];
    assert m0 in s.members;
    ProofLib.FilterLengthPointwise((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), (b: ChatMember) => ((b.chatId == m0.chatId) && (b.userId == m0.userId)), after.members, s.members);
  }
}

lemma AppendMessageValid(s: MessagingState, after: MessagingState, chatId: int, textLen: int, by_: string)
  requires alwaysMessagesValid(s)
  requires after.accounts == s.accounts
  requires forall c :: c in s.chats ==> c in after.chats
  requires after.lastMessageId == s.lastMessageId + 1
  requires after.messages == s.messages + [ChatMessage(s.lastMessageId + 1, chatId, by_, textLen)]
  requires hasChat(after, chatId) && hasAccount(s, by_) && 1 <= textLen <= maxMessageChars
  ensures alwaysMessagesValid(after)
{
  hide *;
  reveal hasChat, hasAccount;
  MessagesBridge(s);
  MessagesBridge(after);
  var nmsg := ChatMessage(s.lastMessageId + 1, chatId, by_, textLen);
  forall msg | msg in after.messages
    ensures |ProofLib.Filter((b: ChatMessage) => (b.id == msg.id), after.messages)| == 1
  {
    ProofLib.FilterAppend((b: ChatMessage) => (b.id == msg.id), s.messages, nmsg);
    if msg == nmsg {
      ProofLib.FilterNone((b: ChatMessage) => (b.id == msg.id), s.messages);
    }
  }
}

lemma AppendMessageStepActive(s: MessagingState, via: string, after: MessagingState, chatId: int, textLen: int, by_: string)
  requires after.messages == s.messages + [ChatMessage(s.lastMessageId + 1, chatId, by_, textLen)]
  requires isActiveMember(after, chatId, by_)
  ensures stepMessageOnlyFromActiveMember(s, via, after)
{
  hide *;
  reveal stepMessageOnlyFromActiveMember;
}

lemma AppendChatNoTeam(s: MessagingState, after: MessagingState, nc: Chat)
  requires alwaysNoTeamChats(s)
  requires after.chats == s.chats + [nc]
  requires !nc.chatType.TeamChat?
  ensures alwaysNoTeamChats(after)
{
  hide *;
  reveal alwaysNoTeamChats;
}

lemma AppendChatIdsValid(s: MessagingState, after: MessagingState, nc: Chat)
  requires alwaysChatIdsUnique(s)
  requires after.lastChatId == s.lastChatId + 1
  requires nc.id == s.lastChatId + 1
  requires after.chats == s.chats + [nc]
  ensures alwaysChatIdsUnique(after)
{
  hide *;
  ChatIdsBridge(s);
  ChatIdsBridge(after);
  forall a | a in after.chats
    ensures |ProofLib.Filter((b: Chat) => (b.id == a.id), after.chats)| == 1
  {
    ProofLib.FilterAppend((b: Chat) => (b.id == a.id), s.chats, nc);
    if a == nc {
      ProofLib.FilterNone((b: Chat) => (b.id == a.id), s.chats);
    }
  }
}

lemma AppendChatPendingInvites(s: MessagingState, after: MessagingState, nc: Chat)
  requires alwaysChatIdsUnique(s)
  requires alwaysPendingInvitesValidAndDisjointFromActiveMembers(s)
  requires nc.id == s.lastChatId + 1
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [nc]
  requires after.pendingInvites == s.pendingInvites
  requires after.lastInviteId == s.lastInviteId && after.acceptedInvitesCount == s.acceptedInvitesCount && after.declinedInvitesCount == s.declinedInvitesCount
  requires forall m :: m in after.members ==> m in s.members || m.chatId == nc.id
  ensures alwaysPendingInvitesValidAndDisjointFromActiveMembers(after)
{
  hide *;
  reveal hasGroupChat, isUserGroupChat, isNpcAlphaChat, hasAccount, isActiveMember;
  ChatIdsBridge(s);
  PendingInvitesBridge(s);
  PendingInvitesBridge(after);
  forall invite | invite in after.pendingInvites
    ensures hasGroupChat(after, invite.chatId)
    ensures invite.isAlpha == isNpcAlphaChat(after, invite.chatId)
    ensures !(isActiveMember(after, invite.chatId, invite.invitedUserId))
  {
    var c0 :| c0 in s.chats && c0.id == invite.chatId;
    assert invite.chatId <= s.lastChatId < nc.id;
  }
}

lemma AppendPendingInviteValid(s: MessagingState, after: MessagingState, chatId: int, targetId: string, by_: string, isAlpha: bool)
  requires alwaysPendingInvitesValidAndDisjointFromActiveMembers(s)
  requires after.accounts == s.accounts && after.chats == s.chats && after.members == s.members
  requires after.lastInviteId == s.lastInviteId + 1
  requires after.acceptedInvitesCount == s.acceptedInvitesCount && after.declinedInvitesCount == s.declinedInvitesCount
  requires after.pendingInvites == s.pendingInvites + [PendingInvite(s.lastInviteId + 1, chatId, targetId, by_, isAlpha)]
  requires hasGroupChat(s, chatId) && hasAccount(s, targetId) && hasAccount(s, by_) && targetId != by_
  requires isAlpha == isNpcAlphaChat(s, chatId)
  requires !(isActiveMember(s, chatId, targetId)) && !(hasPendingInvite(s, chatId, targetId))
  ensures alwaysPendingInvitesValidAndDisjointFromActiveMembers(after)
{
  hide *;
  reveal hasGroupChat, isUserGroupChat, isNpcAlphaChat, hasAccount, isActiveMember, hasPendingInvite;
  PendingInvitesBridge(s);
  PendingInvitesBridge(after);
  var ni := PendingInvite(s.lastInviteId + 1, chatId, targetId, by_, isAlpha);
  forall invite | invite in after.pendingInvites
    ensures |ProofLib.Filter((b: PendingInvite) => (b.id == invite.id), after.pendingInvites)| == 1
    ensures |ProofLib.Filter((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), after.pendingInvites)| == 1
  {
    ProofLib.FilterAppend((b: PendingInvite) => (b.id == invite.id), s.pendingInvites, ni);
    ProofLib.FilterAppend((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), s.pendingInvites, ni);
    if invite == ni {
      ProofLib.FilterNone((b: PendingInvite) => (b.id == invite.id), s.pendingInvites);
      ProofLib.FilterNone((b: PendingInvite) => ((b.chatId == invite.chatId) && (b.invitedUserId == invite.invitedUserId)), s.pendingInvites);
    }
  }
}

lemma AddReactionValid(s: MessagingState, messageId: int, emoji: string, by_: string)
  requires alwaysReactionsValidAndUnique(s)
  requires canAddReaction(s, messageId, emoji, by_)
  ensures alwaysReactionsValidAndUnique(addReaction(s, messageId, emoji, by_))
{
  hide *;
  reveal addReaction, canAddReaction, hasMessage, hasAccount, hasReaction;
  var after := addReaction(s, messageId, emoji, by_);
  ReactionsBridge(s);
  ReactionsBridge(after);
  var nr := MessageReaction(messageId, by_, emoji);
  forall r | r in after.reactions
    ensures |ProofLib.Filter((b: MessageReaction) => (((b.messageId == r.messageId) && (b.userId == r.userId)) && (b.emoji == r.emoji)), after.reactions)| == 1
  {
    ProofLib.FilterAppend((b: MessageReaction) => (((b.messageId == r.messageId) && (b.userId == r.userId)) && (b.emoji == r.emoji)), s.reactions, nr);
    if r == nr {
      ProofLib.FilterNone((b: MessageReaction) => (((b.messageId == r.messageId) && (b.userId == r.userId)) && (b.emoji == r.emoji)), s.reactions);
    }
  }
}

lemma BlockUserValid(s: MessagingState, targetId: string, by_: string)
  requires alwaysBlocksValid(s)
  requires canBlockUser(s, targetId, by_)
  ensures alwaysBlocksValid(blockUser(s, targetId, by_))
{
  hide *;
  reveal blockUser, canBlockUser, hasAccount, hasDirectBlock;
  var after := blockUser(s, targetId, by_);
  BlocksBridge(s);
  BlocksBridge(after);
  var nb := BlockPair(by_, targetId);
  forall b | b in after.blocks
    ensures |ProofLib.Filter((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), after.blocks)| == 1
  {
    ProofLib.FilterAppend((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks, nb);
    if b == nb {
      ProofLib.FilterNone((c: BlockPair) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks);
    }
  }
}

lemma UnblockUserValid(s: MessagingState, targetId: string, by_: string)
  requires alwaysBlocksValid(s)
  requires canUnblockUser(s, targetId, by_)
  ensures alwaysBlocksValid(unblockUser(s, targetId, by_))
{
  hide *;
  reveal hasAccount;
  var after := unblockUser(s, targetId, by_);
  assert after.accounts == s.accounts by {
    reveal unblockUser;
  }
  BlocksBridge(s);
  BlocksBridge(after);
  UnblockBlocksBridge(s, targetId, by_);
  var keep := (b: BlockPair) => !(((b.blockerId == by_) && (b.blockedId == targetId)));
  BlockCountUnique(s.blocks);
  ProofLib.FilterKeepsDistinctBy(keep, s.blocks, (b: BlockPair) => (b.blockerId, b.blockedId));
  BlockUniqueToCount(after.blocks);
  forall b | b in after.blocks
    ensures b in s.blocks && keep(b)
  {
    ProofLib.FilterMember(keep, s.blocks, b);
  }
}

lemma CreateGroupDmMembers(s: MessagingState, after: MessagingState, chatType: ChatType, by_: string)
  requires alwaysChatIdsUnique(s)
  requires alwaysDmHasExactTwoMembers(s)
  requires !chatType.Direct?
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, chatType, by_, "", "")]
  requires after.members == s.members + [ChatMember(s.lastChatId + 1, by_, MemberRole.Owner, true, false, true)]
  ensures alwaysDmHasExactTwoMembers(after)
{
  hide *;
  reveal hasAccount, isActiveMember, sameDmPeers;
  ChatIdsBridge(s);
  DmMembersBridge(s);
  DmMembersBridge(after);
  var nid := s.lastChatId + 1;
  var nc := Chat(nid, chatType, by_, "", "");
  var nm := ChatMember(nid, by_, MemberRole.Owner, true, false, true);
  forall c | c in after.chats && c.chatType.Direct?
    ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
    ensures |ProofLib.Filter((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), after.chats)| == 1
  {
    assert c in s.chats && c.id <= s.lastChatId < nid;
    ProofLib.FilterAppend((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members, nm);
    ProofLib.FilterAppend((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), s.chats, nc);
  }
}

lemma CreateGroupOwners(s: MessagingState, after: MessagingState, chatType: ChatType, by_: string)
  requires alwaysAlphaGroupsOwnedByNpcs(s)
  requires alwaysGroupOwnersStayActive(s)
  requires canCreateGroup(s, chatType, by_)
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, chatType, by_, "", "")]
  requires after.members == s.members + [ChatMember(s.lastChatId + 1, by_, MemberRole.Owner, true, false, true)]
  ensures alwaysAlphaGroupsOwnedByNpcs(after)
  ensures alwaysGroupOwnersStayActive(after)
{
  hide *;
  reveal canCreateGroup, alwaysAlphaGroupsOwnedByNpcs, alwaysGroupOwnersStayActive, isNpc, hasAccount, isActiveMember;
  var nid := s.lastChatId + 1;
  var nm := ChatMember(nid, by_, MemberRole.Owner, true, false, true);
  assert nm in after.members;
}

lemma CreateGroupMembersValid(s: MessagingState, after: MessagingState, chatType: ChatType, by_: string)
  requires alwaysChatIdsUnique(s)
  requires alwaysMembersValidAndUnique(s)
  requires canCreateGroup(s, chatType, by_)
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, chatType, by_, "", "")]
  requires after.members == s.members + [ChatMember(s.lastChatId + 1, by_, MemberRole.Owner, true, false, true)]
  ensures alwaysMembersValidAndUnique(after)
{
  hide *;
  reveal canCreateGroup, hasChat, hasAccount, isDirectChat;
  ChatIdsBridge(s);
  MembersBridge(s);
  MembersBridge(after);
  var nid := s.lastChatId + 1;
  var nc := Chat(nid, chatType, by_, "", "");
  var nm := ChatMember(nid, by_, MemberRole.Owner, true, false, true);
  assert nc in after.chats && nid >= 1;
  forall m | m in after.members
    ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
  {
    ProofLib.FilterAppend((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members, nm);
    if m == nm {
      ProofLib.FilterNone((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members);
    }
  }
}

lemma SendDmExistingFacts(s: MessagingState, recipientId: string, textLen: int, by_: string, local_0: int)
  requires alwaysChatIdsUnique(s)
  requires alwaysDmHasExactTwoMembers(s)
  requires local_0 == findDmChatId(s, by_, recipientId)
  requires local_0 > 0
  ensures hasChat(s, local_0)
  ensures isActiveMember(s, local_0, by_)
{
  hide *;
  reveal findDmChatId, sameDmPeers, hasChat;
  ChatIdsBridge(s);
  DmMembersBridge(s);
  FindDmFoldResult(s.chats, by_, recipientId, 0);
  var c0 :| c0 in s.chats && sameDmPeers(c0, by_, recipientId) && c0.id == local_0;
  assert c0.id >= 1;
}

lemma SendDmNewDmMembers(s: MessagingState, after: MessagingState, recipientId: string, by_: string)
  requires alwaysAccountIdsUnique(s)
  requires alwaysChatIdsUnique(s)
  requires alwaysDmHasExactTwoMembers(s)
  requires alwaysMembersValidAndUnique(s)
  requires hasAccount(s, by_) && hasAccount(s, recipientId) && recipientId != by_
  requires forall c :: c in s.chats ==> !sameDmPeers(c, by_, recipientId)
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, ChatType.Direct, "", by_, recipientId)]
  requires after.members == s.members + [ChatMember(s.lastChatId + 1, by_, MemberRole.Member, true, false, true), ChatMember(s.lastChatId + 1, recipientId, MemberRole.Member, true, false, false)]
  ensures alwaysDmHasExactTwoMembers(after)
{
  hide *;
  reveal hasAccount, hasChat, isActiveMember, sameDmPeers;
  AccountIdsBridge(s);
  ChatIdsBridge(s);
  DmMembersBridge(s);
  DmMembersBridge(after);
  MembersBridge(s);
  var local_1 := s.lastChatId + 1;
  var nc := Chat(local_1, ChatType.Direct, "", by_, recipientId);
  var m1 := ChatMember(local_1, by_, MemberRole.Member, true, false, true);
  var m2 := ChatMember(local_1, recipientId, MemberRole.Member, true, false, false);
  assert after.members == (s.members + [m1]) + [m2];
  assert m1 in after.members && m2 in after.members;
  forall c | c in after.chats && c.chatType.Direct?
    ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
    ensures |ProofLib.Filter((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), after.chats)| == 1
  {
    ProofLib.FilterAppend((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members + [m1], m2);
    ProofLib.FilterAppend((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members, m1);
    ProofLib.FilterAppend((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), s.chats, nc);
    if c == nc {
      ProofLib.FilterNone((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members);
      ProofLib.FilterNone((b: Chat) => sameDmPeers(b, c.peerA, c.peerB), s.chats);
    } else {
      assert c in s.chats && c.id <= s.lastChatId < local_1;
      assert !sameDmPeers(nc, c.peerA, c.peerB);
    }
  }
}

lemma SendDmNewOwners(s: MessagingState, after: MessagingState, recipientId: string, by_: string)
  requires alwaysAlphaGroupsOwnedByNpcs(s)
  requires alwaysGroupOwnersStayActive(s)
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, ChatType.Direct, "", by_, recipientId)]
  requires forall m :: m in s.members ==> m in after.members
  ensures alwaysAlphaGroupsOwnedByNpcs(after)
  ensures alwaysGroupOwnersStayActive(after)
{
  hide *;
  reveal alwaysAlphaGroupsOwnedByNpcs, alwaysGroupOwnersStayActive, isNpc, hasAccount, isActiveMember;
}

lemma SendDmNewMembersValid(s: MessagingState, after: MessagingState, recipientId: string, by_: string)
  requires alwaysChatIdsUnique(s)
  requires alwaysMembersValidAndUnique(s)
  requires hasAccount(s, by_) && hasAccount(s, recipientId) && recipientId != by_
  requires after.accounts == s.accounts
  requires after.chats == s.chats + [Chat(s.lastChatId + 1, ChatType.Direct, "", by_, recipientId)]
  requires after.members == s.members + [ChatMember(s.lastChatId + 1, by_, MemberRole.Member, true, false, true), ChatMember(s.lastChatId + 1, recipientId, MemberRole.Member, true, false, false)]
  ensures alwaysMembersValidAndUnique(after)
{
  hide *;
  reveal hasChat, hasAccount, isDirectChat;
  ChatIdsBridge(s);
  MembersBridge(s);
  MembersBridge(after);
  var local_1 := s.lastChatId + 1;
  var nc := Chat(local_1, ChatType.Direct, "", by_, recipientId);
  var m1 := ChatMember(local_1, by_, MemberRole.Member, true, false, true);
  var m2 := ChatMember(local_1, recipientId, MemberRole.Member, true, false, false);
  assert after.members == (s.members + [m1]) + [m2];
  assert nc in after.chats && local_1 >= 1;
  forall m | m in after.members
    ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
  {
    ProofLib.FilterAppend((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members + [m1], m2);
    ProofLib.FilterAppend((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members, m1);
    if m == m1 || m == m2 {
      ProofLib.FilterNone((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members);
    } else {
      assert m in s.members;
      var c0 :| c0 in s.chats && c0.id == m.chatId;
      assert m.chatId <= s.lastChatId < local_1;
    }
  }
}

lemma LeaveGroupChatFacts(s: MessagingState, chatId: int, by_: string)
  requires alwaysChatIdsUnique(s)
  requires canLeaveGroup(s, chatId, by_)
  ensures !(isDirectChat(s, chatId))
  ensures forall c :: c in s.chats && c.id == chatId ==> c.ownerId != by_
{
  hide *;
  reveal canLeaveGroup, hasGroupChat, isUserGroupChat, isNpcAlphaChat, isDirectChat, chatOwnerOf, ProofLib.DistinctBy;
  ChatIdsDistinct(s);
  forall c | c in s.chats && c.id == chatId
    ensures c.ownerId != by_
  {
    ChatOwnerFoldMatch(s.chats, chatId, "", c);
  }
}

lemma LeaveGroupActiveFacts(s: MessagingState, chatId: int, by_: string)
  ensures var after := leaveGroup(s, chatId, by_);
    (forall cid, uid :: isActiveMember(s, cid, uid) && !(cid == chatId && uid == by_) ==> isActiveMember(after, cid, uid)) &&
    (forall cid, uid :: isActiveMember(after, cid, uid) ==> isActiveMember(s, cid, uid))
{
  hide *;
  reveal leaveGroup, isActiveMember;
  var after := leaveGroup(s, chatId, by_);
  forall cid, uid | isActiveMember(s, cid, uid) && !(cid == chatId && uid == by_)
    ensures isActiveMember(after, cid, uid)
  {
    var m :| m in s.members && m.chatId == cid && m.userId == uid && m.active;
    var i :| 0 <= i < |s.members| && s.members[i] == m;
    assert after.members[i] in after.members && after.members[i].chatId == cid && after.members[i].userId == uid && after.members[i].active;
  }
  forall cid, uid | isActiveMember(after, cid, uid)
    ensures isActiveMember(s, cid, uid)
  {
    var m :| m in after.members && m.chatId == cid && m.userId == uid && m.active;
    var i :| 0 <= i < |after.members| && after.members[i] == m;
    assert s.members[i] in s.members && s.members[i].chatId == cid && s.members[i].userId == uid && s.members[i].active;
  }
}

lemma LeaveGroupDmMembers(s: MessagingState, chatId: int, by_: string)
  requires alwaysDmHasExactTwoMembers(s)
  requires !(isDirectChat(s, chatId))
  ensures alwaysDmHasExactTwoMembers(leaveGroup(s, chatId, by_))
{
  hide *;
  reveal leaveGroup, hasAccount, isDirectChat;
  var after := leaveGroup(s, chatId, by_);
  LeaveGroupActiveFacts(s, chatId, by_);
  DmMembersBridge(s);
  DmMembersBridge(after);
  forall c | c in after.chats && c.chatType.Direct?
    ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
  {
    assert c.id != chatId;
    ProofLib.FilterLengthPointwise((m: ChatMember) => ((m.chatId == c.id) && m.active), (m: ChatMember) => ((m.chatId == c.id) && m.active), after.members, s.members);
  }
}

lemma LeaveGroupOwners(s: MessagingState, chatId: int, by_: string)
  requires alwaysAlphaGroupsOwnedByNpcs(s)
  requires alwaysGroupOwnersStayActive(s)
  requires forall c :: c in s.chats && c.id == chatId ==> c.ownerId != by_
  ensures alwaysAlphaGroupsOwnedByNpcs(leaveGroup(s, chatId, by_))
  ensures alwaysGroupOwnersStayActive(leaveGroup(s, chatId, by_))
{
  hide *;
  reveal leaveGroup, alwaysAlphaGroupsOwnedByNpcs, alwaysGroupOwnersStayActive, isNpc, hasAccount;
  LeaveGroupActiveFacts(s, chatId, by_);
}

lemma LeaveGroupMembersValid(s: MessagingState, chatId: int, by_: string)
  requires alwaysMembersValidAndUnique(s)
  requires !(isDirectChat(s, chatId))
  ensures alwaysMembersValidAndUnique(leaveGroup(s, chatId, by_))
{
  hide *;
  reveal leaveGroup, hasChat, hasAccount, isDirectChat;
  var after := leaveGroup(s, chatId, by_);
  MembersBridge(s);
  MembersBridge(after);
  forall m | m in after.members
    ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
  {
    var i :| 0 <= i < |after.members| && after.members[i] == m;
    var m0 := s.members[i];
    assert m0 in s.members;
    ProofLib.FilterLengthPointwise((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), (b: ChatMember) => ((b.chatId == m0.chatId) && (b.userId == m0.userId)), after.members, s.members);
  }
}

lemma RespondInviteExtract(s: MessagingState, inviteId: int, response: InviteResponse, by_: string)
  requires alwaysChatIdsUnique(s)
  requires alwaysPendingInvitesValidAndDisjointFromActiveMembers(s)
  requires canRespondInvite(s, inviteId, response, by_)
  ensures var targetChatId := Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites);
    hasGroupChat(s, targetChatId) &&
    hasChat(s, targetChatId) &&
    !(isDirectChat(s, targetChatId)) &&
    hasAccount(s, by_) &&
    !(isActiveMember(s, targetChatId, by_)) &&
    |respondInvite(s, inviteId, response, by_).pendingInvites| == |s.pendingInvites| - 1 &&
    (forall invite :: invite in respondInvite(s, inviteId, response, by_).pendingInvites ==>
      invite in s.pendingInvites && invite.id != inviteId && !(invite.chatId == targetChatId && invite.invitedUserId == by_))
{
  hide *;
  reveal canRespondInvite, hasGroupChat, isUserGroupChat, isNpcAlphaChat, hasChat, isDirectChat, ProofLib.DistinctBy;
  ChatIdsDistinct(s);
  ChatIdsBridge(s);
  PendingInvitesBridge(s);
  RespondInvitesFilterBridge(s, inviteId, response, by_);
  InviteIdCountToDistinct(s.pendingInvites);
  InvitePairCountToDistinct(s.pendingInvites);
  var inv0 :| inv0 in s.pendingInvites && inv0.id == inviteId && inv0.invitedUserId == by_;
  var iInv0 :| 0 <= iInv0 < |s.pendingInvites| && s.pendingInvites[iInv0] == inv0;
  InviteIdFoldMatch(s.pendingInvites, inviteId, 0, inv0);
  var targetChatId := inv0.chatId;
  var keep := (invite: PendingInvite) => (invite.id != inviteId);
  InviteRemoveOneLength(s.pendingInvites, inviteId, inv0);
  var after := respondInvite(s, inviteId, response, by_);
  forall invite | invite in after.pendingInvites
    ensures invite in s.pendingInvites && invite.id != inviteId
    ensures !(invite.chatId == targetChatId && invite.invitedUserId == by_)
  {
    ProofLib.FilterMember(keep, s.pendingInvites, invite);
    var j :| 0 <= j < |s.pendingInvites| && s.pendingInvites[j] == invite;
    assert j != iInv0;
  }
}

lemma RespondInvitePendingInvitesValid(s: MessagingState, inviteId: int, response: InviteResponse, by_: string, targetChatId: int)
  requires alwaysPendingInvitesValidAndDisjointFromActiveMembers(s)
  requires var after := respondInvite(s, inviteId, response, by_);
    forall invite :: invite in after.pendingInvites ==>
      invite in s.pendingInvites && invite.id != inviteId && !(invite.chatId == targetChatId && invite.invitedUserId == by_)
  requires var after := respondInvite(s, inviteId, response, by_);
    forall cid, uid :: isActiveMember(after, cid, uid) && !(cid == targetChatId && uid == by_) ==> isActiveMember(s, cid, uid)
  ensures alwaysPendingInvitesValidAndDisjointFromActiveMembers(respondInvite(s, inviteId, response, by_))
{
  hide *;
  reveal hasGroupChat, isUserGroupChat, isNpcAlphaChat, hasAccount;
  var after := respondInvite(s, inviteId, response, by_);
  assert after.accounts == s.accounts && after.chats == s.chats && after.lastInviteId == s.lastInviteId && after.acceptedInvitesCount >= s.acceptedInvitesCount && after.declinedInvitesCount >= s.declinedInvitesCount by {
    reveal respondInvite;
  }
  PendingInvitesBridge(s);
  PendingInvitesBridge(after);
  RespondInvitesFilterBridge(s, inviteId, response, by_);
  InviteIdCountToDistinct(s.pendingInvites);
  InvitePairCountToDistinct(s.pendingInvites);
  var keep := (invite: PendingInvite) => (invite.id != inviteId);
  ProofLib.FilterKeepsDistinctBy(keep, s.pendingInvites, (invite: PendingInvite) => invite.id);
  InviteIdDistinctToCount(after.pendingInvites);
  ProofLib.FilterKeepsDistinctBy(keep, s.pendingInvites, (invite: PendingInvite) => (invite.chatId, invite.invitedUserId));
  InvitePairDistinctToCount(after.pendingInvites);
}

lemma RespondInviteAcceptActiveFacts(s: MessagingState, inviteId: int, response: InviteResponse, by_: string, targetChatId: int)
  requires response.Accept?
  requires targetChatId == Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites)
  ensures var after := respondInvite(s, inviteId, response, by_);
    (forall cid, uid :: isActiveMember(s, cid, uid) ==> isActiveMember(after, cid, uid)) &&
    (forall cid, uid :: isActiveMember(after, cid, uid) && !(cid == targetChatId && uid == by_) ==> isActiveMember(s, cid, uid))
{
  hide *;
  reveal respondInvite, hasMemberRow, isActiveMember;
  var after := respondInvite(s, inviteId, response, by_);
  if hasMemberRow(s, targetChatId, by_) {
    forall cid, uid | isActiveMember(s, cid, uid)
      ensures isActiveMember(after, cid, uid)
    {
      var m :| m in s.members && m.chatId == cid && m.userId == uid && m.active;
      var i :| 0 <= i < |s.members| && s.members[i] == m;
      assert after.members[i] in after.members && after.members[i].chatId == cid && after.members[i].userId == uid && after.members[i].active;
    }
    forall cid, uid | isActiveMember(after, cid, uid) && !(cid == targetChatId && uid == by_)
      ensures isActiveMember(s, cid, uid)
    {
      var m :| m in after.members && m.chatId == cid && m.userId == uid && m.active;
      var i :| 0 <= i < |after.members| && after.members[i] == m;
      assert s.members[i] in s.members && s.members[i].chatId == cid && s.members[i].userId == uid && s.members[i].active;
    }
  }
}

lemma RespondInviteAcceptDmMembers(s: MessagingState, inviteId: int, response: InviteResponse, by_: string, targetChatId: int)
  requires alwaysDmHasExactTwoMembers(s)
  requires response.Accept?
  requires targetChatId == Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites)
  requires !(isDirectChat(s, targetChatId))
  ensures alwaysDmHasExactTwoMembers(respondInvite(s, inviteId, response, by_))
{
  hide *;
  reveal respondInvite, hasAccount, isDirectChat;
  var after := respondInvite(s, inviteId, response, by_);
  RespondInviteAcceptActiveFacts(s, inviteId, response, by_, targetChatId);
  DmMembersBridge(s);
  DmMembersBridge(after);
  if hasMemberRow(s, targetChatId, by_) {
    forall c | c in after.chats && c.chatType.Direct?
      ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
    {
      assert c.id != targetChatId;
      ProofLib.FilterLengthPointwise((m: ChatMember) => ((m.chatId == c.id) && m.active), (m: ChatMember) => ((m.chatId == c.id) && m.active), after.members, s.members);
    }
  } else {
    var nm := ChatMember(targetChatId, by_, MemberRole.Member, true, true, false);
    assert after.members == s.members + [nm];
    forall c | c in after.chats && c.chatType.Direct?
      ensures |ProofLib.Filter((m: ChatMember) => ((m.chatId == c.id) && m.active), after.members)| == 2
    {
      assert c.id != targetChatId;
      ProofLib.FilterAppend((m: ChatMember) => ((m.chatId == c.id) && m.active), s.members, nm);
    }
  }
}

lemma RespondInviteAcceptMembersValid(s: MessagingState, inviteId: int, response: InviteResponse, by_: string, targetChatId: int)
  requires alwaysMembersValidAndUnique(s)
  requires response.Accept?
  requires targetChatId == Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites)
  requires hasChat(s, targetChatId) && hasAccount(s, by_)
  ensures alwaysMembersValidAndUnique(respondInvite(s, inviteId, response, by_))
{
  hide *;
  reveal respondInvite, hasMemberRow, hasChat, hasAccount, isDirectChat;
  var after := respondInvite(s, inviteId, response, by_);
  MembersBridge(s);
  MembersBridge(after);
  if hasMemberRow(s, targetChatId, by_) {
    forall m | m in after.members
      ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
    {
      var i :| 0 <= i < |after.members| && after.members[i] == m;
      var m0 := s.members[i];
      assert m0 in s.members;
      ProofLib.FilterLengthPointwise((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), (b: ChatMember) => ((b.chatId == m0.chatId) && (b.userId == m0.userId)), after.members, s.members);
    }
  } else {
    var nm := ChatMember(targetChatId, by_, MemberRole.Member, true, true, false);
    assert after.members == s.members + [nm];
    forall m | m in after.members
      ensures |ProofLib.Filter((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), after.members)| == 1
    {
      ProofLib.FilterAppend((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members, nm);
      if m == nm {
        ProofLib.FilterNone((b: ChatMember) => ((b.chatId == m.chatId) && (b.userId == m.userId)), s.members);
      }
    }
  }
}

lemma RespondInviteStepRules(s: MessagingState, inviteId: int, response: InviteResponse, by_: string, targetChatId: int)
  requires targetChatId == Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites)
  requires !(isActiveMember(s, targetChatId, by_))
  requires |respondInvite(s, inviteId, response, by_).pendingInvites| == |s.pendingInvites| - 1
  ensures stepDeclinedInviteDoesNotAddMember(s, "respondInvite", respondInvite(s, inviteId, response, by_))
  ensures stepAcceptedInviteAddsMemberAndRemovesPending(s, "respondInvite", respondInvite(s, inviteId, response, by_))
{
  hide *;
  reveal respondInvite, hasMemberRow, isActiveMember, stepDeclinedInviteDoesNotAddMember, stepAcceptedInviteAddsMemberAndRemovesPending;
  var after := respondInvite(s, inviteId, response, by_);
  if response.Accept? {
    if hasMemberRow(s, targetChatId, by_) {
      var oldRow :| oldRow in s.members && oldRow.chatId == targetChatId && oldRow.userId == by_;
      var kRow :| 0 <= kRow < |s.members| && s.members[kRow] == oldRow;
      assert after.members[kRow] in after.members && after.members[kRow].active && after.members[kRow].joinedViaInvite;
    } else {
      var nm := ChatMember(targetChatId, by_, MemberRole.Member, true, true, false);
      assert nm in after.members;
    }
  }
}

lemma sendDm_ensures(s: MessagingState, recipientId: string, textLen: int, by_: string)
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysAccountIdsUnique(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysNoTeamChats(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysChatIdsUnique(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysDmHasExactTwoMembers(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysAlphaGroupsOwnedByNpcs(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysGroupOwnersStayActive(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysMembersValidAndUnique(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysMessagesValid(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysReactionsValidAndUnique(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> alwaysBlocksValid(sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> stepMessageOnlyFromActiveMember(s, "sendDm", sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "sendDm", sendDm(s, recipientId, textLen, by_)))
  ensures (inv(s) ==> canSendDm(s, recipientId, textLen, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "sendDm", sendDm(s, recipientId, textLen, by_)))
{
  hide *;
  if inv(s) && canSendDm(s, recipientId, textLen, by_) {
    reveal inv, sendDm, canSendDm;
    var after := sendDm(s, recipientId, textLen, by_);
    var local_0 := findDmChatId(s, by_, recipientId);
    FrameAccountIds(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    StepNonRespondInvite(s, "sendDm", after);
    if local_0 > 0 {
      FrameNoTeamChats(s, after);
      FrameChatIds(s, after);
      SameMembersActiveEquiv(s, after);
      SameMembersDmExactTwo(s, after);
      SameMembersAlphaOwners(s, after);
      SameMembersGroupOwners(s, after);
      SameMembersValidAndUnique(s, after);
      FramePendingInvites(s, after);
      SendDmExistingFacts(s, recipientId, textLen, by_, local_0);
      assert hasChat(after, local_0) by {
        reveal hasChat;
      }
      AppendMessageValid(s, after, local_0, textLen, by_);
      AppendMessageStepActive(s, "sendDm", after, local_0, textLen, by_);
    } else {
      var local_1 := s.lastChatId + 1;
      var nc := Chat(local_1, ChatType.Direct, "", by_, recipientId);
      var m1 := ChatMember(local_1, by_, MemberRole.Member, true, false, true);
      var m2 := ChatMember(local_1, recipientId, MemberRole.Member, true, false, false);
      assert forall c :: c in s.chats ==> !sameDmPeers(c, by_, recipientId) by {
        reveal findDmChatId;
        ChatIdsBridge(s);
        FindDmFoldResult(s.chats, by_, recipientId, 0);
      }
      AppendChatNoTeam(s, after, nc);
      AppendChatIdsValid(s, after, nc);
      SendDmNewDmMembers(s, after, recipientId, by_);
      SendDmNewOwners(s, after, recipientId, by_);
      SendDmNewMembersValid(s, after, recipientId, by_);
      assert hasChat(after, local_1) by {
        reveal hasChat;
        ChatIdsBridge(s);
        assert nc in after.chats && local_1 >= 1;
      }
      assert isActiveMember(after, local_1, by_) by {
        reveal isActiveMember;
        assert m1 in after.members;
      }
      AppendMessageValid(s, after, local_1, textLen, by_);
      AppendChatPendingInvites(s, after, nc);
      AppendMessageStepActive(s, "sendDm", after, local_1, textLen, by_);
    }
  }
}

lemma sendMessage_ensures(s: MessagingState, chatId: int, textLen: int, by_: string)
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysAccountIdsUnique(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysNoTeamChats(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysChatIdsUnique(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysDmHasExactTwoMembers(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysAlphaGroupsOwnedByNpcs(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysGroupOwnersStayActive(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysMembersValidAndUnique(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysMessagesValid(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysReactionsValidAndUnique(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> alwaysBlocksValid(sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> stepMessageOnlyFromActiveMember(s, "sendMessage", sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "sendMessage", sendMessage(s, chatId, textLen, by_)))
  ensures (inv(s) ==> canSendMessage(s, chatId, textLen, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "sendMessage", sendMessage(s, chatId, textLen, by_)))
{
  hide *;
  if inv(s) && canSendMessage(s, chatId, textLen, by_) {
    reveal inv, sendMessage, canSendMessage;
    var after := sendMessage(s, chatId, textLen, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    SameMembersActiveEquiv(s, after);
    SameMembersDmExactTwo(s, after);
    SameMembersAlphaOwners(s, after);
    SameMembersGroupOwners(s, after);
    SameMembersValidAndUnique(s, after);
    assert hasChat(after, chatId) by {
      reveal hasChat;
    }
    AppendMessageValid(s, after, chatId, textLen, by_);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "sendMessage", after);
    AppendMessageStepActive(s, "sendMessage", after, chatId, textLen, by_);
  }
}

lemma addReaction_ensures(s: MessagingState, messageId: int, emoji: string, by_: string)
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysAccountIdsUnique(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysNoTeamChats(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysChatIdsUnique(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysDmHasExactTwoMembers(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysAlphaGroupsOwnedByNpcs(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysGroupOwnersStayActive(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysMembersValidAndUnique(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysMessagesValid(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysReactionsValidAndUnique(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> alwaysBlocksValid(addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> stepMessageOnlyFromActiveMember(s, "addReaction", addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "addReaction", addReaction(s, messageId, emoji, by_)))
  ensures (inv(s) ==> canAddReaction(s, messageId, emoji, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "addReaction", addReaction(s, messageId, emoji, by_)))
{
  hide *;
  if inv(s) && canAddReaction(s, messageId, emoji, by_) {
    reveal inv, addReaction;
    var after := addReaction(s, messageId, emoji, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameDmMembers(s, after);
    FrameAlphaOwners(s, after);
    FrameGroupOwners(s, after);
    FrameMembersValid(s, after);
    FrameMessagesValid(s, after);
    AddReactionValid(s, messageId, emoji, by_);
    FrameBlocksValid(s, after);
    assert forall cid, uid :: isActiveMember(after, cid, uid) ==> isActiveMember(s, cid, uid) by {
      reveal isActiveMember;
    }
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "addReaction", after);
    StepNonSend(s, "addReaction", after);
  }
}

lemma readChat_ensures(s: MessagingState, chatId: int, by_: string)
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysAccountIdsUnique(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysNoTeamChats(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysChatIdsUnique(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysDmHasExactTwoMembers(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysGroupOwnersStayActive(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysMembersValidAndUnique(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysMessagesValid(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysReactionsValidAndUnique(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> alwaysBlocksValid(readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> stepMessageOnlyFromActiveMember(s, "readChat", readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "readChat", readChat(s, chatId, by_)))
  ensures (inv(s) ==> canReadChat(s, chatId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "readChat", readChat(s, chatId, by_)))
{
  hide *;
  if inv(s) && canReadChat(s, chatId, by_) {
    reveal inv, readChat;
    var after := readChat(s, chatId, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    SameMembersActiveEquiv(s, after);
    SameMembersDmExactTwo(s, after);
    SameMembersAlphaOwners(s, after);
    SameMembersGroupOwners(s, after);
    SameMembersValidAndUnique(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "readChat", after);
    StepNonSend(s, "readChat", after);
  }
}

lemma createGroup_ensures(s: MessagingState, chatType: ChatType, by_: string)
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysAccountIdsUnique(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysNoTeamChats(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysChatIdsUnique(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysDmHasExactTwoMembers(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysAlphaGroupsOwnedByNpcs(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysGroupOwnersStayActive(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysMembersValidAndUnique(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysMessagesValid(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysReactionsValidAndUnique(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> alwaysBlocksValid(createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> stepMessageOnlyFromActiveMember(s, "createGroup", createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "createGroup", createGroup(s, chatType, by_)))
  ensures (inv(s) ==> canCreateGroup(s, chatType, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "createGroup", createGroup(s, chatType, by_)))
{
  hide *;
  if inv(s) && canCreateGroup(s, chatType, by_) {
    reveal inv, createGroup, canCreateGroup;
    var after := createGroup(s, chatType, by_);
    var nc := Chat(s.lastChatId + 1, chatType, by_, "", "");
    FrameAccountIds(s, after);
    AppendChatNoTeam(s, after, nc);
    AppendChatIdsValid(s, after, nc);
    CreateGroupDmMembers(s, after, chatType, by_);
    CreateGroupOwners(s, after, chatType, by_);
    CreateGroupMembersValid(s, after, chatType, by_);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    AppendChatPendingInvites(s, after, nc);
    StepNonRespondInvite(s, "createGroup", after);
    StepNonSend(s, "createGroup", after);
  }
}

lemma inviteMember_ensures(s: MessagingState, chatId: int, targetId: string, by_: string)
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysAccountIdsUnique(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysNoTeamChats(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysChatIdsUnique(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysDmHasExactTwoMembers(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysGroupOwnersStayActive(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysMembersValidAndUnique(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysMessagesValid(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysReactionsValidAndUnique(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> alwaysBlocksValid(inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> stepMessageOnlyFromActiveMember(s, "inviteMember", inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "inviteMember", inviteMember(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteMember(s, chatId, targetId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "inviteMember", inviteMember(s, chatId, targetId, by_)))
{
  hide *;
  if inv(s) && canInviteMember(s, chatId, targetId, by_) {
    reveal inv, inviteMember, canInviteMember;
    var after := inviteMember(s, chatId, targetId, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameDmMembers(s, after);
    FrameAlphaOwners(s, after);
    FrameGroupOwners(s, after);
    FrameMembersValid(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    assert hasGroupChat(s, chatId) && !(isNpcAlphaChat(s, chatId)) by {
      reveal hasGroupChat, isUserGroupChat, isNpcAlphaChat, ProofLib.DistinctBy;
      ChatIdsDistinct(s);
    }
    AppendPendingInviteValid(s, after, chatId, targetId, by_, false);
    StepNonRespondInvite(s, "inviteMember", after);
    StepNonSend(s, "inviteMember", after);
  }
}

lemma inviteAlphaGroup_ensures(s: MessagingState, chatId: int, targetId: string, by_: string)
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysAccountIdsUnique(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysNoTeamChats(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysChatIdsUnique(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysDmHasExactTwoMembers(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysGroupOwnersStayActive(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysMembersValidAndUnique(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysMessagesValid(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysReactionsValidAndUnique(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> alwaysBlocksValid(inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> stepMessageOnlyFromActiveMember(s, "inviteAlphaGroup", inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "inviteAlphaGroup", inviteAlphaGroup(s, chatId, targetId, by_)))
  ensures (inv(s) ==> canInviteAlphaGroup(s, chatId, targetId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "inviteAlphaGroup", inviteAlphaGroup(s, chatId, targetId, by_)))
{
  hide *;
  if inv(s) && canInviteAlphaGroup(s, chatId, targetId, by_) {
    reveal inv, inviteAlphaGroup, canInviteAlphaGroup;
    var after := inviteAlphaGroup(s, chatId, targetId, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameDmMembers(s, after);
    FrameAlphaOwners(s, after);
    FrameGroupOwners(s, after);
    FrameMembersValid(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    assert hasGroupChat(s, chatId) by {
      reveal hasGroupChat;
    }
    AppendPendingInviteValid(s, after, chatId, targetId, by_, true);
    StepNonRespondInvite(s, "inviteAlphaGroup", after);
    StepNonSend(s, "inviteAlphaGroup", after);
  }
}

lemma respondInvite_ensures(s: MessagingState, inviteId: int, response: InviteResponse, by_: string)
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysAccountIdsUnique(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysNoTeamChats(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysChatIdsUnique(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysDmHasExactTwoMembers(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysAlphaGroupsOwnedByNpcs(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysGroupOwnersStayActive(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysMembersValidAndUnique(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysMessagesValid(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysReactionsValidAndUnique(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> alwaysBlocksValid(respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> stepMessageOnlyFromActiveMember(s, "respondInvite", respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "respondInvite", respondInvite(s, inviteId, response, by_)))
  ensures (inv(s) ==> canRespondInvite(s, inviteId, response, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "respondInvite", respondInvite(s, inviteId, response, by_)))
{
  hide *;
  if inv(s) && canRespondInvite(s, inviteId, response, by_) {
    reveal inv;
    var after := respondInvite(s, inviteId, response, by_);
    var targetChatId := Std.Collections.Seq.FoldLeft((acc: int, invite: PendingInvite) => (if (invite.id == inviteId) then invite.chatId else acc), 0, s.pendingInvites);
    assert after.accounts == s.accounts && after.chats == s.chats && after.lastChatId == s.lastChatId && after.messages == s.messages && after.lastMessageId == s.lastMessageId && after.reactions == s.reactions && after.blocks == s.blocks by {
      reveal respondInvite;
    }
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    StepNonSend(s, "respondInvite", after);
    RespondInviteExtract(s, inviteId, response, by_);
    RespondInviteStepRules(s, inviteId, response, by_, targetChatId);
    if response.Decline? {
      assert after.members == s.members by {
        reveal respondInvite;
      }
      FrameDmMembers(s, after);
      FrameAlphaOwners(s, after);
      FrameGroupOwners(s, after);
      FrameMembersValid(s, after);
      assert forall cid, uid :: isActiveMember(after, cid, uid) && !(cid == targetChatId && uid == by_) ==> isActiveMember(s, cid, uid) by {
        reveal isActiveMember;
      }
      RespondInvitePendingInvitesValid(s, inviteId, response, by_, targetChatId);
    } else {
      RespondInviteAcceptActiveFacts(s, inviteId, response, by_, targetChatId);
      RespondInviteAcceptDmMembers(s, inviteId, response, by_, targetChatId);
      SameMembersAlphaOwners(s, after);
      SameMembersGroupOwners(s, after);
      RespondInviteAcceptMembersValid(s, inviteId, response, by_, targetChatId);
      RespondInvitePendingInvitesValid(s, inviteId, response, by_, targetChatId);
    }
  }
}

lemma leaveGroup_ensures(s: MessagingState, chatId: int, by_: string)
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysAccountIdsUnique(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysNoTeamChats(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysChatIdsUnique(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysDmHasExactTwoMembers(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysGroupOwnersStayActive(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysMembersValidAndUnique(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysMessagesValid(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysReactionsValidAndUnique(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> alwaysBlocksValid(leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> stepMessageOnlyFromActiveMember(s, "leaveGroup", leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "leaveGroup", leaveGroup(s, chatId, by_)))
  ensures (inv(s) ==> canLeaveGroup(s, chatId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "leaveGroup", leaveGroup(s, chatId, by_)))
{
  hide *;
  if inv(s) && canLeaveGroup(s, chatId, by_) {
    reveal inv, leaveGroup;
    var after := leaveGroup(s, chatId, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    LeaveGroupChatFacts(s, chatId, by_);
    LeaveGroupActiveFacts(s, chatId, by_);
    LeaveGroupDmMembers(s, chatId, by_);
    LeaveGroupOwners(s, chatId, by_);
    LeaveGroupMembersValid(s, chatId, by_);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    FrameBlocksValid(s, after);
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "leaveGroup", after);
    StepNonSend(s, "leaveGroup", after);
  }
}

lemma blockUser_ensures(s: MessagingState, targetId: string, by_: string)
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysAccountIdsUnique(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysNoTeamChats(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysChatIdsUnique(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysDmHasExactTwoMembers(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysGroupOwnersStayActive(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysMembersValidAndUnique(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysMessagesValid(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysReactionsValidAndUnique(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> alwaysBlocksValid(blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> stepMessageOnlyFromActiveMember(s, "blockUser", blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "blockUser", blockUser(s, targetId, by_)))
  ensures (inv(s) ==> canBlockUser(s, targetId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "blockUser", blockUser(s, targetId, by_)))
{
  hide *;
  if inv(s) && canBlockUser(s, targetId, by_) {
    reveal inv, blockUser;
    var after := blockUser(s, targetId, by_);
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameDmMembers(s, after);
    FrameAlphaOwners(s, after);
    FrameGroupOwners(s, after);
    FrameMembersValid(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    BlockUserValid(s, targetId, by_);
    assert forall cid, uid :: isActiveMember(after, cid, uid) ==> isActiveMember(s, cid, uid) by {
      reveal isActiveMember;
    }
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "blockUser", after);
    StepNonSend(s, "blockUser", after);
  }
}

lemma unblockUser_ensures(s: MessagingState, targetId: string, by_: string)
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysAccountIdsUnique(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysNoTeamChats(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysChatIdsUnique(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysDmHasExactTwoMembers(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysAlphaGroupsOwnedByNpcs(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysGroupOwnersStayActive(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysMembersValidAndUnique(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysMessagesValid(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysReactionsValidAndUnique(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysPendingInvitesValidAndDisjointFromActiveMembers(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> alwaysBlocksValid(unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> stepMessageOnlyFromActiveMember(s, "unblockUser", unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> stepDeclinedInviteDoesNotAddMember(s, "unblockUser", unblockUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnblockUser(s, targetId, by_) ==> stepAcceptedInviteAddsMemberAndRemovesPending(s, "unblockUser", unblockUser(s, targetId, by_)))
{
  hide *;
  if inv(s) && canUnblockUser(s, targetId, by_) {
    reveal inv;
    var after := unblockUser(s, targetId, by_);
    assert after.accounts == s.accounts && after.chats == s.chats && after.lastChatId == s.lastChatId && after.members == s.members && after.messages == s.messages && after.lastMessageId == s.lastMessageId && after.reactions == s.reactions && after.pendingInvites == s.pendingInvites && after.lastInviteId == s.lastInviteId && after.acceptedInvitesCount == s.acceptedInvitesCount && after.declinedInvitesCount == s.declinedInvitesCount by {
      reveal unblockUser;
    }
    FrameAccountIds(s, after);
    FrameNoTeamChats(s, after);
    FrameChatIds(s, after);
    FrameDmMembers(s, after);
    FrameAlphaOwners(s, after);
    FrameGroupOwners(s, after);
    FrameMembersValid(s, after);
    FrameMessagesValid(s, after);
    FrameReactionsValid(s, after);
    UnblockUserValid(s, targetId, by_);
    assert forall cid, uid :: isActiveMember(after, cid, uid) ==> isActiveMember(s, cid, uid) by {
      reveal isActiveMember;
    }
    FramePendingInvites(s, after);
    StepNonRespondInvite(s, "unblockUser", after);
    StepNonSend(s, "unblockUser", after);
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  AccountIdsBridge(s);
  ChatIdsBridge(s);
  DmMembersBridge(s);
  MembersBridge(s);
  MessagesBridge(s);
  ReactionsBridge(s);
  BlocksBridge(s);
  PendingInvitesBridge(s);
  forall a | a in s.accounts
    ensures |ProofLib.Filter((b: Account) => (b.id == a.id), s.accounts)| == 1
  {
    var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
    ProofLib.FilterOne((b: Account) => (b.id == a.id), s.accounts, i);
  }
}
