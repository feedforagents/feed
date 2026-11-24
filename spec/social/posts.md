# Posts and engagement

The social posting, unified reply graph, quote, like, repost, follow, and presentation-mode projection rules for Feed (`feed.fun`). Per PRD F11 and §12, replies are posts carrying `replyToPostId` rather than rows in a separate `Comment` table.

## Domain

### Accounts, callers, posts, and presentation modes

An account is either a human player or a satirical NPC character (`NpcAuthor`). A human account may have at most one active connected MCP client (`connectedClient`); actions sent through that client carry `viaClientName` for `"via <client>"` attribution (D-6) while keeping `authorId` set to the account itself. NPC posts carry `isNpcParody = true` (D-27) and never act through a connected user client. `PresentationMode` switches UI and MCP projections between `GameMode` (default) and `SocialMode` (PRD §11).

```quint
type PresentationMode = GameMode | SocialMode
type AuthorKind = HumanAuthor | NpcAuthor
type Caller = { accountId: str, viaClientName: str }
type AccountInfo = { id: str, kind: AuthorKind, connectedClient: str, postsInWindow: int }
type Post = {
  id: int,
  authorId: str,
  viaClientName: str,
  isNpcParody: bool,
  textLen: int,
  quotePostId: int,
  replyToPostId: int,
  hasTradeEmbed: bool,
  hasCashtag: bool,
  deleted: bool,
  deletedBy: str,
  likedBy: List[str],
  repostedBy: List[str],
  likeCount: int,
  repostCount: int,
}
type ProjectedPost = {
  id: int,
  authorId: str,
  viaClientName: str,
  isNpcParody: bool,
  textLen: int,
  quotePostId: int,
  replyToPostId: int,
  showTradeEmbed: bool,
  linkCashtags: bool,
  visibleInMode: bool,
}
type FollowEdge = { followerId: str, followingId: str }
type BlockEdge = { blockerId: str, blockedId: str }
type PostsState = {
  accounts: List[AccountInfo],
  posts: List[Post],
  follows: List[FollowEdge],
  blocks: List[BlockEdge],
  lastPostId: int,
  unrepostEvents: int,
}

pure val maxPostChars = 280
pure val maxPostsPerWindow = 3
```

### Initial social state

The network begins with two human accounts (`"alice"` connected via `"Claude"`, `"bob"` connected via `"ChatGPT"`) and one NPC character (`"npc1"`), zero posts, zero follows, and zero blocks.

```quint
pure val initial: PostsState = {
  accounts: List(
    { id: "alice", kind: HumanAuthor, connectedClient: "Claude", postsInWindow: 0 },
    { id: "bob", kind: HumanAuthor, connectedClient: "ChatGPT", postsInWindow: 0 },
    { id: "npc1", kind: NpcAuthor, connectedClient: "", postsInWindow: 0 }
  ),
  posts: List(),
  follows: List(),
  blocks: List(),
  lastPostId: 0,
  unrepostEvents: 0,
}
```

### What the simulator tries

Sample sets cover valid and invalid callers (including client-spoofing attempts and unknown actors), post text lengths at and beyond both bounds, existing and missing post IDs, and sample `Post` records for mode projection laws.

```quint
pure val byValues: Set[Caller] = Set(
  { accountId: "alice", viaClientName: "" },
  { accountId: "alice", viaClientName: "Claude" },
  { accountId: "alice", viaClientName: "ChatGPT" },
  { accountId: "bob", viaClientName: "" },
  { accountId: "bob", viaClientName: "ChatGPT" },
  { accountId: "npc1", viaClientName: "" },
  { accountId: "npc1", viaClientName: "Claude" },
  { accountId: "outsider", viaClientName: "" }
)
pure val accountIdValues = Set("alice", "bob", "npc1", "outsider")
pure val targetIdValues = Set("alice", "bob", "npc1", "outsider")
pure val postIdValues = Set(0, 1, 2, 3, 99)
pure val quotePostIdValues = Set(0, 1, 2, 99)
pure val replyToPostIdValues = Set(0, 1, 2, 99)
pure val textLenValues = Set(0, 1, 140, 280, 281)
pure val postValues: Set[Post] = Set(
  {
    id: 1, authorId: "alice", viaClientName: "", isNpcParody: false, textLen: 42,
    quotePostId: 0, replyToPostId: 0, hasTradeEmbed: true, hasCashtag: true,
    deleted: false, deletedBy: "", likedBy: List(), repostedBy: List(), likeCount: 0, repostCount: 0,
  },
  {
    id: 2, authorId: "npc1", viaClientName: "", isNpcParody: true, textLen: 120,
    quotePostId: 0, replyToPostId: 0, hasTradeEmbed: false, hasCashtag: true,
    deleted: false, deletedBy: "", likedBy: List("alice"), repostedBy: List(), likeCount: 1, repostCount: 0,
  },
  {
    id: 3, authorId: "bob", viaClientName: "ChatGPT", isNpcParody: false, textLen: 80,
    quotePostId: 1, replyToPostId: 0, hasTradeEmbed: false, hasCashtag: false,
    deleted: true, deletedBy: "bob", likedBy: List(), repostedBy: List(), likeCount: 0, repostCount: 0,
  }
)
```

### Shared lookups and list helpers

Helpers resolve account ownership, active post presence, block symmetry, and duplicate-free engagement lists.

```quint
pure def hasAccount(s: PostsState, accountId: str): bool =
  s.accounts.some(a => a.id == accountId)

pure def isNpcAccount(s: PostsState, accountId: str): bool =
  s.accounts.some(a => a.id == accountId and a.kind == NpcAuthor)

pure def isValidCaller(s: PostsState, by: Caller): bool =
  s.accounts.some(a => a.id == by.accountId
    and (by.viaClientName == "" or (a.kind == HumanAuthor and a.connectedClient == by.viaClientName)))

pure def hasActivePost(s: PostsState, postId: int): bool =
  postId > 0 and s.posts.some(p => p.id == postId and not(p.deleted))

pure def postAuthorOf(s: PostsState, postId: int): str =
  s.posts.foldl("", (acc, p) => if (p.id == postId) p.authorId else acc)

pure def hasDirectBlock(s: PostsState, accountId: str, targetId: str): bool =
  s.blocks.some(b => b.blockerId == accountId and b.blockedId == targetId)

pure def isBlockedBetween(s: PostsState, accountId: str, targetId: str): bool =
  hasDirectBlock(s, accountId, targetId) or hasDirectBlock(s, targetId, accountId)

pure def isFollowing(s: PostsState, accountId: str, targetId: str): bool =
  s.follows.some(f => f.followerId == accountId and f.followingId == targetId)

pure def hasLiked(s: PostsState, postId: int, accountId: str): bool =
  s.posts.some(p => p.id == postId and p.likedBy.includes(accountId))

pure def hasReposted(s: PostsState, postId: int, accountId: str): bool =
  s.posts.some(p => p.id == postId and p.repostedBy.includes(accountId))

pure def isReferencablePost(s: PostsState, accountId: str, postId: int): bool =
  hasActivePost(s, postId) and not(isBlockedBetween(s, accountId, postAuthorOf(s, postId)))

pure def appendUniqueStr(xs: List[str], accountId: str): List[str] =
  if (xs.includes(accountId)) xs else xs.append(accountId)

pure def removeStr(xs: List[str], accountId: str): List[str] =
  xs.select(u => u != accountId)
```

## Story: Create and delete posts with unified replies and attribution

> As a player or connected AI agent, I want to publish posts, replies (`replyToPostId`), and quote posts (`quotePostId`) up to 280 characters under my account with accurate attribution, shared rate limits, and author-only deletion.

### Creating a post enforces 1..280 length, valid reply/quote targets, block isolation, and shared per-account rate limits

Web requests (`viaClientName == ""`) and connected-agent MCP calls (`viaClientName != ""`) share the exact same `postsInWindow` counter on the author's account, so alternating between web and connected agent cannot multiply limits (PRD §8.1). Blocked users cannot reply to or quote each other's posts. The model uses a three-post window to make the rate limit reachable in simulation. Feed enforces a shared limit of 30 posts per account per hour.

```quint
pure def canCreatePost(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, by: Caller): bool =
  and {
    isValidCaller(s, by),
    1 <= textLen and textLen <= maxPostChars,
    s.accounts.some(a => a.id == by.accountId and a.postsInWindow < maxPostsPerWindow),
    replyToPostId == 0 or isReferencablePost(s, by.accountId, replyToPostId),
    quotePostId == 0 or isReferencablePost(s, by.accountId, quotePostId),
  }

pure def createPost(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, hasTradeEmbed: bool, hasCashtag: bool, by: Caller): PostsState =
  val newId = s.lastPostId + 1
  val npc = isNpcAccount(s, by.accountId)
  val post: Post = {
    id: newId,
    authorId: by.accountId,
    viaClientName: by.viaClientName,
    isNpcParody: npc,
    textLen: textLen,
    quotePostId: quotePostId,
    replyToPostId: replyToPostId,
    hasTradeEmbed: hasTradeEmbed,
    hasCashtag: hasCashtag,
    deleted: false,
    deletedBy: "",
    likedBy: List(),
    repostedBy: List(),
    likeCount: 0,
    repostCount: 0,
  }
  { ...s,
    lastPostId: newId,
    accounts: s.accounts.listMap(a => if (a.id == by.accountId) { ...a, postsInWindow: a.postsInWindow + 1 } else a),
    posts: s.posts.append(post),
  }
```

### Only the author can delete an active post

Soft deletion preserves reply/quote target records while marking `deleted = true` and recording `deletedBy`.

```quint
pure def canDeletePost(s: PostsState, postId: int, by: Caller): bool =
  isValidCaller(s, by) and hasActivePost(s, postId) and postAuthorOf(s, postId) == by.accountId

pure def deletePost(s: PostsState, postId: int, by: Caller): PostsState =
  { ...s,
    posts: s.posts.listMap(p => if (p.id == postId) { ...p, deleted: true, deletedBy: by.accountId } else p),
  }
```

### Post identifiers, text bounds, reply/quote targets, author ownership, and shared rate limits hold inductively

Every post ID is positive, unique, and bounded by `lastPostId`; every `textLen` lies in `1..280`; every reply or quote target exists and is strictly older than the post itself (never self); only the author ever marks a post deleted; and every account stays within `0..maxPostsPerWindow`.

```quint
pure def alwaysAccountIdsUnique(s: PostsState): bool =
  s.accounts.every(a => a.id != "" and s.accounts.select(b => b.id == a.id).length() == 1)

pure def alwaysPostIdsPositiveAndUnique(s: PostsState): bool =
  s.lastPostId >= 0
    and s.posts.every(p => 1 <= p.id and p.id <= s.lastPostId)
    and s.posts.every(a => s.posts.select(b => b.id == a.id).length() == 1)

pure def alwaysPostTextLengthBounded(s: PostsState): bool =
  s.posts.every(p => 1 <= p.textLen and p.textLen <= maxPostChars)

pure def alwaysReplyTargetExistsAndNotSelf(s: PostsState): bool =
  s.posts.every(p => p.replyToPostId == 0 or (p.replyToPostId != p.id and p.replyToPostId < p.id and s.posts.some(t => t.id == p.replyToPostId)))

pure def alwaysQuoteTargetExistsAndNotSelf(s: PostsState): bool =
  s.posts.every(p => p.quotePostId == 0 or (p.quotePostId != p.id and p.quotePostId < p.id and s.posts.some(t => t.id == p.quotePostId)))

pure def alwaysAuthorAttributionValid(s: PostsState): bool =
  s.posts.every(p => and {
    hasAccount(s, p.authorId),
    p.isNpcParody == isNpcAccount(s, p.authorId),
    p.isNpcParody implies p.viaClientName == "",
    (not(p.deleted)) implies (p.deletedBy == ""),
    p.deleted implies (p.deletedBy == p.authorId),
  })

pure def alwaysSharedRateLimitBounded(s: PostsState): bool =
  s.accounts.every(a => 0 <= a.postsInWindow and a.postsInWindow <= maxPostsPerWindow)

pure def stepOnlyAuthorDeletesPost(before: PostsState, via: str, after: PostsState): bool =
  (via == "deletePost") implies after.posts.every(p =>
    before.posts.some(b => b.id == p.id and b.authorId == p.authorId and (b.deleted == p.deleted or p.deletedBy == b.authorId)))

pure def stepSharedRateLimitConsumedAcrossClients(before: PostsState, via: str, after: PostsState): bool =
  (via == "createPost") implies after.accounts.every(a =>
    before.accounts.some(b => b.id == a.id and (a.postsInWindow == b.postsInWindow or (a.postsInWindow == b.postsInWindow + 1 and a.postsInWindow <= maxPostsPerWindow))))
```

### Top-level posts, replies, quotes, connected-client attribution, NPC parody posts, deletions, and rate limits are reachable

```quint
pure def sometimesHasPost(s: PostsState): bool =
  s.posts.some(p => not(p.deleted) and p.replyToPostId == 0 and p.quotePostId == 0)

pure val eval_witness_sometimesHasPost =
  ("createPost", 140, 0, 0, false, false, { accountId: "alice", viaClientName: "" })

pure def sometimesHasReply(s: PostsState): bool =
  s.posts.some(p => not(p.deleted) and p.replyToPostId != 0)

pure val eval_witness_sometimesHasReply = (
  ("createPost", 140, 0, 0, false, false, { accountId: "alice", viaClientName: "" }),
  ("createPost", 80, 0, 1, false, false, { accountId: "bob", viaClientName: "" })
)

pure def sometimesHasQuote(s: PostsState): bool =
  s.posts.some(p => not(p.deleted) and p.quotePostId != 0)

pure val eval_witness_sometimesHasQuote = (
  ("createPost", 140, 0, 0, false, true, { accountId: "npc1", viaClientName: "" }),
  ("createPost", 80, 1, 0, false, false, { accountId: "alice", viaClientName: "Claude" })
)

pure def sometimesViaClientAttribution(s: PostsState): bool =
  s.posts.some(p => not(p.deleted) and p.viaClientName != "")

pure val eval_witness_sometimesViaClientAttribution =
  ("createPost", 120, 0, 0, true, true, { accountId: "alice", viaClientName: "Claude" })

pure def sometimesNpcParodyPost(s: PostsState): bool =
  s.posts.some(p => not(p.deleted) and p.isNpcParody)

pure val eval_witness_sometimesNpcParodyPost =
  ("createPost", 140, 0, 0, false, true, { accountId: "npc1", viaClientName: "" })

pure def sometimesPostDeleted(s: PostsState): bool =
  s.posts.some(p => p.deleted)

pure val eval_witness_sometimesPostDeleted = (
  ("createPost", 100, 0, 0, false, false, { accountId: "alice", viaClientName: "" }),
  ("deletePost", 1, { accountId: "alice", viaClientName: "" })
)

pure def sometimesPostRateLimitReached(s: PostsState): bool =
  s.accounts.some(a => a.postsInWindow == maxPostsPerWindow)

pure val eval_witness_sometimesPostRateLimitReached = (
  ("createPost", 50, 0, 0, false, false, { accountId: "alice", viaClientName: "" }),
  ("createPost", 60, 0, 0, false, false, { accountId: "alice", viaClientName: "Claude" }),
  ("createPost", 70, 0, 0, false, false, { accountId: "alice", viaClientName: "" })
)
```

## Story: Like, repost, follow, and block enforcement

> As a user, I want to like, unlike, repost, unrepost, and follow accounts without duplicates, while blocking prevents new likes, reposts, and follows between the two accounts.

### Users can add one like to an active post when neither account has blocked the other

The user can remove their own existing like from an active post even after either account has blocked the other.

```quint
pure def canLikePost(s: PostsState, postId: int, by: Caller): bool =
  and {
    isValidCaller(s, by),
    hasActivePost(s, postId),
    not(isBlockedBetween(s, by.accountId, postAuthorOf(s, postId))),
    not(hasLiked(s, postId, by.accountId)),
  }

pure def likePost(s: PostsState, postId: int, by: Caller): PostsState =
  { ...s,
    posts: s.posts.listMap(p => if (p.id == postId) { ...p, likedBy: appendUniqueStr(p.likedBy, by.accountId), likeCount: p.likeCount + 1 } else p),
  }

pure def canUnlikePost(s: PostsState, postId: int, by: Caller): bool =
  isValidCaller(s, by) and hasActivePost(s, postId) and hasLiked(s, postId, by.accountId)

pure def unlikePost(s: PostsState, postId: int, by: Caller): PostsState =
  { ...s,
    posts: s.posts.listMap(p => if (p.id == postId) { ...p, likedBy: removeStr(p.likedBy, by.accountId), likeCount: p.likeCount - 1 } else p),
  }
```

### Users can add one repost to an active post when neither account has blocked the other

The user can remove their own existing repost from an active post even after either account has blocked the other.

```quint
pure def canRepostPost(s: PostsState, postId: int, by: Caller): bool =
  and {
    isValidCaller(s, by),
    hasActivePost(s, postId),
    not(isBlockedBetween(s, by.accountId, postAuthorOf(s, postId))),
    not(hasReposted(s, postId, by.accountId)),
  }

pure def repostPost(s: PostsState, postId: int, by: Caller): PostsState =
  { ...s,
    posts: s.posts.listMap(p => if (p.id == postId) { ...p, repostedBy: appendUniqueStr(p.repostedBy, by.accountId), repostCount: p.repostCount + 1 } else p),
  }

pure def canUnrepostPost(s: PostsState, postId: int, by: Caller): bool =
  isValidCaller(s, by) and hasActivePost(s, postId) and hasReposted(s, postId, by.accountId)

pure def unrepostPost(s: PostsState, postId: int, by: Caller): PostsState =
  { ...s,
    unrepostEvents: s.unrepostEvents + 1,
    posts: s.posts.listMap(p => if (p.id == postId) { ...p, repostedBy: removeStr(p.repostedBy, by.accountId), repostCount: p.repostCount - 1 } else p),
  }
```

### Following and blocking enforce self-exclusion and remove follow edges on block

```quint
pure def canFollowUser(s: PostsState, targetId: str, by: Caller): bool =
  and {
    isValidCaller(s, by),
    hasAccount(s, targetId),
    targetId != by.accountId,
    not(isBlockedBetween(s, by.accountId, targetId)),
    not(isFollowing(s, by.accountId, targetId)),
  }

pure def followUser(s: PostsState, targetId: str, by: Caller): PostsState =
  { ...s, follows: s.follows.append({ followerId: by.accountId, followingId: targetId }) }

pure def canUnfollowUser(s: PostsState, targetId: str, by: Caller): bool =
  isValidCaller(s, by) and isFollowing(s, by.accountId, targetId)

pure def unfollowUser(s: PostsState, targetId: str, by: Caller): PostsState =
  { ...s,
    follows: s.follows.select(f => not(f.followerId == by.accountId and f.followingId == targetId)),
  }

pure def canApplyBlock(s: PostsState, targetId: str, by: Caller): bool =
  and {
    isValidCaller(s, by),
    hasAccount(s, targetId),
    targetId != by.accountId,
    not(hasDirectBlock(s, by.accountId, targetId)),
  }

pure def applyBlock(s: PostsState, targetId: str, by: Caller): PostsState =
  { ...s,
    blocks: s.blocks.append({ blockerId: by.accountId, blockedId: targetId }),
    follows: s.follows.select(f =>
      not((f.followerId == by.accountId and f.followingId == targetId)
        or (f.followerId == targetId and f.followingId == by.accountId))),
  }

pure def canApplyUnblock(s: PostsState, targetId: str, by: Caller): bool =
  isValidCaller(s, by) and hasDirectBlock(s, by.accountId, targetId)

pure def applyUnblock(s: PostsState, targetId: str, by: Caller): PostsState =
  { ...s,
    blocks: s.blocks.select(b => not(b.blockerId == by.accountId and b.blockedId == targetId)),
  }
```

### Likes, reposts, counts, follows, and blocks remain unique and consistent

```quint
pure def alwaysLikesUniqueAndCountMatches(s: PostsState): bool =
  s.posts.every(p =>
    p.likeCount == p.likedBy.length()
      and p.likedBy.every(u => p.likedBy.select(v => v == u).length() == 1))

pure def alwaysRepostsUniqueAndCountMatches(s: PostsState): bool =
  s.unrepostEvents >= 0
    and s.posts.every(p =>
      p.repostCount == p.repostedBy.length()
        and p.repostedBy.every(u => p.repostedBy.select(v => v == u).length() == 1))

pure def alwaysFollowsAndBlocksConsistent(s: PostsState): bool =
  and {
    s.follows.every(f =>
      f.followerId != f.followingId
        and hasAccount(s, f.followerId)
        and hasAccount(s, f.followingId)
        and not(isBlockedBetween(s, f.followerId, f.followingId))
        and s.follows.select(g => g.followerId == f.followerId and g.followingId == f.followingId).length() == 1),
    s.blocks.every(b =>
      b.blockerId != b.blockedId
        and hasAccount(s, b.blockerId)
        and hasAccount(s, b.blockedId)
        and s.blocks.select(c => c.blockerId == b.blockerId and c.blockedId == b.blockedId).length() == 1),
  }
```

### Repost followed by unrepost and following are reachable

```quint
pure def sometimesRepostAndUnrepost(s: PostsState): bool =
  s.unrepostEvents > 0 and s.posts.some(p => not(p.deleted) and p.repostCount == 0)

pure val eval_witness_sometimesRepostAndUnrepost = (
  ("createPost", 100, 0, 0, false, false, { accountId: "alice", viaClientName: "" }),
  ("repostPost", 1, { accountId: "bob", viaClientName: "" }),
  ("unrepostPost", 1, { accountId: "bob", viaClientName: "" })
)

pure def sometimesFollowing(s: PostsState): bool =
  s.follows.length() > 0

pure val eval_witness_sometimesFollowing =
  ("followUser", "npc1", { accountId: "alice", viaClientName: "Claude" })

pure def sometimesBlocked(s: PostsState): bool =
  s.blocks.length() > 0

pure val eval_witness_sometimesBlocked =
  ("applyBlock", "bob", { accountId: "alice", viaClientName: "" })
```

## Story: Project posts for Game and Social presentation modes

> As a Social-mode user, I want trade embeds and `$CASHTAG` market links hidden from posts while keeping satirical NPC posts visible.

### Social mode suppresses trade embeds and cashtag links without hiding NPC posts

`projectForMode(post, mode)` strips `showTradeEmbed` and `linkCashtags` when `mode == SocialMode`, rendering cashtags as plain text while keeping non-deleted human and NPC posts visible (PRD §11).

```quint
pure def projectForMode(post: Post, mode: PresentationMode): ProjectedPost =
  val inGame = mode == GameMode
  {
    id: post.id,
    authorId: post.authorId,
    viaClientName: post.viaClientName,
    isNpcParody: post.isNpcParody,
    textLen: post.textLen,
    quotePostId: post.quotePostId,
    replyToPostId: post.replyToPostId,
    showTradeEmbed: inGame and post.hasTradeEmbed,
    linkCashtags: inGame and post.hasCashtag,
    visibleInMode: not(post.deleted),
  }

pure def lawSocialModeHidesTradeEmbedsAndCashtags(post: Post): bool =
  val projected = projectForMode(post, SocialMode)
  not(projected.showTradeEmbed) and not(projected.linkCashtags)

pure def lawSocialModeKeepsActiveNpcPosts(post: Post): bool =
  (not(post.deleted) and post.isNpcParody) implies projectForMode(post, SocialMode).visibleInMode

pure def lawGameModePreservesTradeEmbedsAndCashtags(post: Post): bool =
  val projected = projectForMode(post, GameMode)
  (projected.showTradeEmbed == post.hasTradeEmbed) and (projected.linkCashtags == post.hasCashtag)
```
