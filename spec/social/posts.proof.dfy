lemma PostIdsBridge(s: PostsState)
  ensures alwaysPostIdsPositiveAndUnique(s) == (((s.lastPostId >= 0) && !((exists p :: p in s.posts && !(((1 <= p.id) && (p.id <= s.lastPostId)))))) && !((exists a :: a in s.posts && !((|ProofLib.Filter((b: Post) => (b.id == a.id), s.posts)| == 1)))))
{
}

lemma AccountIdsBridge(s: PostsState)
  ensures alwaysAccountIdsUnique(s) == !((exists a :: a in s.accounts && !(((a.id != "") && (|ProofLib.Filter((b: AccountInfo) => (b.id == a.id), s.accounts)| == 1)))))
{
}

lemma LikesBridge(s: PostsState)
  ensures alwaysLikesUniqueAndCountMatches(s) == !((exists p :: p in s.posts && !(((p.likeCount == |p.likedBy|) && !((exists u :: u in p.likedBy && !((|ProofLib.Filter((v: string) => (v == u), p.likedBy)| == 1))))))))
{
}

lemma RepostsBridge(s: PostsState)
  ensures alwaysRepostsUniqueAndCountMatches(s) == ((s.unrepostEvents >= 0) && !((exists p :: p in s.posts && !(((p.repostCount == |p.repostedBy|) && !((exists u :: u in p.repostedBy && !((|ProofLib.Filter((v: string) => (v == u), p.repostedBy)| == 1)))))))))
{
}

lemma FollowsBlocksBridge(s: PostsState)
  ensures alwaysFollowsAndBlocksConsistent(s) == (!((exists f :: f in s.follows && !((((((f.followerId != f.followingId) && hasAccount(s, f.followerId)) && hasAccount(s, f.followingId)) && !(isBlockedBetween(s, f.followerId, f.followingId))) && (|ProofLib.Filter((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), s.follows)| == 1))))) && !((exists b :: b in s.blocks && !(((((b.blockerId != b.blockedId) && hasAccount(s, b.blockerId)) && hasAccount(s, b.blockedId)) && (|ProofLib.Filter((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks)| == 1))))))
{
}

lemma RemoveStrBridge(xs: seq<string>, accountId: string)
  ensures removeStr(xs, accountId) == ProofLib.Filter((u: string) => (u != accountId), xs)
{
}

lemma UnfollowBridge(s: PostsState, targetId: string, by_: Caller)
  ensures unfollowUser(s, targetId, by_).follows == ProofLib.Filter((f: FollowEdge) => !(((f.followerId == by_.accountId) && (f.followingId == targetId))), s.follows)
{
}

lemma ApplyBlockFollowsBridge(s: PostsState, targetId: string, by_: Caller)
  ensures applyBlock(s, targetId, by_).follows == ProofLib.Filter((f: FollowEdge) => !((((f.followerId == by_.accountId) && (f.followingId == targetId)) || ((f.followerId == targetId) && (f.followingId == by_.accountId)))), s.follows)
{
}

lemma ApplyUnblockBlocksBridge(s: PostsState, targetId: string, by_: Caller)
  ensures applyUnblock(s, targetId, by_).blocks == ProofLib.Filter((b: BlockEdge) => !(((b.blockerId == by_.accountId) && (b.blockedId == targetId))), s.blocks)
{
}

lemma AccountIdsDistinct(s: PostsState)
  requires alwaysAccountIdsUnique(s)
  ensures ProofLib.DistinctBy(s.accounts, (a: AccountInfo) => a.id)
{
  AccountIdsBridge(s);
  var key := (a: AccountInfo) => a.id;
  forall i, j | 0 <= i < |s.accounts| && 0 <= j < |s.accounts| && i != j
    ensures key(s.accounts[i]) != key(s.accounts[j])
  {
    var a := s.accounts[i];
    assert a in s.accounts;
    ProofLib.FilterCountOneIffUnique((b: AccountInfo) => (b.id == a.id), s.accounts, key, i);
  }
}

lemma PostIdsDistinct(s: PostsState)
  requires alwaysPostIdsPositiveAndUnique(s)
  ensures ProofLib.DistinctBy(s.posts, (p: Post) => p.id)
{
  PostIdsBridge(s);
  var key := (p: Post) => p.id;
  forall i, j | 0 <= i < |s.posts| && 0 <= j < |s.posts| && i != j
    ensures key(s.posts[i]) != key(s.posts[j])
  {
    var a := s.posts[i];
    assert a in s.posts;
    ProofLib.FilterCountOneIffUnique((b: Post) => (b.id == a.id), s.posts, key, i);
  }
}

lemma PostAuthorFoldNone(xs: seq<Post>, postId: int, init: string)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id != postId
  ensures Std.Collections.Seq.FoldLeft((acc: string, p: Post) => (if (p.id == postId) then p.authorId else acc), init, xs) == init
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    PostAuthorFoldNone(xs[1..], postId, init);
  }
}

lemma PostAuthorFoldMatch(xs: seq<Post>, postId: int, init: string, target: Post)
  requires ProofLib.DistinctBy(xs, (q: Post) => q.id)
  requires target in xs && target.id == postId
  ensures Std.Collections.Seq.FoldLeft((acc: string, p: Post) => (if (p.id == postId) then p.authorId else acc), init, xs) == target.authorId
  decreases |xs|
{
  if xs[0].id == postId {
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k == 0;
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][i].id != postId;
    PostAuthorFoldNone(xs[1..], postId, target.authorId);
  } else {
    assert ProofLib.DistinctBy(xs[1..], (q: Post) => q.id) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j
        ensures xs[1..][i].id != xs[1..][j].id
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    var k :| 0 <= k < |xs| && xs[k] == target;
    assert k > 0 && xs[1..][k - 1] == target;
    PostAuthorFoldMatch(xs[1..], postId, init, target);
  }
}

lemma FilterAllKept<T>(p: T -> bool, xs: seq<T>)
  requires forall i :: 0 <= i < |xs| ==> p(xs[i])
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1];
    FilterAllKept(p, xs[1..]);
  }
}

lemma StrCountOneToDistinct(xs: seq<string>)
  requires forall u :: u in xs ==> |ProofLib.Filter((v: string) => (v == u), xs)| == 1
  ensures ProofLib.Distinct(xs)
  ensures ProofLib.DistinctBy(xs, (u: string) => u)
{
  var key := (u: string) => u;
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var u := xs[i];
    assert u in xs;
    ProofLib.FilterCountOneIffUnique((v: string) => (v == u), xs, key, i);
  }
  assert ProofLib.Distinct(xs) by {
    forall i, j | 0 <= i < j < |xs|
      ensures xs[i] != xs[j]
    {
      assert key(xs[i]) != key(xs[j]);
    }
  }
}

lemma StrRemoveOneLength(xs: seq<string>, x: string)
  requires ProofLib.Distinct(xs)
  requires x in xs
  ensures |ProofLib.Filter((u: string) => (u != x), xs)| == |xs| - 1
  decreases |xs|
{
  ProofLib.FilterCons((u: string) => (u != x), xs);
  if xs[0] == x {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && xs[1..][i] != x;
    FilterAllKept((u: string) => (u != x), xs[1..]);
  } else {
    assert ProofLib.Distinct(xs[1..]) by {
      forall i, j | 0 <= i < j < |xs[1..]|
        ensures xs[1..][i] != xs[1..][j]
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    var k :| 0 <= k < |xs| && xs[k] == x;
    assert k > 0 && xs[1..][k - 1] == x;
    StrRemoveOneLength(xs[1..], x);
  }
}

lemma StrRemovePreservesUnique(xs: seq<string>, x: string)
  requires forall u :: u in xs ==> |ProofLib.Filter((v: string) => (v == u), xs)| == 1
  requires x in xs
  ensures |removeStr(xs, x)| == |xs| - 1
  ensures forall u :: u in removeStr(xs, x) ==> |ProofLib.Filter((v: string) => (v == u), removeStr(xs, x))| == 1
{
  RemoveStrBridge(xs, x);
  StrCountOneToDistinct(xs);
  StrRemoveOneLength(xs, x);
  var ys := removeStr(xs, x);
  ProofLib.FilterKeepsDistinctBy((u: string) => (u != x), xs, (u: string) => u);
  assert ProofLib.Distinct(ys);
  forall u | u in ys
    ensures |ProofLib.Filter((v: string) => (v == u), ys)| == 1
  {
    ProofLib.FilterDistinctCountOne((v: string) => (v == u), ys, u);
  }
}

lemma SameAccountIdsAndKind(s: PostsState, after: PostsState)
  requires alwaysAccountIdsUnique(s)
  requires |after.accounts| == |s.accounts|
  requires forall i :: 0 <= i < |s.accounts| ==> after.accounts[i].id == s.accounts[i].id && after.accounts[i].kind == s.accounts[i].kind
  ensures forall id :: hasAccount(after, id) == hasAccount(s, id)
  ensures forall id :: isNpcAccount(after, id) == isNpcAccount(s, id)
  ensures alwaysAccountIdsUnique(after)
{
  AccountIdsBridge(s);
  AccountIdsBridge(after);
  forall id
    ensures hasAccount(after, id) == hasAccount(s, id)
    ensures isNpcAccount(after, id) == isNpcAccount(s, id)
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
    if isNpcAccount(after, id) {
      var a :| a in after.accounts && a.id == id && a.kind.NpcAuthor?;
      var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
      assert s.accounts[i] in s.accounts && s.accounts[i].id == id && s.accounts[i].kind.NpcAuthor?;
    }
    if isNpcAccount(s, id) {
      var a :| a in s.accounts && a.id == id && a.kind.NpcAuthor?;
      var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
      assert after.accounts[i] in after.accounts && after.accounts[i].id == id && after.accounts[i].kind.NpcAuthor?;
    }
  }
  forall a | a in after.accounts
    ensures a.id != "" && |ProofLib.Filter((b: AccountInfo) => (b.id == a.id), after.accounts)| == 1
  {
    var i :| 0 <= i < |after.accounts| && after.accounts[i] == a;
    var a0 := s.accounts[i];
    assert a0 in s.accounts;
    ProofLib.FilterLengthPointwise((b: AccountInfo) => (b.id == a.id), (b: AccountInfo) => (b.id == a0.id), after.accounts, s.accounts);
  }
}

lemma SamePostIdsUnique(s: PostsState, after: PostsState)
  requires alwaysPostIdsPositiveAndUnique(s)
  requires after.lastPostId == s.lastPostId
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==> after.posts[i].id == s.posts[i].id
  ensures alwaysPostIdsPositiveAndUnique(after)
{
  PostIdsBridge(s);
  PostIdsBridge(after);
  forall a | a in after.posts
    ensures 1 <= a.id && a.id <= after.lastPostId
    ensures |ProofLib.Filter((b: Post) => (b.id == a.id), after.posts)| == 1
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == a;
    var a0 := s.posts[i];
    assert a0 in s.posts;
    ProofLib.FilterLengthPointwise((b: Post) => (b.id == a.id), (b: Post) => (b.id == a0.id), after.posts, s.posts);
  }
}

lemma SamePostReplyGraph(s: PostsState, after: PostsState)
  requires alwaysReplyTargetExistsAndNotSelf(s)
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==>
    after.posts[i].id == s.posts[i].id && after.posts[i].replyToPostId == s.posts[i].replyToPostId
  ensures alwaysReplyTargetExistsAndNotSelf(after)
{
  forall p | p in after.posts
    ensures p.replyToPostId == 0 || (p.replyToPostId != p.id && p.replyToPostId < p.id && (exists t :: t in after.posts && t.id == p.replyToPostId))
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p.replyToPostId != 0 {
      var t0 :| t0 in s.posts && t0.id == p0.replyToPostId;
      var j :| 0 <= j < |s.posts| && s.posts[j] == t0;
      assert after.posts[j] in after.posts && after.posts[j].id == p.replyToPostId;
    }
  }
}

lemma SamePostQuoteGraph(s: PostsState, after: PostsState)
  requires alwaysQuoteTargetExistsAndNotSelf(s)
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==>
    after.posts[i].id == s.posts[i].id && after.posts[i].quotePostId == s.posts[i].quotePostId
  ensures alwaysQuoteTargetExistsAndNotSelf(after)
{
  forall p | p in after.posts
    ensures p.quotePostId == 0 || (p.quotePostId != p.id && p.quotePostId < p.id && (exists t :: t in after.posts && t.id == p.quotePostId))
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p.quotePostId != 0 {
      var t0 :| t0 in s.posts && t0.id == p0.quotePostId;
      var j :| 0 <= j < |s.posts| && s.posts[j] == t0;
      assert after.posts[j] in after.posts && after.posts[j].id == p.quotePostId;
    }
  }
}

lemma SamePostTextLen(s: PostsState, after: PostsState)
  requires alwaysPostTextLengthBounded(s)
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==> after.posts[i].textLen == s.posts[i].textLen
  ensures alwaysPostTextLengthBounded(after)
{
  forall p | p in after.posts
    ensures 1 <= p.textLen && p.textLen <= maxPostChars
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    assert s.posts[i] in s.posts;
  }
}

lemma SamePostAttribution(s: PostsState, after: PostsState)
  requires alwaysAuthorAttributionValid(s)
  requires after.accounts == s.accounts
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==>
    after.posts[i].authorId == s.posts[i].authorId &&
    after.posts[i].isNpcParody == s.posts[i].isNpcParody &&
    after.posts[i].viaClientName == s.posts[i].viaClientName &&
    after.posts[i].deleted == s.posts[i].deleted &&
    after.posts[i].deletedBy == s.posts[i].deletedBy
  ensures alwaysAuthorAttributionValid(after)
{
  forall p | p in after.posts
    ensures hasAccount(after, p.authorId) && (p.isNpcParody == isNpcAccount(after, p.authorId)) && (!(p.isNpcParody) || (p.viaClientName == "")) && (!(!(p.deleted)) || (p.deletedBy == "")) && (!(p.deleted) || (p.deletedBy == p.authorId))
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    assert s.posts[i] in s.posts;
  }
}

lemma SamePostLikes(s: PostsState, after: PostsState)
  requires alwaysLikesUniqueAndCountMatches(s)
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==>
    after.posts[i].likeCount == s.posts[i].likeCount && after.posts[i].likedBy == s.posts[i].likedBy
  ensures alwaysLikesUniqueAndCountMatches(after)
{
  LikesBridge(s);
  LikesBridge(after);
  forall p | p in after.posts
    ensures p.likeCount == |p.likedBy| && (forall u :: u in p.likedBy ==> |ProofLib.Filter((v: string) => (v == u), p.likedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    assert s.posts[i] in s.posts;
  }
}

lemma SamePostReposts(s: PostsState, after: PostsState)
  requires alwaysRepostsUniqueAndCountMatches(s)
  requires after.unrepostEvents >= s.unrepostEvents
  requires |after.posts| == |s.posts|
  requires forall i :: 0 <= i < |s.posts| ==>
    after.posts[i].repostCount == s.posts[i].repostCount && after.posts[i].repostedBy == s.posts[i].repostedBy
  ensures alwaysRepostsUniqueAndCountMatches(after)
{
  RepostsBridge(s);
  RepostsBridge(after);
  forall p | p in after.posts
    ensures p.repostCount == |p.repostedBy| && (forall u :: u in p.repostedBy ==> |ProofLib.Filter((v: string) => (v == u), p.repostedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    assert s.posts[i] in s.posts;
  }
}

lemma FollowCountUnique(xs: seq<FollowEdge>)
  requires forall f :: f in xs ==> |ProofLib.Filter((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), xs)| == 1
  ensures ProofLib.DistinctBy(xs, (f: FollowEdge) => (f.followerId, f.followingId))
{
  var key := (f: FollowEdge) => (f.followerId, f.followingId);
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var f := xs[i];
    assert f in xs;
    ProofLib.FilterCountOneIffUnique((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), xs, key, i);
  }
}

lemma FollowUniqueToCount(xs: seq<FollowEdge>)
  requires ProofLib.DistinctBy(xs, (f: FollowEdge) => (f.followerId, f.followingId))
  ensures forall f :: f in xs ==> |ProofLib.Filter((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), xs)| == 1
{
  var key := (f: FollowEdge) => (f.followerId, f.followingId);
  forall f | f in xs
    ensures |ProofLib.Filter((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == f;
    ProofLib.FilterCountOneIffUnique((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), xs, key, i);
  }
}

lemma BlockCountUnique(xs: seq<BlockEdge>)
  requires forall b :: b in xs ==> |ProofLib.Filter((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
  ensures ProofLib.DistinctBy(xs, (b: BlockEdge) => (b.blockerId, b.blockedId))
{
  var key := (b: BlockEdge) => (b.blockerId, b.blockedId);
  forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
    ensures key(xs[i]) != key(xs[j])
  {
    var b := xs[i];
    assert b in xs;
    ProofLib.FilterCountOneIffUnique((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs, key, i);
  }
}

lemma BlockUniqueToCount(xs: seq<BlockEdge>)
  requires ProofLib.DistinctBy(xs, (b: BlockEdge) => (b.blockerId, b.blockedId))
  ensures forall b :: b in xs ==> |ProofLib.Filter((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
{
  var key := (b: BlockEdge) => (b.blockerId, b.blockedId);
  forall b | b in xs
    ensures |ProofLib.Filter((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs)| == 1
  {
    var i :| 0 <= i < |xs| && xs[i] == b;
    ProofLib.FilterCountOneIffUnique((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), xs, key, i);
  }
}

lemma CreatePostIdsAndTargets(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, hasTradeEmbed: bool, hasCashtag: bool, by_: Caller)
  requires alwaysPostIdsPositiveAndUnique(s)
  requires alwaysPostTextLengthBounded(s)
  requires alwaysReplyTargetExistsAndNotSelf(s)
  requires alwaysQuoteTargetExistsAndNotSelf(s)
  requires canCreatePost(s, textLen, quotePostId, replyToPostId, by_)
  ensures alwaysPostIdsPositiveAndUnique(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysPostTextLengthBounded(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysReplyTargetExistsAndNotSelf(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysQuoteTargetExistsAndNotSelf(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
{
  var after := createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
  PostIdsBridge(s);
  PostIdsBridge(after);
  var np := Post(s.lastPostId + 1, by_.accountId, by_.viaClientName, isNpcAccount(s, by_.accountId), textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, false, "", [], [], 0, 0);
  forall a | a in after.posts
    ensures |ProofLib.Filter((b: Post) => (b.id == a.id), after.posts)| == 1
  {
    ProofLib.FilterAppend((b: Post) => (b.id == a.id), s.posts, np);
    if a == np {
      ProofLib.FilterNone((b: Post) => (b.id == a.id), s.posts);
    }
  }
}

lemma CreatePostAccountsAndAttribution(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, hasTradeEmbed: bool, hasCashtag: bool, by_: Caller)
  requires alwaysAccountIdsUnique(s)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAuthorAttributionValid(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  requires canCreatePost(s, textLen, quotePostId, replyToPostId, by_)
  ensures alwaysAccountIdsUnique(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysSharedRateLimitBounded(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysAuthorAttributionValid(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysFollowsAndBlocksConsistent(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "createPost", createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
{
  var after := createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
  AccountIdsDistinct(s);
  SameAccountIdsAndKind(s, after);
  FollowsBlocksBridge(s);
  FollowsBlocksBridge(after);
  var aRate :| aRate in s.accounts && aRate.id == by_.accountId && aRate.postsInWindow < maxPostsPerWindow;
  var iRate :| 0 <= iRate < |s.accounts| && s.accounts[iRate] == aRate;
  var aCaller :| aCaller in s.accounts && aCaller.id == by_.accountId && (by_.viaClientName == "" || (aCaller.kind.HumanAuthor? && aCaller.connectedClient == by_.viaClientName));
  var iCaller :| 0 <= iCaller < |s.accounts| && s.accounts[iCaller] == aCaller;
  assert iRate == iCaller;
  forall i | 0 <= i < |s.accounts| && s.accounts[i].id == by_.accountId
    ensures i == iRate && s.accounts[i].postsInWindow < maxPostsPerWindow
  {
  }
  if isNpcAccount(s, by_.accountId) {
    var aNpc :| aNpc in s.accounts && aNpc.id == by_.accountId && aNpc.kind.NpcAuthor?;
    var iNpc :| 0 <= iNpc < |s.accounts| && s.accounts[iNpc] == aNpc;
    assert iNpc == iCaller;
    assert by_.viaClientName == "";
  }
}

lemma CreatePostEngagement(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, hasTradeEmbed: bool, hasCashtag: bool, by_: Caller)
  requires alwaysLikesUniqueAndCountMatches(s)
  requires alwaysRepostsUniqueAndCountMatches(s)
  ensures alwaysLikesUniqueAndCountMatches(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
  ensures alwaysRepostsUniqueAndCountMatches(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_))
{
  var after := createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
  LikesBridge(s);
  LikesBridge(after);
  RepostsBridge(s);
  RepostsBridge(after);
}

lemma createPost_ensures(s: PostsState, textLen: int, quotePostId: int, replyToPostId: int, hasTradeEmbed: bool, hasCashtag: bool, by_: Caller)
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysPostIdsPositiveAndUnique(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysPostTextLengthBounded(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysReplyTargetExistsAndNotSelf(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysSharedRateLimitBounded(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysAccountIdsUnique(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysAuthorAttributionValid(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysLikesUniqueAndCountMatches(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysRepostsUniqueAndCountMatches(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> alwaysFollowsAndBlocksConsistent(createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> stepOnlyAuthorDeletesPost(s, "createPost", createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
  ensures (inv(s) ==> canCreatePost(s, textLen, quotePostId, replyToPostId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "createPost", createPost(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_)))
{
  hide *;
  reveal inv, stepOnlyAuthorDeletesPost;
  if inv(s) && canCreatePost(s, textLen, quotePostId, replyToPostId, by_) {
    CreatePostIdsAndTargets(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
    CreatePostAccountsAndAttribution(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
    CreatePostEngagement(s, textLen, quotePostId, replyToPostId, hasTradeEmbed, hasCashtag, by_);
  }
}

lemma DeletePostAuth(s: PostsState, postId: int, by_: Caller)
  requires alwaysPostIdsPositiveAndUnique(s)
  requires alwaysAuthorAttributionValid(s)
  requires canDeletePost(s, postId, by_)
  ensures alwaysAuthorAttributionValid(deletePost(s, postId, by_))
  ensures stepOnlyAuthorDeletesPost(s, "deletePost", deletePost(s, postId, by_))
{
  var after := deletePost(s, postId, by_);
  PostIdsDistinct(s);
  forall p | p in s.posts && p.id == postId
    ensures p.authorId == by_.accountId
  {
    PostAuthorFoldMatch(s.posts, postId, "", p);
  }
  forall p | p in after.posts
    ensures hasAccount(after, p.authorId) && (p.isNpcParody == isNpcAccount(after, p.authorId)) && (!(p.isNpcParody) || (p.viaClientName == "")) && (!(!(p.deleted)) || (p.deletedBy == "")) && (!(p.deleted) || (p.deletedBy == p.authorId))
    ensures exists b :: b in s.posts && (((b.id == p.id) && (b.authorId == p.authorId)) && ((b.deleted == p.deleted) || (p.deletedBy == b.authorId)))
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    assert s.posts[i] in s.posts;
  }
}

lemma DeletePostUnchangedFields(s: PostsState, postId: int, by_: Caller)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAccountIdsUnique(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  ensures alwaysSharedRateLimitBounded(deletePost(s, postId, by_))
  ensures alwaysAccountIdsUnique(deletePost(s, postId, by_))
  ensures alwaysFollowsAndBlocksConsistent(deletePost(s, postId, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "deletePost", deletePost(s, postId, by_))
{
}

lemma deletePost_ensures(s: PostsState, postId: int, by_: Caller)
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysPostIdsPositiveAndUnique(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysPostTextLengthBounded(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysReplyTargetExistsAndNotSelf(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysSharedRateLimitBounded(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysAccountIdsUnique(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysAuthorAttributionValid(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysLikesUniqueAndCountMatches(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysRepostsUniqueAndCountMatches(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> alwaysFollowsAndBlocksConsistent(deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> stepOnlyAuthorDeletesPost(s, "deletePost", deletePost(s, postId, by_)))
  ensures (inv(s) ==> canDeletePost(s, postId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "deletePost", deletePost(s, postId, by_)))
{
  hide *;
  reveal inv, deletePost;
  if inv(s) && canDeletePost(s, postId, by_) {
    var after := deletePost(s, postId, by_);
    SamePostIdsUnique(s, after);
    SamePostTextLen(s, after);
    SamePostReplyGraph(s, after);
    SamePostQuoteGraph(s, after);
    SamePostLikes(s, after);
    SamePostReposts(s, after);
    DeletePostAuth(s, postId, by_);
    DeletePostUnchangedFields(s, postId, by_);
  }
}

lemma LikePostLikes(s: PostsState, postId: int, by_: Caller)
  requires alwaysLikesUniqueAndCountMatches(s)
  requires canLikePost(s, postId, by_)
  ensures alwaysLikesUniqueAndCountMatches(likePost(s, postId, by_))
{
  var after := likePost(s, postId, by_);
  LikesBridge(s);
  LikesBridge(after);
  forall p | p in after.posts
    ensures p.likeCount == |p.likedBy| && (forall u :: u in p.likedBy ==> |ProofLib.Filter((v: string) => (v == u), p.likedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p0.id == postId {
      assert !(by_.accountId in p0.likedBy);
      assert p.likedBy == p0.likedBy + [by_.accountId];
      forall u | u in p.likedBy
        ensures |ProofLib.Filter((v: string) => (v == u), p.likedBy)| == 1
      {
        ProofLib.FilterAppend((v: string) => (v == u), p0.likedBy, by_.accountId);
        if u == by_.accountId {
          ProofLib.FilterNone((v: string) => (v == u), p0.likedBy);
        }
      }
    }
  }
}

lemma LikePostUnchanged(s: PostsState, postId: int, by_: Caller)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAccountIdsUnique(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  ensures alwaysSharedRateLimitBounded(likePost(s, postId, by_))
  ensures alwaysAccountIdsUnique(likePost(s, postId, by_))
  ensures alwaysFollowsAndBlocksConsistent(likePost(s, postId, by_))
  ensures stepOnlyAuthorDeletesPost(s, "likePost", likePost(s, postId, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "likePost", likePost(s, postId, by_))
{
}

lemma likePost_ensures(s: PostsState, postId: int, by_: Caller)
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysPostIdsPositiveAndUnique(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysPostTextLengthBounded(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysReplyTargetExistsAndNotSelf(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysSharedRateLimitBounded(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysAccountIdsUnique(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysAuthorAttributionValid(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysLikesUniqueAndCountMatches(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysRepostsUniqueAndCountMatches(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> alwaysFollowsAndBlocksConsistent(likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> stepOnlyAuthorDeletesPost(s, "likePost", likePost(s, postId, by_)))
  ensures (inv(s) ==> canLikePost(s, postId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "likePost", likePost(s, postId, by_)))
{
  hide *;
  reveal inv, likePost;
  if inv(s) && canLikePost(s, postId, by_) {
    var after := likePost(s, postId, by_);
    SamePostIdsUnique(s, after);
    SamePostTextLen(s, after);
    SamePostReplyGraph(s, after);
    SamePostQuoteGraph(s, after);
    SamePostAttribution(s, after);
    LikePostLikes(s, postId, by_);
    SamePostReposts(s, after);
    LikePostUnchanged(s, postId, by_);
  }
}

lemma UnlikePostLikes(s: PostsState, postId: int, by_: Caller)
  requires alwaysPostIdsPositiveAndUnique(s)
  requires alwaysLikesUniqueAndCountMatches(s)
  requires canUnlikePost(s, postId, by_)
  ensures alwaysLikesUniqueAndCountMatches(unlikePost(s, postId, by_))
{
  var after := unlikePost(s, postId, by_);
  PostIdsDistinct(s);
  LikesBridge(s);
  LikesBridge(after);
  var pLiked :| pLiked in s.posts && pLiked.id == postId && by_.accountId in pLiked.likedBy;
  var iLiked :| 0 <= iLiked < |s.posts| && s.posts[iLiked] == pLiked;
  forall p | p in after.posts
    ensures p.likeCount == |p.likedBy| && (forall u :: u in p.likedBy ==> |ProofLib.Filter((v: string) => (v == u), p.likedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p0.id == postId {
      assert i == iLiked;
      StrRemovePreservesUnique(p0.likedBy, by_.accountId);
    }
  }
}

lemma UnlikePostUnchanged(s: PostsState, postId: int, by_: Caller)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAccountIdsUnique(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  ensures alwaysSharedRateLimitBounded(unlikePost(s, postId, by_))
  ensures alwaysAccountIdsUnique(unlikePost(s, postId, by_))
  ensures alwaysFollowsAndBlocksConsistent(unlikePost(s, postId, by_))
  ensures stepOnlyAuthorDeletesPost(s, "unlikePost", unlikePost(s, postId, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "unlikePost", unlikePost(s, postId, by_))
{
}

lemma unlikePost_ensures(s: PostsState, postId: int, by_: Caller)
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysPostIdsPositiveAndUnique(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysPostTextLengthBounded(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysReplyTargetExistsAndNotSelf(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysSharedRateLimitBounded(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysAccountIdsUnique(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysAuthorAttributionValid(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysLikesUniqueAndCountMatches(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysRepostsUniqueAndCountMatches(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> alwaysFollowsAndBlocksConsistent(unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> stepOnlyAuthorDeletesPost(s, "unlikePost", unlikePost(s, postId, by_)))
  ensures (inv(s) ==> canUnlikePost(s, postId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "unlikePost", unlikePost(s, postId, by_)))
{
  hide *;
  reveal inv, unlikePost;
  if inv(s) && canUnlikePost(s, postId, by_) {
    var after := unlikePost(s, postId, by_);
    SamePostIdsUnique(s, after);
    SamePostTextLen(s, after);
    SamePostReplyGraph(s, after);
    SamePostQuoteGraph(s, after);
    SamePostAttribution(s, after);
    UnlikePostLikes(s, postId, by_);
    SamePostReposts(s, after);
    UnlikePostUnchanged(s, postId, by_);
  }
}

lemma RepostPostReposts(s: PostsState, postId: int, by_: Caller)
  requires alwaysRepostsUniqueAndCountMatches(s)
  requires canRepostPost(s, postId, by_)
  ensures alwaysRepostsUniqueAndCountMatches(repostPost(s, postId, by_))
{
  var after := repostPost(s, postId, by_);
  RepostsBridge(s);
  RepostsBridge(after);
  forall p | p in after.posts
    ensures p.repostCount == |p.repostedBy| && (forall u :: u in p.repostedBy ==> |ProofLib.Filter((v: string) => (v == u), p.repostedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p0.id == postId {
      assert !(by_.accountId in p0.repostedBy);
      assert p.repostedBy == p0.repostedBy + [by_.accountId];
      forall u | u in p.repostedBy
        ensures |ProofLib.Filter((v: string) => (v == u), p.repostedBy)| == 1
      {
        ProofLib.FilterAppend((v: string) => (v == u), p0.repostedBy, by_.accountId);
        if u == by_.accountId {
          ProofLib.FilterNone((v: string) => (v == u), p0.repostedBy);
        }
      }
    }
  }
}

lemma RepostPostUnchanged(s: PostsState, postId: int, by_: Caller)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAccountIdsUnique(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  ensures alwaysSharedRateLimitBounded(repostPost(s, postId, by_))
  ensures alwaysAccountIdsUnique(repostPost(s, postId, by_))
  ensures alwaysFollowsAndBlocksConsistent(repostPost(s, postId, by_))
  ensures stepOnlyAuthorDeletesPost(s, "repostPost", repostPost(s, postId, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "repostPost", repostPost(s, postId, by_))
{
}

lemma repostPost_ensures(s: PostsState, postId: int, by_: Caller)
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysPostIdsPositiveAndUnique(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysPostTextLengthBounded(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysReplyTargetExistsAndNotSelf(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysSharedRateLimitBounded(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysAccountIdsUnique(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysAuthorAttributionValid(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysLikesUniqueAndCountMatches(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysRepostsUniqueAndCountMatches(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> alwaysFollowsAndBlocksConsistent(repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> stepOnlyAuthorDeletesPost(s, "repostPost", repostPost(s, postId, by_)))
  ensures (inv(s) ==> canRepostPost(s, postId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "repostPost", repostPost(s, postId, by_)))
{
  hide *;
  reveal inv, repostPost;
  if inv(s) && canRepostPost(s, postId, by_) {
    var after := repostPost(s, postId, by_);
    SamePostIdsUnique(s, after);
    SamePostTextLen(s, after);
    SamePostReplyGraph(s, after);
    SamePostQuoteGraph(s, after);
    SamePostAttribution(s, after);
    SamePostLikes(s, after);
    RepostPostReposts(s, postId, by_);
    RepostPostUnchanged(s, postId, by_);
  }
}

lemma UnrepostPostReposts(s: PostsState, postId: int, by_: Caller)
  requires alwaysPostIdsPositiveAndUnique(s)
  requires alwaysRepostsUniqueAndCountMatches(s)
  requires canUnrepostPost(s, postId, by_)
  ensures alwaysRepostsUniqueAndCountMatches(unrepostPost(s, postId, by_))
{
  var after := unrepostPost(s, postId, by_);
  PostIdsDistinct(s);
  RepostsBridge(s);
  RepostsBridge(after);
  var pRep :| pRep in s.posts && pRep.id == postId && by_.accountId in pRep.repostedBy;
  var iRep :| 0 <= iRep < |s.posts| && s.posts[iRep] == pRep;
  forall p | p in after.posts
    ensures p.repostCount == |p.repostedBy| && (forall u :: u in p.repostedBy ==> |ProofLib.Filter((v: string) => (v == u), p.repostedBy)| == 1)
  {
    var i :| 0 <= i < |after.posts| && after.posts[i] == p;
    var p0 := s.posts[i];
    assert p0 in s.posts;
    if p0.id == postId {
      assert i == iRep;
      StrRemovePreservesUnique(p0.repostedBy, by_.accountId);
    }
  }
}

lemma UnrepostPostUnchanged(s: PostsState, postId: int, by_: Caller)
  requires alwaysSharedRateLimitBounded(s)
  requires alwaysAccountIdsUnique(s)
  requires alwaysFollowsAndBlocksConsistent(s)
  ensures alwaysSharedRateLimitBounded(unrepostPost(s, postId, by_))
  ensures alwaysAccountIdsUnique(unrepostPost(s, postId, by_))
  ensures alwaysFollowsAndBlocksConsistent(unrepostPost(s, postId, by_))
  ensures stepOnlyAuthorDeletesPost(s, "unrepostPost", unrepostPost(s, postId, by_))
  ensures stepSharedRateLimitConsumedAcrossClients(s, "unrepostPost", unrepostPost(s, postId, by_))
{
}

lemma unrepostPost_ensures(s: PostsState, postId: int, by_: Caller)
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysPostIdsPositiveAndUnique(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysPostTextLengthBounded(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysReplyTargetExistsAndNotSelf(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysSharedRateLimitBounded(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysAccountIdsUnique(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysAuthorAttributionValid(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysLikesUniqueAndCountMatches(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysRepostsUniqueAndCountMatches(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> alwaysFollowsAndBlocksConsistent(unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> stepOnlyAuthorDeletesPost(s, "unrepostPost", unrepostPost(s, postId, by_)))
  ensures (inv(s) ==> canUnrepostPost(s, postId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "unrepostPost", unrepostPost(s, postId, by_)))
{
  hide *;
  reveal inv, unrepostPost;
  if inv(s) && canUnrepostPost(s, postId, by_) {
    var after := unrepostPost(s, postId, by_);
    SamePostIdsUnique(s, after);
    SamePostTextLen(s, after);
    SamePostReplyGraph(s, after);
    SamePostQuoteGraph(s, after);
    SamePostAttribution(s, after);
    SamePostLikes(s, after);
    UnrepostPostReposts(s, postId, by_);
    UnrepostPostUnchanged(s, postId, by_);
  }
}

lemma followUser_ensures(s: PostsState, targetId: string, by_: Caller)
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysPostIdsPositiveAndUnique(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysPostTextLengthBounded(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysReplyTargetExistsAndNotSelf(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysSharedRateLimitBounded(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysAccountIdsUnique(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysAuthorAttributionValid(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysLikesUniqueAndCountMatches(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysRepostsUniqueAndCountMatches(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> alwaysFollowsAndBlocksConsistent(followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> stepOnlyAuthorDeletesPost(s, "followUser", followUser(s, targetId, by_)))
  ensures (inv(s) ==> canFollowUser(s, targetId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "followUser", followUser(s, targetId, by_)))
{
  if inv(s) && canFollowUser(s, targetId, by_) {
    var after := followUser(s, targetId, by_);
    FollowsBlocksBridge(s);
    FollowsBlocksBridge(after);
    var nf := FollowEdge(by_.accountId, targetId);
    forall f | f in after.follows
      ensures |ProofLib.Filter((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), after.follows)| == 1
    {
      ProofLib.FilterAppend((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), s.follows, nf);
      if f == nf {
        ProofLib.FilterNone((g: FollowEdge) => ((g.followerId == f.followerId) && (g.followingId == f.followingId)), s.follows);
      }
    }
  }
}

lemma unfollowUser_ensures(s: PostsState, targetId: string, by_: Caller)
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysPostIdsPositiveAndUnique(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysPostTextLengthBounded(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysReplyTargetExistsAndNotSelf(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysSharedRateLimitBounded(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysAccountIdsUnique(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysAuthorAttributionValid(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysLikesUniqueAndCountMatches(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysRepostsUniqueAndCountMatches(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> alwaysFollowsAndBlocksConsistent(unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> stepOnlyAuthorDeletesPost(s, "unfollowUser", unfollowUser(s, targetId, by_)))
  ensures (inv(s) ==> canUnfollowUser(s, targetId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "unfollowUser", unfollowUser(s, targetId, by_)))
{
  if inv(s) && canUnfollowUser(s, targetId, by_) {
    var after := unfollowUser(s, targetId, by_);
    FollowsBlocksBridge(s);
    FollowsBlocksBridge(after);
    UnfollowBridge(s, targetId, by_);
    var keep := (f: FollowEdge) => !(((f.followerId == by_.accountId) && (f.followingId == targetId)));
    FollowCountUnique(s.follows);
    ProofLib.FilterKeepsDistinctBy(keep, s.follows, (f: FollowEdge) => (f.followerId, f.followingId));
    FollowUniqueToCount(after.follows);
    forall f | f in after.follows
      ensures f in s.follows && keep(f)
    {
      ProofLib.FilterMember(keep, s.follows, f);
    }
  }
}

lemma applyBlock_ensures(s: PostsState, targetId: string, by_: Caller)
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysPostIdsPositiveAndUnique(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysPostTextLengthBounded(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysReplyTargetExistsAndNotSelf(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysSharedRateLimitBounded(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysAccountIdsUnique(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysAuthorAttributionValid(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysLikesUniqueAndCountMatches(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysRepostsUniqueAndCountMatches(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> alwaysFollowsAndBlocksConsistent(applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> stepOnlyAuthorDeletesPost(s, "applyBlock", applyBlock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyBlock(s, targetId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "applyBlock", applyBlock(s, targetId, by_)))
{
  if inv(s) && canApplyBlock(s, targetId, by_) {
    var after := applyBlock(s, targetId, by_);
    FollowsBlocksBridge(s);
    FollowsBlocksBridge(after);
    ApplyBlockFollowsBridge(s, targetId, by_);
    var nb := BlockEdge(by_.accountId, targetId);
    forall b | b in after.blocks
      ensures |ProofLib.Filter((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), after.blocks)| == 1
    {
      ProofLib.FilterAppend((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks, nb);
      if b == nb {
        ProofLib.FilterNone((c: BlockEdge) => ((c.blockerId == b.blockerId) && (c.blockedId == b.blockedId)), s.blocks);
      }
    }
    var keep := (f: FollowEdge) => !((((f.followerId == by_.accountId) && (f.followingId == targetId)) || ((f.followerId == targetId) && (f.followingId == by_.accountId))));
    FollowCountUnique(s.follows);
    ProofLib.FilterKeepsDistinctBy(keep, s.follows, (f: FollowEdge) => (f.followerId, f.followingId));
    FollowUniqueToCount(after.follows);
    forall f | f in after.follows
      ensures f in s.follows && keep(f)
    {
      ProofLib.FilterMember(keep, s.follows, f);
    }
  }
}

lemma applyUnblock_ensures(s: PostsState, targetId: string, by_: Caller)
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysPostIdsPositiveAndUnique(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysPostTextLengthBounded(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysReplyTargetExistsAndNotSelf(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysQuoteTargetExistsAndNotSelf(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysSharedRateLimitBounded(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysAccountIdsUnique(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysAuthorAttributionValid(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysLikesUniqueAndCountMatches(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysRepostsUniqueAndCountMatches(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> alwaysFollowsAndBlocksConsistent(applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> stepOnlyAuthorDeletesPost(s, "applyUnblock", applyUnblock(s, targetId, by_)))
  ensures (inv(s) ==> canApplyUnblock(s, targetId, by_) ==> stepSharedRateLimitConsumedAcrossClients(s, "applyUnblock", applyUnblock(s, targetId, by_)))
{
  if inv(s) && canApplyUnblock(s, targetId, by_) {
    var after := applyUnblock(s, targetId, by_);
    FollowsBlocksBridge(s);
    FollowsBlocksBridge(after);
    ApplyUnblockBlocksBridge(s, targetId, by_);
    var keep := (b: BlockEdge) => !(((b.blockerId == by_.accountId) && (b.blockedId == targetId)));
    BlockCountUnique(s.blocks);
    ProofLib.FilterKeepsDistinctBy(keep, s.blocks, (b: BlockEdge) => (b.blockerId, b.blockedId));
    BlockUniqueToCount(after.blocks);
    forall b | b in after.blocks
      ensures b in s.blocks && keep(b)
    {
      ProofLib.FilterMember(keep, s.blocks, b);
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  AccountIdsBridge(s);
  PostIdsBridge(s);
  LikesBridge(s);
  RepostsBridge(s);
  FollowsBlocksBridge(s);
  forall a | a in s.accounts
    ensures |ProofLib.Filter((b: AccountInfo) => (b.id == a.id), s.accounts)| == 1
  {
    var i :| 0 <= i < |s.accounts| && s.accounts[i] == a;
    ProofLib.FilterOne((b: AccountInfo) => (b.id == a.id), s.accounts, i);
  }
}
