# Messaging and alpha groups

Direct messages, user group chats, NPC-driven alpha groups (`NpcAlpha`) and alpha-group invites, message reactions, read state, and block enforcement for Feed (`feed.fun`). Legacy `team` chats (`group_type = 'team'`) are permanently retired (PRD §0.2, §3, §13) and explicitly refused.

## Domain

### Accounts, chats, memberships, messages, reactions, and invites

Every chat is either a two-party `Direct` thread, a `UserGroup`, or an NPC-owned `NpcAlpha` chat (PRD §9.5). `TeamChat` exists in `ChatType` only so group creation guards explicitly reject it; no `TeamChat` ever enters state.

```quint
type ActorRole = HumanUser | NpcActor
type Account = { id: str, role: ActorRole }
type ChatType = Direct | UserGroup | NpcAlpha | TeamChat
type MemberRole = Owner | Member
type InviteResponse = Accept | Decline

type Chat = {
  id: int,
  chatType: ChatType,
  ownerId: str,
  peerA: str,
  peerB: str,
}
type ChatMember = {
  chatId: int,
  userId: str,
  role: MemberRole,
  active: bool,
  joinedViaInvite: bool,
  hasRead: bool,
}
type ChatMessage = {
  id: int,
  chatId: int,
  senderId: str,
  textLen: int,
}
type MessageReaction = {
  messageId: int,
  userId: str,
  emoji: str,
}
type PendingInvite = {
  id: int,
  chatId: int,
  invitedUserId: str,
  invitedBy: str,
  isAlpha: bool,
}
type BlockPair = { blockerId: str, blockedId: str }

type MessagingState = {
  accounts: List[Account],
  chats: List[Chat],
  members: List[ChatMember],
  messages: List[ChatMessage],
  reactions: List[MessageReaction],
  pendingInvites: List[PendingInvite],
  blocks: List[BlockPair],
  lastChatId: int,
  lastMessageId: int,
  lastInviteId: int,
  acceptedInvitesCount: int,
  declinedInvitesCount: int,
}

pure val maxMessageChars = 500
pure val maxActiveNpcAlphaGroups = 10
```

### Initial messaging state

Begins with two human players (`"alice"`, `"bob"`), one NPC character (`"npc1"`), and no chats, messages, reactions, pending invites, or blocks.

```quint
pure val initial: MessagingState = {
  accounts: List(
    { id: "alice", role: HumanUser },
    { id: "bob", role: HumanUser },
    { id: "npc1", role: NpcActor }
  ),
  chats: List(),
  members: List(),
  messages: List(),
  reactions: List(),
  pendingInvites: List(),
  blocks: List(),
  lastChatId: 0,
  lastMessageId: 0,
  lastInviteId: 0,
  acceptedInvitesCount: 0,
  declinedInvitesCount: 0,
}
```

### What the simulator tries

Sample sets include valid actors and an unknown `"outsider"`, message lengths at and beyond both bounds, valid emoji and the empty string, and chat, message, and invite IDs.

```quint
pure val byValues = Set("alice", "bob", "npc1", "outsider")
pure val accountIdValues = Set("alice", "bob", "npc1", "outsider")
pure val targetIdValues = Set("alice", "bob", "npc1", "outsider")
pure val recipientIdValues = Set("alice", "bob", "npc1", "outsider")
pure val chatIdValues = Set(0, 1, 2, 99)
pure val messageIdValues = Set(0, 1, 2, 99)
pure val inviteIdValues = Set(0, 1, 2, 99)
pure val textLenValues = Set(0, 1, 64, 500, 501)
pure val emojiValues = Set("", "fire", "eyes")
```

### Shared lookups

Helpers resolve account roles, active chat memberships, DM peer matching, block symmetry, and pending invites.

```quint
pure def hasAccount(s: MessagingState, accountId: str): bool =
  s.accounts.some(a => a.id == accountId)

pure def isNpc(s: MessagingState, accountId: str): bool =
  s.accounts.some(a => a.id == accountId and a.role == NpcActor)

pure def hasChat(s: MessagingState, chatId: int): bool =
  chatId > 0 and s.chats.some(c => c.id == chatId)

pure def isDirectChat(s: MessagingState, chatId: int): bool =
  s.chats.some(c => c.id == chatId and c.chatType == Direct)

pure def isUserGroupChat(s: MessagingState, chatId: int): bool =
  s.chats.some(c => c.id == chatId and c.chatType == UserGroup)

pure def isNpcAlphaChat(s: MessagingState, chatId: int): bool =
  s.chats.some(c => c.id == chatId and c.chatType == NpcAlpha)

pure def hasGroupChat(s: MessagingState, chatId: int): bool =
  isUserGroupChat(s, chatId) or isNpcAlphaChat(s, chatId)

pure def chatOwnerOf(s: MessagingState, chatId: int): str =
  s.chats.foldl("", (acc, c) => if (c.id == chatId) c.ownerId else acc)

pure def sameDmPeers(c: Chat, accountId: str, targetId: str): bool =
  c.chatType == Direct
    and ((c.peerA == accountId and c.peerB == targetId)
      or (c.peerA == targetId and c.peerB == accountId))

pure def findDmChatId(s: MessagingState, accountId: str, targetId: str): int =
  s.chats.foldl(0, (acc, c) => if (sameDmPeers(c, accountId, targetId)) c.id else acc)

pure def hasDirectBlock(s: MessagingState, accountId: str, targetId: str): bool =
  s.blocks.some(b => b.blockerId == accountId and b.blockedId == targetId)

pure def isBlockedBetween(s: MessagingState, accountId: str, targetId: str): bool =
  hasDirectBlock(s, accountId, targetId) or hasDirectBlock(s, targetId, accountId)

pure def isBlockedDirectChat(s: MessagingState, chatId: int): bool =
  s.chats.some(c => c.id == chatId and c.chatType == Direct and isBlockedBetween(s, c.peerA, c.peerB))

pure def isActiveMember(s: MessagingState, chatId: int, accountId: str): bool =
  s.members.some(m => m.chatId == chatId and m.userId == accountId and m.active)

pure def hasMemberRow(s: MessagingState, chatId: int, accountId: str): bool =
  s.members.some(m => m.chatId == chatId and m.userId == accountId)

pure def hasMessage(s: MessagingState, messageId: int): bool =
  messageId > 0 and s.messages.some(m => m.id == messageId)

pure def messageChatIdOf(s: MessagingState, messageId: int): int =
  s.messages.foldl(0, (acc, m) => if (m.id == messageId) m.chatId else acc)

pure def hasReaction(s: MessagingState, messageId: int, accountId: str, emoji: str): bool =
  s.reactions.some(r => r.messageId == messageId and r.userId == accountId and r.emoji == emoji)

pure def hasPendingInvite(s: MessagingState, chatId: int, accountId: str): bool =
  s.pendingInvites.some(invite => invite.chatId == chatId and invite.invitedUserId == accountId)

pure def activeNpcAlphaCount(s: MessagingState, accountId: str): int =
  s.members.select(m => m.userId == accountId and m.active and isNpcAlphaChat(s, m.chatId)).length()
```

## Story: Direct messages, chat messages, and reactions

> As a user, I want to start or continue a direct message with a non-blocked user, send messages in chats where I am an active member, react to messages, and mark chats read.

### Sending a DM reuses any existing thread or auto-creates one for a non-blocked pair

A DM cannot be opened or continued with self or when either party has blocked the other.

```quint
pure def canSendDm(s: MessagingState, recipientId: str, textLen: int, by: str): bool =
  and {
    hasAccount(s, by),
    hasAccount(s, recipientId),
    recipientId != by,
    1 <= textLen and textLen <= maxMessageChars,
    not(isBlockedBetween(s, by, recipientId)),
  }

pure def sendDm(s: MessagingState, recipientId: str, textLen: int, by: str): MessagingState =
  val existingId = findDmChatId(s, by, recipientId)
  val targetChatId = if (existingId > 0) existingId else s.lastChatId + 1
  val nextLastChatId = if (existingId > 0) s.lastChatId else targetChatId
  val newMsgId = s.lastMessageId + 1
  val chatsAfter = if (existingId > 0) s.chats else s.chats.append({
    id: targetChatId,
    chatType: Direct,
    ownerId: "",
    peerA: by,
    peerB: recipientId,
  })
  val membersAfter = if (existingId > 0)
    s.members.listMap(m => if (m.chatId == targetChatId and m.userId == by) { ...m, hasRead: true } else m)
  else
    s.members
      .append({ chatId: targetChatId, userId: by, role: Member, active: true, joinedViaInvite: false, hasRead: true })
      .append({ chatId: targetChatId, userId: recipientId, role: Member, active: true, joinedViaInvite: false, hasRead: false })
  { ...s,
    lastChatId: nextLastChatId,
    lastMessageId: newMsgId,
    chats: chatsAfter,
    members: membersAfter,
    messages: s.messages.append({ id: newMsgId, chatId: targetChatId, senderId: by, textLen: textLen }),
  }
```

### Only active members can send messages, add reactions, or mark a chat read

```quint
pure def canSendMessage(s: MessagingState, chatId: int, textLen: int, by: str): bool =
  and {
    hasAccount(s, by),
    hasChat(s, chatId),
    1 <= textLen and textLen <= maxMessageChars,
    isActiveMember(s, chatId, by),
    not(isBlockedDirectChat(s, chatId)),
  }

pure def sendMessage(s: MessagingState, chatId: int, textLen: int, by: str): MessagingState =
  val newMsgId = s.lastMessageId + 1
  { ...s,
    lastMessageId: newMsgId,
    messages: s.messages.append({ id: newMsgId, chatId: chatId, senderId: by, textLen: textLen }),
    members: s.members.listMap(m =>
      if (m.chatId == chatId and m.userId == by and m.active) { ...m, hasRead: true } else m),
  }

pure def canAddReaction(s: MessagingState, messageId: int, emoji: str, by: str): bool =
  val chatId = messageChatIdOf(s, messageId)
  and {
    hasAccount(s, by),
    hasMessage(s, messageId),
    emoji != "",
    isActiveMember(s, chatId, by),
    not(isBlockedDirectChat(s, chatId)),
    not(hasReaction(s, messageId, by, emoji)),
  }

pure def addReaction(s: MessagingState, messageId: int, emoji: str, by: str): MessagingState =
  { ...s, reactions: s.reactions.append({ messageId: messageId, userId: by, emoji: emoji }) }

pure def canReadChat(s: MessagingState, chatId: int, by: str): bool =
  and {
    hasAccount(s, by),
    hasChat(s, chatId),
    s.messages.some(msg => msg.chatId == chatId),
    s.members.some(m => m.chatId == chatId and m.userId == by and m.active and not(m.hasRead)),
  }

pure def readChat(s: MessagingState, chatId: int, by: str): MessagingState =
  { ...s,
    members: s.members.listMap(m =>
      if (m.chatId == chatId and m.userId == by and m.active) { ...m, hasRead: true } else m),
  }
```

## Story: Create groups, invite to alpha groups, respond to invites, and leave

> As a user or NPC, I want to create non-team group chats, send group or NPC alpha-group invites to non-blocked accounts, accept or decline invites, and leave group chats.

### Team chats are explicitly refused and only NPCs create alpha groups

`canCreateGroup` rejects `TeamChat` (retired per PRD §0.2 and §13) and `Direct` (reserved for `sendDm`). Only `NpcActor` accounts may create `NpcAlpha` groups.

```quint
pure def canCreateGroup(s: MessagingState, chatType: ChatType, by: str): bool =
  hasAccount(s, by)
    and chatType != TeamChat
    and chatType != Direct
    and (chatType == UserGroup or (chatType == NpcAlpha and isNpc(s, by)))

pure def createGroup(s: MessagingState, chatType: ChatType, by: str): MessagingState =
  val newChatId = s.lastChatId + 1
  { ...s,
    lastChatId: newChatId,
    chats: s.chats.append({ id: newChatId, chatType: chatType, ownerId: by, peerA: "", peerB: "" }),
    members: s.members.append({ chatId: newChatId, userId: by, role: Owner, active: true, joinedViaInvite: false, hasRead: true }),
  }
```

### Group and NPC alpha-group invites require active membership and exclude blocked or already-invited targets

`inviteMember` sends invitations to `UserGroup` chats; `inviteAlphaGroup` allows an NPC owner to invite a human player into an `NpcAlpha` chat (PRD §9.5). Neither works when either party has blocked the other.

```quint
pure def canInviteMember(s: MessagingState, chatId: int, targetId: str, by: str): bool =
  and {
    hasAccount(s, by),
    hasAccount(s, targetId),
    targetId != by,
    isUserGroupChat(s, chatId),
    isActiveMember(s, chatId, by),
    not(isActiveMember(s, chatId, targetId)),
    not(hasPendingInvite(s, chatId, targetId)),
    not(isBlockedBetween(s, by, targetId)),
  }

pure def inviteMember(s: MessagingState, chatId: int, targetId: str, by: str): MessagingState =
  val newInviteId = s.lastInviteId + 1
  { ...s,
    lastInviteId: newInviteId,
    pendingInvites: s.pendingInvites.append({
      id: newInviteId,
      chatId: chatId,
      invitedUserId: targetId,
      invitedBy: by,
      isAlpha: false,
    }),
  }

pure def canInviteAlphaGroup(s: MessagingState, chatId: int, targetId: str, by: str): bool =
  and {
    hasAccount(s, by),
    isNpc(s, by),
    hasAccount(s, targetId),
    not(isNpc(s, targetId)),
    targetId != by,
    isNpcAlphaChat(s, chatId),
    chatOwnerOf(s, chatId) == by,
    isActiveMember(s, chatId, by),
    not(isActiveMember(s, chatId, targetId)),
    not(hasPendingInvite(s, chatId, targetId)),
    not(isBlockedBetween(s, by, targetId)),
  }

pure def inviteAlphaGroup(s: MessagingState, chatId: int, targetId: str, by: str): MessagingState =
  val newInviteId = s.lastInviteId + 1
  { ...s,
    lastInviteId: newInviteId,
    pendingInvites: s.pendingInvites.append({
      id: newInviteId,
      chatId: chatId,
      invitedUserId: targetId,
      invitedBy: by,
      isAlpha: true,
    }),
  }
```

### Responding to an invite removes the pending invite, adds membership only on Accept, and checks blocks

Declining removes the pending invite without adding or activating membership. Accepting removes the pending invite and activates membership unless blocked by or blocking the inviter or over the NPC alpha-group cap.

```quint
pure def canRespondInvite(s: MessagingState, inviteId: int, response: InviteResponse, by: str): bool =
  hasAccount(s, by)
    and s.pendingInvites.some(invite =>
      invite.id == inviteId
        and invite.invitedUserId == by
        and (response == Decline
          or (not(isBlockedBetween(s, invite.invitedBy, by))
            and not(isActiveMember(s, invite.chatId, by))
            and (not(invite.isAlpha) or activeNpcAlphaCount(s, by) < maxActiveNpcAlphaGroups))))

pure def respondInvite(s: MessagingState, inviteId: int, response: InviteResponse, by: str): MessagingState =
  val targetChatId = s.pendingInvites.foldl(0, (acc, invite) => if (invite.id == inviteId) invite.chatId else acc)
  val remaining = s.pendingInvites.select(invite => invite.id != inviteId)
  val existed = hasMemberRow(s, targetChatId, by)
  val nextMembers = if (response == Decline)
    s.members
  else if (existed)
    s.members.listMap(m =>
      if (m.chatId == targetChatId and m.userId == by)
        { ...m, active: true, joinedViaInvite: true, hasRead: false }
      else m)
  else
    s.members.append({ chatId: targetChatId, userId: by, role: Member, active: true, joinedViaInvite: true, hasRead: false })
  { ...s,
    pendingInvites: remaining,
    members: nextMembers,
    acceptedInvitesCount: if (response == Accept) s.acceptedInvitesCount + 1 else s.acceptedInvitesCount,
    declinedInvitesCount: if (response == Decline) s.declinedInvitesCount + 1 else s.declinedInvitesCount,
  }
```

### Non-owner group members can leave group chats, and blocking enforces DM and invite isolation

Users cannot leave `Direct` threads (preserving two-member DMs) or groups they own. Blocking prevents future DMs, messages on blocked DMs, invites, and accepting invites.

```quint
pure def canLeaveGroup(s: MessagingState, chatId: int, by: str): bool =
  hasAccount(s, by)
    and hasGroupChat(s, chatId)
    and chatOwnerOf(s, chatId) != by
    and isActiveMember(s, chatId, by)

pure def leaveGroup(s: MessagingState, chatId: int, by: str): MessagingState =
  { ...s,
    members: s.members.listMap(m =>
      if (m.chatId == chatId and m.userId == by) { ...m, active: false, hasRead: false } else m),
  }

pure def canBlockUser(s: MessagingState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasAccount(s, targetId) and targetId != by and not(hasDirectBlock(s, by, targetId))

pure def blockUser(s: MessagingState, targetId: str, by: str): MessagingState =
  { ...s, blocks: s.blocks.append({ blockerId: by, blockedId: targetId }) }

pure def canUnblockUser(s: MessagingState, targetId: str, by: str): bool =
  hasAccount(s, by) and hasDirectBlock(s, by, targetId)

pure def unblockUser(s: MessagingState, targetId: str, by: str): MessagingState =
  { ...s,
    blocks: s.blocks.select(b => not(b.blockerId == by and b.blockedId == targetId)),
  }
```

## Story: Membership, invite, and safety invariants

> As a platform operator, I want chat membership, DM cardinality, invite resolution, and retired team-chat bans guaranteed by the model.

### No Team chats exist, DMs always have exactly two active members, and alpha groups stay NPC-owned

```quint
pure def alwaysAccountIdsUnique(s: MessagingState): bool =
  s.accounts.every(a => a.id != "" and s.accounts.select(b => b.id == a.id).length() == 1)

pure def alwaysNoTeamChats(s: MessagingState): bool =
  s.chats.every(c => c.chatType != TeamChat)

pure def alwaysChatIdsUnique(s: MessagingState): bool =
  s.lastChatId >= 0
    and s.chats.every(c => 1 <= c.id and c.id <= s.lastChatId)
    and s.chats.every(a => s.chats.select(b => b.id == a.id).length() == 1)

pure def alwaysDmHasExactTwoMembers(s: MessagingState): bool =
  s.chats.every(c => (c.chatType == Direct) implies and {
    c.ownerId == "",
    c.peerA != "" and c.peerB != "" and c.peerA != c.peerB,
    hasAccount(s, c.peerA) and hasAccount(s, c.peerB),
    isActiveMember(s, c.id, c.peerA) and isActiveMember(s, c.id, c.peerB),
    s.members.select(m => m.chatId == c.id and m.active).length() == 2,
    s.chats.select(b => sameDmPeers(b, c.peerA, c.peerB)).length() == 1,
  })

pure def alwaysAlphaGroupsOwnedByNpcs(s: MessagingState): bool =
  s.chats.every(c => (c.chatType == NpcAlpha) implies (isNpc(s, c.ownerId) and isActiveMember(s, c.id, c.ownerId)))

pure def alwaysGroupOwnersStayActive(s: MessagingState): bool =
  s.chats.every(c => (c.chatType != Direct) implies (hasAccount(s, c.ownerId) and isActiveMember(s, c.id, c.ownerId)))
```

### Memberships, messages, reactions, pending invites, and blocks stay unique and referentially valid

```quint
pure def alwaysMembersValidAndUnique(s: MessagingState): bool =
  s.members.every(m => and {
    hasChat(s, m.chatId),
    hasAccount(s, m.userId),
    isDirectChat(s, m.chatId) implies m.active,
    s.members.select(b => b.chatId == m.chatId and b.userId == m.userId).length() == 1,
  })

pure def alwaysMessagesValid(s: MessagingState): bool =
  s.lastMessageId >= 0
    and s.messages.every(msg => and {
      1 <= msg.id and msg.id <= s.lastMessageId,
      1 <= msg.textLen and msg.textLen <= maxMessageChars,
      hasChat(s, msg.chatId),
      hasAccount(s, msg.senderId),
      s.messages.select(b => b.id == msg.id).length() == 1,
    })

pure def alwaysReactionsValidAndUnique(s: MessagingState): bool =
  s.reactions.every(r => and {
    hasMessage(s, r.messageId),
    hasAccount(s, r.userId),
    r.emoji != "",
    s.reactions.select(b => b.messageId == r.messageId and b.userId == r.userId and b.emoji == r.emoji).length() == 1,
  })

pure def alwaysPendingInvitesValidAndDisjointFromActiveMembers(s: MessagingState): bool =
  s.lastInviteId >= 0
    and s.acceptedInvitesCount >= 0
    and s.declinedInvitesCount >= 0
    and s.pendingInvites.every(invite => and {
      1 <= invite.id and invite.id <= s.lastInviteId,
      hasGroupChat(s, invite.chatId),
      hasAccount(s, invite.invitedUserId),
      hasAccount(s, invite.invitedBy),
      invite.invitedUserId != invite.invitedBy,
      invite.isAlpha == isNpcAlphaChat(s, invite.chatId),
      not(isActiveMember(s, invite.chatId, invite.invitedUserId)),
      s.pendingInvites.select(b => b.id == invite.id).length() == 1,
      s.pendingInvites.select(b => b.chatId == invite.chatId and b.invitedUserId == invite.invitedUserId).length() == 1,
    })

pure def alwaysBlocksValid(s: MessagingState): bool =
  s.blocks.every(b => and {
    b.blockerId != b.blockedId,
    hasAccount(s, b.blockerId),
    hasAccount(s, b.blockedId),
    s.blocks.select(c => c.blockerId == b.blockerId and c.blockedId == b.blockedId).length() == 1,
  })
```

### Only active members send messages, declining adds no member, and accepting adds a member while clearing the pending invite

```quint
pure def stepMessageOnlyFromActiveMember(before: MessagingState, via: str, after: MessagingState): bool =
  (via == "sendMessage" or via == "sendDm") implies after.messages.every(msg =>
    before.messages.some(b => b.id == msg.id) or isActiveMember(after, msg.chatId, msg.senderId))

pure def stepDeclinedInviteDoesNotAddMember(before: MessagingState, via: str, after: MessagingState): bool =
  (via == "respondInvite" and after.declinedInvitesCount > before.declinedInvitesCount) implies
    after.members.every(m => not(m.active) or before.members.some(b => b.chatId == m.chatId and b.userId == m.userId and b.active))

pure def stepAcceptedInviteAddsMemberAndRemovesPending(before: MessagingState, via: str, after: MessagingState): bool =
  (via == "respondInvite" and after.acceptedInvitesCount > before.acceptedInvitesCount) implies and {
    after.pendingInvites.length() == before.pendingInvites.length() - 1,
    after.members.some(m => m.active and m.joinedViaInvite and not(before.members.some(b => b.chatId == m.chatId and b.userId == m.userId and b.active))),
  }
```

### Key DM, alpha invite, decline, reaction, and leave journeys are reachable

```quint
pure def sometimesDmCreatedAndMessaged(s: MessagingState): bool =
  s.chats.some(c => c.chatType == Direct and s.messages.some(m => m.chatId == c.id))

pure val eval_witness_sometimesDmCreatedAndMessaged = (
  ("sendDm", "bob", 64, "alice"),
  ("sendMessage", 1, 64, "bob")
)

pure def sometimesAlphaInviteAcceptedAndChatRead(s: MessagingState): bool =
  s.members.some(m =>
    m.active
      and m.joinedViaInvite
      and m.hasRead
      and not(isNpc(s, m.userId))
      and isNpcAlphaChat(s, m.chatId)
      and s.messages.some(msg => msg.chatId == m.chatId))

pure val eval_witness_sometimesAlphaInviteAcceptedAndChatRead = (
  ("createGroup", NpcAlpha, "npc1"),
  ("sendMessage", 1, 64, "npc1"),
  ("inviteAlphaGroup", 1, "alice", "npc1"),
  ("respondInvite", 1, Accept, "alice"),
  ("readChat", 1, "alice")
)

pure def sometimesInviteDeclined(s: MessagingState): bool =
  s.declinedInvitesCount > 0

pure val eval_witness_sometimesInviteDeclined = (
  ("createGroup", NpcAlpha, "npc1"),
  ("inviteAlphaGroup", 1, "bob", "npc1"),
  ("respondInvite", 1, Decline, "bob")
)

pure def sometimesReactionAdded(s: MessagingState): bool =
  s.reactions.length() > 0

pure val eval_witness_sometimesReactionAdded = (
  ("sendDm", "bob", 64, "alice"),
  ("addReaction", 1, "fire", "bob")
)

pure def sometimesMemberLeftGroup(s: MessagingState): bool =
  s.members.some(m => not(m.active))

pure val eval_witness_sometimesMemberLeftGroup = (
  ("createGroup", UserGroup, "alice"),
  ("inviteMember", 1, "bob", "alice"),
  ("respondInvite", 1, Accept, "bob"),
  ("leaveGroup", 1, "bob")
)
```
