// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import type {
  LeaderboardAudienceFilter,
  LeaderboardMetric,
  LeaderboardScope,
  LeaderboardTimeframe,
  MarketTimeRange,
  PerpRebalanceOrderInput,
} from "@repo/ui";
import { passThrough, requestJson } from "./api.ts";
import {
  appendAnonymousModeParam,
  clearNotices,
  currentUiMode,
  getStoreSnapshot,
  incrementSpaNavDepth,
  pushBrowserRoute,
  recordPublicView,
  requireAuthOrQueue,
  sendApp,
  sendNav,
  setErrorNotice,
  setStatusNotice,
  setStoreState,
  toSpecTab,
  type StoreState,
  type ThreadReplySort,
  type UiFeedTab,
} from "./store-core.ts";
import {
  type AppNotification,
  type AppPerpMarket,
  type AppPost,
  type AppPredictionMarket,
  type ExploreAccountHit,
  type ExploreActorHit,
  decodeAlphaInvites,
  decodeArticle,
  decodeArticles,
  decodeChatMessages,
  decodeChats,
  decodeClosedPositions,
  decodeEconomy,
  decodeExplore,
  decodeFeedPage,
  decodeFollowList,
  decodeLeaderboardPage,
  decodeLeaderboardPosition,
  decodeMarketPriceHistory,
  decodeMarketTrades,
  decodeModerationList,
  decodeNotifications,
  decodePerpMarket,
  decodePerpPreview,
  decodePnlHistory,
  decodePositions,
  decodePost,
  decodePostThread,
  decodePredictionMarket,
  decodeProfileBundle,
  decodeTrendingList,
  decodeUsersSearch,
  decodeWorldStatus,
  isNotificationVisibleInMode,
  isRecord,
  arr,
  optStr,
  str,
} from "./types.ts";

const likeInFlight = new Set<string>();
const likeServerCountLanded = new Set<string>();
const repostInFlight = new Set<string>();
const repostServerCountLanded = new Set<string>();

export function markLikeServerCountLanded(postId: string): void {
  if (likeInFlight.has(postId)) likeServerCountLanded.add(postId);
}

export function markRepostServerCountLanded(postId: string): void {
  if (repostInFlight.has(postId)) repostServerCountLanded.add(postId);
}
const followInFlight = new Set<string>();
let feedRequestSeq = 0;
let feedLoadedTab: UiFeedTab = "latest";
let authorHideSeq = 0;
const authorHiddenAtSeq = new Map<string, number>();

function captureAuthorHides(): number {
  return authorHideSeq;
}

function wasAuthorHiddenSince(handle: string, hidesAtStart: number): boolean {
  return (authorHiddenAtSeq.get(handle.toLowerCase()) ?? 0) > hidesAtStart;
}

export function clearAuthorHides(): void {
  authorHiddenAtSeq.clear();
}

function stripPostAttribution(p: AppPost, stripRepost: boolean, stripQuote: boolean): AppPost {
  if (!stripRepost && !stripQuote) return p;
  return {
    ...p,
    card: {
      ...p.card,
      ...(stripRepost ? { repostedBy: undefined, repostedByHandle: undefined } : {}),
      ...(stripQuote ? { quotePost: undefined } : {}),
    },
  };
}

function dropAuthorsHiddenSince(
  posts: ReadonlyArray<AppPost>,
  hidesAtStart: number,
): ReadonlyArray<AppPost> {
  if (hidesAtStart === authorHideSeq) return posts;
  const cleanPost = (p: AppPost): AppPost => {
    const reposter = p.card.repostedBy?.handle ?? p.card.repostedByHandle;
    const stripRepost = reposter !== undefined && wasAuthorHiddenSince(reposter, hidesAtStart);
    const stripQuote = p.card.quotePost !== undefined && wasAuthorHiddenSince(p.card.quotePost.authorHandle, hidesAtStart);
    return stripPostAttribution(p, stripRepost, stripQuote);
  };
  return posts.filter((p) => !wasAuthorHiddenSince(p.card.authorHandle, hidesAtStart)).map(cleanPost);
}
let exploreRequestSeq = 0;
let userSearchRequestSeq = 0;
let marketDetailsRequestSeq = 0;
let leaderboardRequestSeq = 0;
let leaderboardLoadedControls: {
  readonly audience: LeaderboardAudienceFilter;
  readonly timeframe: LeaderboardTimeframe;
  readonly scope: LeaderboardScope;
  readonly metric: LeaderboardMetric;
  readonly page: number;
} = { audience: "traders", timeframe: "ALL", scope: "players", metric: "net_profit", page: 1 };
let pnlHistoryRequestSeq = 0;
let closedPositionsLoadCount = 0;
let economyLoadCount = 0;

function appendUniquePosts(
  existing: ReadonlyArray<AppPost>,
  incoming: ReadonlyArray<AppPost>,
): ReadonlyArray<AppPost> {
  const seen = new Set(existing.map((p) => p.card.id));
  const merged = [...existing];
  for (const post of incoming) {
    if (!seen.has(post.card.id)) {
      seen.add(post.card.id);
      merged.push(post);
    }
  }
  return merged;
}

function findPostInState(postId: string): AppPost | undefined {
  const s = getStoreSnapshot();
  return s.feedPosts.find((p) => p.card.id === postId)
    ?? (s.activeThread?.post.card.id === postId ? s.activeThread.post : undefined)
    ?? s.activeThread?.ancestors.find((p) => p.card.id === postId)
    ?? s.activeThread?.replies.find((p) => p.card.id === postId)
    ?? s.profileBundle?.posts.find((p) => p.card.id === postId)
    ?? s.profileReplies.find((p) => p.card.id === postId)
    ?? s.profileLikes.find((p) => p.card.id === postId)
    ?? s.marketSocialPosts.find((p) => p.card.id === postId)
    ?? s.explore.posts.find((p) => p.card.id === postId);
}

type EngagementState = Pick<AppPost["card"], "liked" | "likeCount" | "reposted" | "repostCount">;

function engagementOf(card: AppPost["card"]): EngagementState {
  return { liked: card.liked, likeCount: card.likeCount, reposted: card.reposted, repostCount: card.repostCount };
}

function captureEngagement(): ReadonlyMap<string, EngagementState> {
  const s = getStoreSnapshot();
  const captured = new Map<string, EngagementState>();
  const lists: ReadonlyArray<ReadonlyArray<AppPost>> = [
    s.feedPosts,
    s.explore.posts,
    s.profileBundle?.posts ?? [],
    s.profileReplies,
    s.profileLikes,
    s.marketSocialPosts,
    s.activeThread ? [s.activeThread.post, ...(s.activeThread.parentPost ? [s.activeThread.parentPost] : []), ...s.activeThread.ancestors, ...s.activeThread.replies] : [],
  ];
  for (const list of lists) {
    for (const post of list) {
      if (!captured.has(post.card.id)) captured.set(post.card.id, engagementOf(post.card));
    }
  }
  return captured;
}

function preserveEngagementSince(
  posts: ReadonlyArray<AppPost>,
  captured: ReadonlyMap<string, EngagementState>,
): ReadonlyArray<AppPost> {
  return posts.map((post) => {
    const start = captured.get(post.card.id);
    const current = findPostInState(post.card.id);
    if (!start || !current) return post;
    const now = engagementOf(current.card);
    if (now.liked === start.liked && now.likeCount === start.likeCount && now.reposted === start.reposted && now.repostCount === start.repostCount) {
      if (likeInFlight.has(post.card.id)) markLikeServerCountLanded(post.card.id);
      if (repostInFlight.has(post.card.id)) markRepostServerCountLanded(post.card.id);
      return post;
    }
    return { ...post, card: { ...post.card, ...now } };
  });
}

export function patchPostCardAcrossStore(postId: string, updater: (card: AppPost["card"]) => AppPost["card"]): void {
  const patchPost = (post: AppPost): AppPost =>
    post.card.id === postId ? { ...post, card: updater(post.card) } : post;
  const patchList = (list: ReadonlyArray<AppPost>) => list.map(patchPost);
  const cur = getStoreSnapshot();
  setStoreState({
    feedPosts: patchList(cur.feedPosts),
    explore: { ...cur.explore, posts: patchList(cur.explore.posts) },
    profileBundle: cur.profileBundle ? { ...cur.profileBundle, posts: patchList(cur.profileBundle.posts) } : null,
    profileReplies: patchList(cur.profileReplies),
    profileLikes: patchList(cur.profileLikes),
    marketSocialPosts: patchList(cur.marketSocialPosts),
    activeThread: cur.activeThread
      ? {
          post: patchPost(cur.activeThread.post),
          parentPost: cur.activeThread.parentPost ? patchPost(cur.activeThread.parentPost) : null,
          ancestors: patchList(cur.activeThread.ancestors),
          replies: patchList(cur.activeThread.replies),
        }
      : null,
  });
}

function cleanedPostLists(
  cur: StoreState,
  cleanList: (list: ReadonlyArray<AppPost>) => ReadonlyArray<AppPost>,
  cleanProfileList: (list: ReadonlyArray<AppPost>) => ReadonlyArray<AppPost> = cleanList,
): Pick<StoreState, "feedPosts" | "explore" | "profileBundle" | "profileReplies" | "profileLikes" | "marketSocialPosts"> {
  return {
    feedPosts: cleanList(cur.feedPosts),
    explore: { ...cur.explore, posts: cleanList(cur.explore.posts) },
    profileBundle: cur.profileBundle
      ? { ...cur.profileBundle, posts: cleanProfileList(cur.profileBundle.posts) }
      : null,
    profileReplies: cleanProfileList(cur.profileReplies),
    profileLikes: cleanList(cur.profileLikes),
    marketSocialPosts: cleanList(cur.marketSocialPosts),
  };
}

export function removePostAcrossStore(
  postId: string,
  parentInfo?: { readonly replyToPostId?: string | null; readonly parentReplyCount?: number | null },
): void {
  const cur = getStoreSnapshot();
  const existing = findPostInState(postId);
  const parentId = parentInfo?.replyToPostId ?? existing?.replyToPostId ?? null;
  const thread = cur.activeThread;
  const adjustParent = (post: AppPost): AppPost => {
    if (!parentId || post.card.id !== parentId) return post;
    const nextCount = typeof parentInfo?.parentReplyCount === "number"
      ? Math.max(0, parentInfo.parentReplyCount)
      : Math.max(0, post.card.replyCount - 1);
    return { ...post, card: { ...post.card, replyCount: nextCount } };
  };
  const cleanList = (list: ReadonlyArray<AppPost>) => list.filter((p) => p.card.id !== postId).map(adjustParent);
  const bundle = cur.profileBundle;
  const removedFromProfile = bundle !== null
    && existing !== undefined
    && existing.card.authorHandle.toLowerCase() === bundle.summary.handle.toLowerCase()
    && (bundle.posts.some((p) => p.card.id === postId) || cur.profileReplies.some((p) => p.card.id === postId));
  const cleaned = cleanedPostLists(cur, cleanList);
  setStoreState({
    ...cleaned,
    profileBundle: cleaned.profileBundle
      ? {
          ...cleaned.profileBundle,
          postsCount: removedFromProfile ? Math.max(0, cleaned.profileBundle.postsCount - 1) : cleaned.profileBundle.postsCount,
        }
      : null,
    activeThread: thread
      ? thread.post.card.id === postId
        ? null
        : {
            post: adjustParent(thread.post),
            parentPost: thread.parentPost ? adjustParent(thread.parentPost) : null,
            ancestors: cleanList(thread.ancestors),
            replies: cleanList(thread.replies),
          }
      : null,
  });
}

function filterAuthorOutOfFeeds(handle: string): void {
  const normalized = handle.toLowerCase();
  const isBlockedHandle = (value: string): boolean => value.toLowerCase() === normalized;
  const reposterHandle = (p: AppPost): string | undefined => p.card.repostedBy?.handle ?? p.card.repostedByHandle;
  const isBlockedReposter = (p: AppPost): boolean => {
    const reposter = reposterHandle(p);
    return reposter !== undefined && isBlockedHandle(reposter);
  };
  const cleanPost = (p: AppPost): AppPost => stripPostAttribution(
    p,
    isBlockedReposter(p),
    p.card.quotePost !== undefined && isBlockedHandle(p.card.quotePost.authorHandle),
  );
  const cleanList = (list: ReadonlyArray<AppPost>): ReadonlyArray<AppPost> =>
    list.filter((p) => !isBlockedHandle(p.card.authorHandle)).map(cleanPost);
  const cur = getStoreSnapshot();
  const profileOwnerBlocked = cur.profileBundle !== null && isBlockedHandle(cur.profileBundle.summary.handle);
  const cleanProfileList = profileOwnerBlocked
    ? (list: ReadonlyArray<AppPost>): ReadonlyArray<AppPost> =>
        list.filter((p) => !isBlockedHandle(p.card.authorHandle) && !isBlockedReposter(p)).map(cleanPost)
    : cleanList;
  const thread = cur.activeThread;
  setStoreState({
    ...cleanedPostLists(cur, cleanList, cleanProfileList),
    activeThread: thread
      ? isBlockedHandle(thread.post.card.authorHandle)
        ? null
        : {
            post: cleanPost(thread.post),
            parentPost: thread.parentPost && !isBlockedHandle(thread.parentPost.card.authorHandle)
              ? cleanPost(thread.parentPost)
              : null,
            ancestors: cleanList(thread.ancestors),
            replies: cleanList(thread.replies),
          }
      : null,
  });
}

function syncAtRiskPositions(positions: ReadonlyArray<{ readonly isClosed: boolean }>): void {
  const atRisk = positions.some((p) => !p.isClosed);
  sendNav({ type: "setAtRiskPositions", atRisk });
  sendApp({ type: "updateAtRiskPositions", atRisk });
}

export async function loadFeed(tabOverride?: UiFeedTab): Promise<void> {
  const s = getStoreSnapshot();
  const tab = tabOverride ?? s.feedTab;
  const viewerId = s.viewer?.accountId ?? null;
  const reqSeq = ++feedRequestSeq;
  const engagementAtStart = captureEngagement();
  const hidesAtStart = captureAuthorHides();
  setStoreState({ feedLoading: true });
  const url = appendAnonymousModeParam(`/api/feed?tab=${encodeURIComponent(tab)}`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  const latest = getStoreSnapshot();
  if (reqSeq !== feedRequestSeq || latest.feedTab !== tab) return;
  if (res.ok) {
    feedLoadedTab = tab;
    setStoreState({
      feedPosts: dropAuthorsHiddenSince(preserveEngagementSince(res.data.items, engagementAtStart), hidesAtStart),
      feedNextCursor: res.data.nextCursor,
      feedLoading: false,
      pendingNewPostCount: 0,
    });
    return;
  }
  if (feedLoadedTab !== tab && (feedLoadedTab === "latest" || latest.viewer !== null)) {
    const specTab = toSpecTab(feedLoadedTab);
    sendNav({ type: "selectFeedTab", tab: specTab });
    sendApp({ type: "selectTab", tab: specTab });
    setStoreState({ feedTab: feedLoadedTab, feedLoading: false });
  } else if (feedLoadedTab !== tab) {
    setStoreState({ feedPosts: [], feedNextCursor: null, feedLoading: false });
  } else {
    setStoreState({ feedLoading: false });
  }
  setErrorNotice(res.message);
}

export async function flushPendingNewPosts(): Promise<void> {
  if (typeof window !== "undefined") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  setStoreState({ pendingNewPostCount: 0 });
  await loadFeed();
}

export async function loadMoreFeed(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.feedNextCursor || s.feedLoading || s.feedLoadingMore) return;
  const tab = s.feedTab;
  const viewerId = s.viewer?.accountId ?? null;
  const reqSeq = feedRequestSeq;
  const hidesAtStart = captureAuthorHides();
  setStoreState({ feedLoadingMore: true });
  const url = appendAnonymousModeParam(
    `/api/feed?tab=${encodeURIComponent(tab)}&cursor=${encodeURIComponent(s.feedNextCursor)}`,
    s,
  );
  const res = await requestJson(url, { parse: (raw) => decodeFeedPage(raw, viewerId) });
  const latest = getStoreSnapshot();
  if (reqSeq !== feedRequestSeq || latest.feedTab !== tab) {
    setStoreState({ feedLoadingMore: false });
    return;
  }
  if (res.ok) {
    setStoreState({
      feedPosts: appendUniquePosts(latest.feedPosts, dropAuthorsHiddenSince(res.data.items, hidesAtStart)),
      feedNextCursor: res.data.nextCursor,
      feedLoadingMore: false,
    });
    return;
  }
  setStoreState({ feedLoadingMore: false });
  setErrorNotice(res.message);
}

export async function loadTrending(): Promise<void> {
  const s = getStoreSnapshot();
  setStoreState({ trendingLoading: true });
  const [trendRes, articlesRes] = await Promise.all([
    requestJson(appendAnonymousModeParam("/api/trending", s), { parse: decodeTrendingList }),
    requestJson(appendAnonymousModeParam("/api/articles?limit=10", s), { parse: decodeArticles }),
  ]);
  const cur = getStoreSnapshot();
  const nextTrending = trendRes.ok ? trendRes.data : cur.rightRailTrending;
  const nextArticles = articlesRes.ok && articlesRes.data.length > 0 ? articlesRes.data : cur.rightRailArticles;
  setStoreState({
    trendingLoading: false,
    rightRailTrending: nextTrending,
    rightRailArticles: nextArticles,
    explore: {
      ...cur.explore,
      ...(trendRes.ok ? { trending: trendRes.data } : {}),
      ...(articlesRes.ok && articlesRes.data.length > 0 ? { articles: articlesRes.data } : {}),
    },
  });
}

export async function selectFeedTab(tab: UiFeedTab): Promise<void> {
  const s = getStoreSnapshot();
  if (tab === "following" && s.viewer === null) {
    requireAuthOrQueue({ kind: "switch_tab", tab, label: "view the Following feed" });
    return;
  }
  const specTab = toSpecTab(tab);
  sendNav({ type: "selectFeedTab", tab: specTab });
  sendApp({ type: "selectTab", tab: specTab });
  setStoreState({ feedTab: tab });
  await loadFeed(tab);
}

let threadRequestSeq = 0;

export async function openThread(postId: string, sortOverride?: ThreadReplySort): Promise<void> {
  const s = getStoreSnapshot();
  const prevSort = s.threadSort;
  const sort = sortOverride ?? s.threadSort;
  const viewerId = s.viewer?.accountId ?? null;
  threadRequestSeq += 1;
  const requestSeq = threadRequestSeq;
  const engagementAtStart = captureEngagement();
  setStoreState({
    threadLoading: true,
    activePostId: postId,
    threadSort: sort,
    activeThread: s.activeThread?.post.card.id === postId ? s.activeThread : null,
  });
  recordPublicView("PostDetail");
  const baseUrl = `/api/posts/${encodeURIComponent(postId)}?sort=${encodeURIComponent(sort)}`;
  const res = await requestJson(appendAnonymousModeParam(baseUrl, s), {
    parse: (raw) => decodePostThread(raw, viewerId),
  });
  if (requestSeq !== threadRequestSeq) return;
  if (res.ok && res.data) {
    const thread = res.data;
    setStoreState({
      activeThread: {
        post: preserveEngagementSince([thread.post], engagementAtStart)[0] ?? thread.post,
        parentPost: thread.parentPost ? preserveEngagementSince([thread.parentPost], engagementAtStart)[0] ?? thread.parentPost : null,
        ancestors: preserveEngagementSince(thread.ancestors, engagementAtStart),
        replies: preserveEngagementSince(thread.replies, engagementAtStart),
      },
      threadLoading: false,
    });
    return;
  }
  setStoreState({ threadLoading: false, threadSort: prevSort });
  setErrorNotice(res.ok ? "Post not found" : res.message);
}

export function closeThread(): void {
  threadRequestSeq += 1;
  setStoreState({ activeThread: null, activePostId: null, threadLoading: false });
}

export async function loadArticle(articleId: string): Promise<void> {
  const s = getStoreSnapshot();
  const cached = s.explore.articles.find((a) => a.id === articleId) ?? null;
  setStoreState({
    activeArticleId: articleId,
    activeArticle: cached,
    articleLoading: true,
  });
  recordPublicView("Explore");
  const res = await requestJson(appendAnonymousModeParam(`/api/articles/${encodeURIComponent(articleId)}`, s), {
    parse: decodeArticle,
  });
  if (getStoreSnapshot().activeArticleId !== articleId) return;
  if (res.ok && res.data) {
    setStoreState({ activeArticle: res.data, articleLoading: false });
    return;
  }
  setStoreState({ articleLoading: false });
  if (!cached) {
    setErrorNotice(res.ok ? "Article not found" : res.message);
  }
}

export async function createPost(
  content: string,
  options?: { readonly replyToPostId?: string; readonly quotePostId?: string; readonly marketId?: string; readonly ticker?: string },
): Promise<boolean> {
  const label = options?.replyToPostId ? "reply to this post" : options?.quotePostId ? "quote this post" : "publish this post";
  const pending = options?.replyToPostId
    ? { kind: "reply" as const, postId: options.replyToPostId, content, label }
    : { kind: "post" as const, content, ...(options?.quotePostId ? { quotePostId: options.quotePostId } : {}), label };
  if (!requireAuthOrQueue(pending)) return false;
  clearNotices();
  const viewerId = getStoreSnapshot().viewer?.accountId ?? null;
  const res = await requestJson("/api/posts", {
    method: "POST",
    body: {
      content,
      ...(options?.replyToPostId ? { replyToPostId: options.replyToPostId } : {}),
      ...(options?.quotePostId ? { quotePostId: options.quotePostId } : {}),
      ...(options?.marketId ? { marketId: options.marketId } : {}),
      ...(options?.ticker ? { ticker: options.ticker } : {}),
    },
    parse: (raw) => decodePost(raw, viewerId),
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice(options?.replyToPostId ? "Reply posted." : "Post published.");
  const cur = getStoreSnapshot();
  if (res.data && !options?.replyToPostId) {
    const matchesActiveMarket =
      (options?.ticker && cur.selectedMarketKind === "perp" && cur.selectedMarketId?.toUpperCase() === options.ticker.toUpperCase()) ||
      (options?.marketId && cur.selectedMarketKind === "prediction" && cur.selectedMarketId === options.marketId);
    const bundle = cur.profileBundle;
    const bundleIsAuthor =
      bundle !== null && bundle.summary.handle.toLowerCase() === res.data.card.authorHandle.toLowerCase();
    const bundleHasPost = bundleIsAuthor && bundle.posts.some((p) => p.card.id === res.data?.card.id);
    setStoreState({
      feedPosts: [res.data, ...cur.feedPosts.filter((p) => p.card.id !== res.data?.card.id)],
      ...(matchesActiveMarket
        ? { marketSocialPosts: [res.data, ...cur.marketSocialPosts.filter((p) => p.card.id !== res.data?.card.id)] }
        : {}),
      ...(bundleIsAuthor && !bundleHasPost
        ? {
            profileBundle: {
              ...bundle,
              posts: [res.data, ...bundle.posts],
              postsCount: bundle.postsCount + 1,
            },
          }
        : {}),
    });
  } else {
    await loadFeed();
  }
  const thread = getStoreSnapshot().activeThread;
  if (thread && options?.replyToPostId === thread.post.card.id) {
    await openThread(thread.post.card.id, getStoreSnapshot().threadSort);
  }
  return true;
}

export async function deletePost(postId: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson(`/api/posts/${encodeURIComponent(postId)}`, {
    method: "DELETE",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const replyToPostId = optStr(rec.replyToPostId ?? rec.reply_to_post_id);
  const parentReplyCount = typeof rec.parentReplyCount === "number" ? rec.parentReplyCount : null;
  const wasActiveDetail = getStoreSnapshot().route === "PostDetail" && getStoreSnapshot().activePostId === postId;
  removePostAcrossStore(postId, { replyToPostId, parentReplyCount });
  setStatusNotice("Post deleted.");
  if (wasActiveDetail) {
    pushBrowserRoute("Home");
    setStoreState({ route: "Home", activePostId: null });
  }
  return true;
}

export async function toggleLike(postId: string): Promise<void> {
  const existing = findPostInState(postId);
  const currentlyLiked = existing?.card.liked ?? false;
  if (!requireAuthOrQueue({ kind: "like", postId, currentlyLiked, label: "like this post" })) return;
  if (likeInFlight.has(postId)) return;
  likeInFlight.add(postId);
  likeServerCountLanded.delete(postId);
  const prevCount = existing?.card.likeCount ?? 0;
  const optimisticLiked = !currentlyLiked;
  const optimisticCount = Math.max(0, prevCount + (optimisticLiked ? 1 : -1));
  patchPostCardAcrossStore(postId, (card) => ({
    ...card,
    liked: optimisticLiked,
    likeCount: optimisticCount,
  }));
  try {
    const res = await requestJson(`/api/posts/${encodeURIComponent(postId)}/like`, {
      method: currentlyLiked ? "DELETE" : "POST",
      parse: passThrough,
    });
    if (!res.ok) {
      const serverCountLanded = likeServerCountLanded.has(postId);
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        liked: currentlyLiked,
        ...(serverCountLanded ? {} : { likeCount: prevCount }),
      }));
      setErrorNotice(res.message);
      return;
    }
    const rec = isRecord(res.data) ? res.data : {};
    const serverLiked = typeof rec.liked === "boolean" ? rec.liked : optimisticLiked;
    const serverCount = typeof rec.likeCount === "number" ? rec.likeCount : optimisticCount;
    patchPostCardAcrossStore(postId, (card) => ({
      ...card,
      liked: serverLiked,
      likeCount: Math.max(0, card.likeCount + (serverCount - optimisticCount)),
    }));
  } finally {
    likeInFlight.delete(postId);
    likeServerCountLanded.delete(postId);
  }
}

export async function repostPost(postId: string): Promise<void> {
  const existing = findPostInState(postId);
  const currentlyReposted = existing?.card.reposted ?? false;
  if (!requireAuthOrQueue({ kind: "repost", postId, label: currentlyReposted ? "remove repost" : "repost this post" })) return;
  if (repostInFlight.has(postId)) return;
  repostInFlight.add(postId);
  repostServerCountLanded.delete(postId);
  const prevCount = existing?.card.repostCount ?? 0;
  const optimisticReposted = !currentlyReposted;
  const optimisticCount = Math.max(0, prevCount + (optimisticReposted ? 1 : -1));
  patchPostCardAcrossStore(postId, (card) => ({
    ...card,
    reposted: optimisticReposted,
    repostCount: optimisticCount,
  }));
  try {
    const res = await requestJson(`/api/posts/${encodeURIComponent(postId)}/repost`, {
      method: currentlyReposted ? "DELETE" : "POST",
      parse: passThrough,
    });
    if (!res.ok) {
      const serverCountLanded = repostServerCountLanded.has(postId);
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        reposted: currentlyReposted,
        ...(serverCountLanded ? {} : { repostCount: prevCount }),
      }));
      setErrorNotice(res.message);
      return;
    }
    const rec = isRecord(res.data) ? res.data : {};
    const serverReposted = typeof rec.reposted === "boolean" ? rec.reposted : optimisticReposted;
    const serverCount = typeof rec.repostCount === "number" ? rec.repostCount : optimisticCount;
    patchPostCardAcrossStore(postId, (card) => ({
      ...card,
      reposted: serverReposted,
      repostCount: Math.max(0, card.repostCount + (serverCount - optimisticCount)),
    }));
  } finally {
    repostInFlight.delete(postId);
    repostServerCountLanded.delete(postId);
  }
}

export async function loadExplore(queryOverride?: string): Promise<void> {
  const s = getStoreSnapshot();
  const q = queryOverride ?? s.exploreQuery;
  const viewerId = s.viewer?.accountId ?? null;
  const reqSeq = ++exploreRequestSeq;
  const engagementAtStart = captureEngagement();
  setStoreState({ exploreLoading: true, exploreQuery: q });
  const url = appendAnonymousModeParam(`/api/explore?q=${encodeURIComponent(q.trim())}`, s);
  const needMarkets = s.perps.length === 0;
  const [res, mktRes] = await Promise.all([
    requestJson(url, {
      parse: (raw) => decodeExplore(raw, viewerId),
    }),
    needMarkets ? requestJson("/api/markets", { parse: passThrough }) : Promise.resolve(null),
  ]);
  if (reqSeq !== exploreRequestSeq) return;
  let marketPatch: Partial<Pick<ReturnType<typeof getStoreSnapshot>, "predictions" | "perps" | "positions">> = {};
  if (mktRes && mktRes.ok && isRecord(mktRes.data)) {
    const rawPreds = arr(mktRes.data.predictions ?? mktRes.data.predictionMarkets);
    const rawPerps = arr(mktRes.data.perps ?? mktRes.data.perpMarkets);
    const predictions = rawPreds.map(decodePredictionMarket).filter((m): m is AppPredictionMarket => m !== null);
    const perps = rawPerps.map(decodePerpMarket).filter((m): m is AppPerpMarket => m !== null);
    if (mktRes.data.positions !== undefined) {
      const positions = decodePositions(mktRes.data.positions);
      syncAtRiskPositions(positions);
      marketPatch = { predictions, perps, positions };
    } else {
      marketPatch = { predictions, perps };
    }
  }
  if (res.ok) {
    const cur = getStoreSnapshot();
    const isBrowse = q.trim() === "";
    setStoreState({
      explore: { ...res.data, posts: preserveEngagementSince(res.data.posts, engagementAtStart) },
      ...(isBrowse && res.data.trending.length > 0 ? { rightRailTrending: res.data.trending } : {}),
      ...(isBrowse && res.data.articles.length > 0 ? { rightRailArticles: res.data.articles } : {}),
      exploreLoading: false,
      trendingLoading: false,
      ...marketPatch,
      ...(isBrowse ? {} : { rightRailTrending: cur.rightRailTrending, rightRailArticles: cur.rightRailArticles }),
    });
    return;
  }
  setStoreState({ exploreLoading: false, trendingLoading: false, ...marketPatch });
  setErrorNotice(res.message);
}

export async function loadTrendingTag(tag: string): Promise<void> {
  const cleanTag = tag.trim();
  const s = getStoreSnapshot();
  const viewerId = s.viewer?.accountId ?? null;
  const reqSeq = ++exploreRequestSeq;
  const engagementAtStart = captureEngagement();
  setStoreState({ activeTrendingTag: cleanTag, exploreQuery: cleanTag, exploreLoading: true });
  const url = appendAnonymousModeParam(`/api/trending/${encodeURIComponent(cleanTag)}`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (reqSeq !== exploreRequestSeq) return;
  if (res.ok) {
    const cur = getStoreSnapshot();
    setStoreState({
      explore: {
        ...cur.explore,
        posts: preserveEngagementSince(res.data.items, engagementAtStart),
        accounts: [],
        actors: [],
        organizations: [],
        tags: [],
      },
      exploreLoading: false,
    });
    return;
  }
  setStoreState({ exploreLoading: false });
  await loadExplore(cleanTag);
}

export async function searchAccounts(query: string): Promise<{
  readonly accounts: ReadonlyArray<ExploreAccountHit>;
  readonly actors: ReadonlyArray<ExploreActorHit>;
} | null> {
  const trimmed = query.trim().replace(/^@/, "");
  if (!trimmed) return { accounts: [], actors: [] };
  const reqSeq = ++userSearchRequestSeq;
  const res = await requestJson(`/api/users/search?q=${encodeURIComponent(trimmed)}&limit=12`, {
    parse: decodeUsersSearch,
  });
  if (reqSeq !== userSearchRequestSeq) {
    return null;
  }
  if (!res.ok) {
    return { accounts: [], actors: [] };
  }
  return res.data;
}

export async function loadPositionsSilent(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson("/api/markets", { parse: passThrough });
  if (!res.ok || !isRecord(res.data)) return;
  const rawPreds = arr(res.data.predictions ?? res.data.predictionMarkets);
  const rawPerps = arr(res.data.perps ?? res.data.perpMarkets);
  const predictions = rawPreds.map(decodePredictionMarket).filter((m): m is AppPredictionMarket => m !== null);
  const perps = rawPerps.map(decodePerpMarket).filter((m): m is AppPerpMarket => m !== null);
  const positions = res.data.positions !== undefined ? decodePositions(res.data.positions) : getStoreSnapshot().positions;
  syncAtRiskPositions(positions);
  setStoreState({ predictions, perps, positions });
}

function audienceToScope(audience: LeaderboardAudienceFilter): LeaderboardScope {
  return audience === "npcs" ? "characters" : "players";
}

export async function loadLeaderboard(options?: {
  readonly scope?: LeaderboardScope;
  readonly audience?: LeaderboardAudienceFilter;
  readonly timeframe?: LeaderboardTimeframe;
  readonly metric?: LeaderboardMetric;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<void> {
  const s = getStoreSnapshot();
  const audience = options?.audience ?? (options?.scope ? (options.scope === "characters" ? "npcs" : "traders") : s.leaderboardAudience);
  const scope = options?.scope ?? audienceToScope(audience);
  const timeframe = options?.timeframe ?? s.leaderboardTimeframe;
  const metric = options?.metric ?? s.leaderboardMetric;
  const page = Math.max(1, options?.page ?? s.leaderboardPage);
  const pageSize = options?.pageSize ?? 25;
  const reqSeq = ++leaderboardRequestSeq;
  setStoreState({
    leaderboardLoading: true,
    leaderboardAudience: audience,
    leaderboardTimeframe: timeframe,
    leaderboardScope: scope,
    leaderboardMetric: metric,
    leaderboardPage: page,
  });
  const params = new URLSearchParams({
    scope,
    metric,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (audience === "all" || timeframe !== "ALL") {
    params.set("filter", audience);
    params.set("timeframe", timeframe);
  }
  const res = await requestJson(`/api/leaderboard?${params.toString()}`, {
    parse: (raw) => decodeLeaderboardPage(raw, scope, metric),
  });
  if (reqSeq !== leaderboardRequestSeq) return;
  if (res.ok) {
    leaderboardLoadedControls = {
      audience,
      timeframe,
      scope: res.data.scope,
      metric: res.data.metric,
      page: res.data.page,
    };
    setStoreState({
      leaderboard: res.data.entries,
      leaderboardAudience: audience,
      leaderboardTimeframe: timeframe,
      leaderboardScope: res.data.scope,
      leaderboardMetric: res.data.metric,
      leaderboardPage: res.data.page,
      leaderboardTotalPages: res.data.totalPages,
      leaderboardTotalCount: res.data.totalCount,
      leaderboardCurrentUser: res.data.currentUser,
      leaderboardLoading: false,
    });
    return;
  }
  setStoreState({
    leaderboardLoading: false,
    leaderboardAudience: leaderboardLoadedControls.audience,
    leaderboardTimeframe: leaderboardLoadedControls.timeframe,
    leaderboardScope: leaderboardLoadedControls.scope,
    leaderboardMetric: leaderboardLoadedControls.metric,
    leaderboardPage: leaderboardLoadedControls.page,
  });
  setErrorNotice(res.message);
}

export async function jumpToMyLeaderboardRank(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const params = new URLSearchParams({
    metric: s.leaderboardMetric,
    pageSize: "25",
  });
  if (s.leaderboardAudience === "all" || s.leaderboardTimeframe !== "ALL") {
    params.set("filter", s.leaderboardAudience === "npcs" ? "traders" : s.leaderboardAudience);
    params.set("timeframe", s.leaderboardTimeframe);
  }
  const res = await requestJson(`/api/leaderboard/me?${params.toString()}`, {
    parse: decodeLeaderboardPosition,
  });
  if (res.ok && res.data) {
    setStoreState({ leaderboardCurrentUser: res.data.entry });
    await loadLeaderboard({
      audience: s.leaderboardAudience === "npcs" ? "traders" : s.leaderboardAudience,
      timeframe: s.leaderboardTimeframe,
      metric: s.leaderboardMetric,
      page: res.data.page,
      pageSize: 25,
    });
    return;
  }
  if (!res.ok) {
    setErrorNotice(res.message);
  }
}

export async function loadEconomy(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const loadId = ++economyLoadCount;
  setStoreState({ economyLoading: true });
  const res = await requestJson("/api/economy/me", { parse: decodeEconomy });
  if (loadId !== economyLoadCount) return;
  if (res.ok) {
    setStoreState({
      economy: res.data.economy,
      ledger: res.data.ledger,
      economyLoading: false,
    });
    return;
  }
  setStoreState({ economyLoading: false });
}

export async function loadWorldStatus(): Promise<void> {
  const res = await requestJson("/api/world/status", { parse: decodeWorldStatus });
  if (res.ok && res.data) {
    setStoreState({ worldStatus: res.data });
  }
}

export async function loadPnlHistory(rangeOverride?: MarketTimeRange): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const range = rangeOverride ?? s.pnlTimeRange;
  const reqSeq = ++pnlHistoryRequestSeq;
  setStoreState({ pnlHistoryLoading: true, pnlTimeRange: range });
  const res = await requestJson(`/api/economy/me/pnl-history?range=${encodeURIComponent(range)}`, {
    parse: decodePnlHistory,
  });
  if (reqSeq !== pnlHistoryRequestSeq) return;
  if (res.ok) {
    setStoreState({ pnlHistory: res.data, pnlHistoryLoading: false });
    return;
  }
  setStoreState({ pnlHistoryLoading: false });
}

export async function loadClosedPositions(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const loadId = ++closedPositionsLoadCount;
  setStoreState({ closedPositionsLoading: true });
  const res = await requestJson("/api/markets/positions/closed?limit=50", {
    parse: decodeClosedPositions,
  });
  if (loadId !== closedPositionsLoadCount) return;
  if (res.ok) {
    setStoreState({ closedPositions: res.data, closedPositionsLoading: false });
    return;
  }
  setStoreState({ closedPositionsLoading: false });
}

export async function loadMarketDetails(
  kind: "prediction" | "perp",
  id: string,
  rangeOverride?: MarketTimeRange,
): Promise<void> {
  const s = getStoreSnapshot();
  const viewerId = s.viewer?.accountId ?? null;
  const range = rangeOverride ?? s.marketTimeRange;
  const reqSeq = ++marketDetailsRequestSeq;
  setStoreState({ marketHistoryLoading: true, marketTradesLoading: true, marketTimeRange: range });
  const basePath = kind === "perp"
    ? `/api/markets/perp/${encodeURIComponent(id)}`
    : `/api/markets/predictions/${encodeURIComponent(id)}`;
  const feedUrl = appendAnonymousModeParam(
    kind === "perp"
      ? `/api/feed?ticker=${encodeURIComponent(id)}&limit=20`
      : `/api/feed?marketId=${encodeURIComponent(id)}&limit=20`,
    s,
  );
  const [histRes, tradesRes, socialRes] = await Promise.all([
    requestJson(`${basePath}/history?range=${encodeURIComponent(range)}&limit=200`, { parse: decodeMarketPriceHistory }),
    requestJson(`${basePath}/trades?limit=40`, { parse: decodeMarketTrades }),
    requestJson(feedUrl, { parse: (raw) => decodeFeedPage(raw, viewerId) }),
  ]);
  if (reqSeq !== marketDetailsRequestSeq) return;
  const latest = getStoreSnapshot();
  if (latest.selectedMarketKind !== kind || latest.selectedMarketId !== id) return;
  setStoreState({
    marketHistory: histRes.ok ? histRes.data : [],
    marketHistoryLoading: false,
    marketTrades: tradesRes.ok ? tradesRes.data : [],
    marketTradesLoading: false,
    marketSocialPosts: socialRes.ok ? socialRes.data.items : [],
  });
}

export async function setMarketTimeRange(range: MarketTimeRange): Promise<void> {
  const s = getStoreSnapshot();
  setStoreState({ marketTimeRange: range });
  if (s.marketsViewMode === "terminal" && s.selectedMarketId) {
    await loadMarketDetails(s.selectedMarketKind, s.selectedMarketId, range);
  }
}

export type PerpOrderMode = "open" | "add" | "reduce" | "flip";

export async function previewPerpOrder(
  ticker: string,
  side: "long" | "short",
  marginPts: number,
  leverage: number,
  mode?: PerpOrderMode,
): Promise<void> {
  if (!Number.isFinite(marginPts) || marginPts <= 0 || !Number.isFinite(leverage) || leverage < 1) {
    setStoreState({ perpPreview: null });
    return;
  }
  const collateralCents = Math.max(1, Math.round(marginPts * 100));
  const res = await requestJson("/api/markets/perp/preview", {
    method: "POST",
    body: {
      ticker,
      side,
      collateralCents,
      collateralPts: marginPts,
      leverage: Math.round(leverage),
      ...(mode ? { mode } : {}),
    },
    parse: decodePerpPreview,
  });
  const latest = getStoreSnapshot();
  if (latest.selectedMarketKind !== "perp" || latest.selectedMarketId?.toUpperCase() !== ticker.toUpperCase()) return;
  setStoreState({ perpPreview: res.ok ? res.data : null });
}

let marketsLoadCount = 0;

export async function loadMarkets(): Promise<void> {
  const loadId = ++marketsLoadCount;
  setStoreState({ marketsLoading: true });
  const mktRes = await requestJson("/api/markets", { parse: passThrough });
  if (loadId !== marketsLoadCount) return;
  const s = getStoreSnapshot();
  let predictions = s.predictions;
  let perps = s.perps;
  let positions = s.positions;
  if (mktRes.ok && isRecord(mktRes.data)) {
    const rawPreds = arr(mktRes.data.predictions ?? mktRes.data.predictionMarkets);
    const rawPerps = arr(mktRes.data.perps ?? mktRes.data.perpMarkets);
    predictions = rawPreds.map(decodePredictionMarket).filter((m): m is AppPredictionMarket => m !== null);
    perps = rawPerps.map(decodePerpMarket).filter((m): m is AppPerpMarket => m !== null);
    if (mktRes.data.positions !== undefined) {
      positions = decodePositions(mktRes.data.positions);
    }
  }
  syncAtRiskPositions(positions);
  let selectedMarketKind = s.selectedMarketKind;
  let selectedMarketId = s.selectedMarketId;
  let marketsViewMode = s.marketsViewMode;
  if (s.selectedTicker) {
    const matchedPerp = perps.find((p) => p.ticker.toUpperCase() === s.selectedTicker?.toUpperCase());
    if (matchedPerp) {
      selectedMarketKind = "perp";
      selectedMarketId = matchedPerp.ticker;
      marketsViewMode = "terminal";
    }
  }
  if (!selectedMarketId && marketsViewMode !== "terminal") {
    if (selectedMarketKind === "perp" && perps[0]) {
      selectedMarketId = perps[0].ticker;
    } else if (predictions[0]) {
      selectedMarketKind = "prediction";
      selectedMarketId = predictions[0].card.id;
    } else if (perps[0]) {
      selectedMarketKind = "perp";
      selectedMarketId = perps[0].ticker;
    }
  }
  setStoreState({
    marketsLoading: false,
    marketsViewMode,
    predictions,
    perps,
    positions,
    selectedMarketKind,
    selectedMarketId,
  });
  if (s.route === "Markets" && !s.walletView && marketsViewMode === "terminal" && selectedMarketId) {
    const exists =
      selectedMarketKind === "perp"
        ? perps.some((p) => p.ticker.toUpperCase() === selectedMarketId?.toUpperCase())
        : predictions.some((p) => p.card.id === selectedMarketId);
    if (exists) {
      void loadMarketDetails(selectedMarketKind, selectedMarketId);
    }
  }
}

export function selectMarket(kind: "prediction" | "perp", id: string): void {
  recordPublicView("Markets");
  setStoreState({
    selectedMarketKind: kind,
    selectedMarketId: id,
    selectedMarketSide: "YES",
    marketSideIntentSeq: getStoreSnapshot().marketSideIntentSeq + 1,
    selectedTicker: kind === "perp" ? id : null,
    marketsViewMode: "terminal",
    marketHistory: [],
    marketTrades: [],
    marketSocialPosts: [],
    perpPreview: null,
    tradeError: null,
  });
  if (typeof window !== "undefined") {
    const targetPath = kind === "perp"
      ? `/markets/perps/${encodeURIComponent(id)}`
      : `/markets/predictions/${encodeURIComponent(id)}`;
    if (window.location.pathname !== targetPath) {
      incrementSpaNavDepth();
      window.history.pushState(null, "", targetPath);
    }
    if (typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
  }
  void loadMarketDetails(kind, id);
  if (kind === "perp") {
    void previewPerpOrder(id, "long", 10, 5, "open");
  }
}

export function openMarketsDashboard(): void {
  setStoreState({
    marketsViewMode: "dashboard",
    selectedTicker: null,
    perpPreview: null,
    tradeError: null,
  });
  if (typeof window !== "undefined") {
    if (window.location.pathname !== "/markets") {
      incrementSpaNavDepth();
      window.history.pushState(null, "", "/markets");
    }
    if (typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
  }
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function executeTradeRequest({
  endpoint,
  body,
  headers,
  statusMessage,
  formatReceiptMessage,
}: {
  readonly endpoint: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly statusMessage: string;
  readonly formatReceiptMessage?: (data: unknown) => string;
}): Promise<boolean> {
  setStoreState({ tradeLoading: true, tradeError: null });
  const res = await requestJson(endpoint, { method: "POST", body, headers, parse: passThrough });
  if (!res.ok) {
    setStoreState({ tradeLoading: false, tradeError: res.message });
    setErrorNotice(res.message);
    return false;
  }
  const curViewer = getStoreSnapshot().viewer;
  const bal = isRecord(res.data) && typeof res.data.balanceAfterCents === "number" ? res.data.balanceAfterCents : curViewer?.balanceCents;
  setStoreState({
    tradeLoading: false,
    ...(curViewer && bal !== undefined ? { viewer: { ...curViewer, balanceCents: bal } } : {}),
  });
  setStatusNotice(formatReceiptMessage ? formatReceiptMessage(res.data) : statusMessage);
  await loadMarkets();
  return true;
}

export async function submitPredictionOrder(
  marketId: string,
  action: "Buy" | "Sell",
  side: "yes" | "no",
  amountPts: number,
  shareUnitsOverride?: number,
): Promise<boolean> {
  if (getStoreSnapshot().tradeLoading) return false;
  const computedShareUnits = action === "Sell"
    ? (shareUnitsOverride !== undefined ? Math.max(1, Math.round(shareUnitsOverride)) : Math.max(1, Math.round(amountPts * 100)))
    : undefined;
  if (
    !requireAuthOrQueue({
      kind: "trade_prediction",
      marketId,
      action,
      side,
      amountPts,
      ...(computedShareUnits !== undefined ? { shareUnits: computedShareUnits } : {}),
      label: `${action} ${side.toUpperCase()} prediction`,
    })
  ) {
    return false;
  }
  const endpoint = action === "Buy"
    ? `/api/markets/predictions/${encodeURIComponent(marketId)}/buy`
    : `/api/markets/predictions/${encodeURIComponent(marketId)}/sell`;
  const body = action === "Buy"
    ? { side, amountCents: Math.max(1, Math.round(amountPts * 100)), amountPts }
    : { side, shareUnits: computedShareUnits, shares: computedShareUnits };
  const ok = await executeTradeRequest({
    endpoint,
    body,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    statusMessage: `${action} ${side.toUpperCase()} executed.`,
  });
  if (ok && getStoreSnapshot().walletView) {
    await Promise.all([loadEconomy(), loadClosedPositions(), loadPnlHistory()]);
  }
  return ok;
}

export async function submitPerpOrder(
  ticker: string,
  side: "long" | "short",
  marginPts: number,
  leverage: number,
  mode?: PerpOrderMode,
): Promise<boolean> {
  if (getStoreSnapshot().tradeLoading) return false;
  if (!requireAuthOrQueue({ kind: "trade_perp", ticker, side, marginPts, leverage, label: `open $${ticker} ${side} perp` })) {
    return false;
  }
  const roundedLeverage = Math.max(1, Math.round(leverage));
  const ok = await executeTradeRequest({
    endpoint: `/api/markets/perp/${encodeURIComponent(ticker)}/open`,
    body: {
      side,
      collateralCents: Math.max(1, Math.round(marginPts * 100)),
      collateralPts: marginPts,
      leverage: roundedLeverage,
      ...(mode ? { mode } : {}),
    },
    headers: { "Idempotency-Key": newIdempotencyKey() },
    statusMessage: `Opened $${ticker} ${side} ${roundedLeverage}x position.`,
    formatReceiptMessage: (data) => {
      const action = isRecord(data) ? str(data.action, "open") : "open";
      if (action === "add") return `Added to $${ticker} ${side} position.`;
      if (action === "flip") return `Flipped $${ticker} position to ${side} ${roundedLeverage}x.`;
      if (action === "reduce") return `Reduced $${ticker} position.`;
      return `Opened $${ticker} ${side} ${roundedLeverage}x position.`;
    },
  });
  if (ok && getStoreSnapshot().walletView) {
    await Promise.all([loadEconomy(), loadClosedPositions(), loadPnlHistory()]);
  }
  return ok;
}

export async function closePerpPosition(
  positionId: string,
  options?: { readonly sizeCents?: number; readonly closePct?: number },
): Promise<boolean> {
  if (!getStoreSnapshot().viewer || getStoreSnapshot().tradeLoading) return false;
  const body: Record<string, number> = {};
  if (options?.sizeCents !== undefined && options.sizeCents > 0) {
    body.sizeCents = Math.max(1, Math.round(options.sizeCents));
  }
  if (options?.closePct !== undefined && options.closePct > 0 && options.closePct <= 100) {
    body.closePct = options.closePct;
  }
  const ok = await executeTradeRequest({
    endpoint: `/api/markets/perp/positions/${encodeURIComponent(positionId)}/close`,
    body,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    statusMessage: "Position closed.",
    formatReceiptMessage: (data) => {
      const isFull = isRecord(data) && typeof data.isFullClose === "boolean" ? data.isFullClose : true;
      return isFull ? "Position closed." : "Position partially closed.";
    },
  });
  if (ok && getStoreSnapshot().walletView) {
    await Promise.all([loadEconomy(), loadClosedPositions(), loadPnlHistory()]);
  }
  return ok;
}

export async function rebalancePerpPosition(order: PerpRebalanceOrderInput): Promise<void> {
  const mode = order.mode ?? order.action;
  if (mode === "reduce") {
    await closePerpPosition(order.positionId, {
      sizeCents: Math.max(1, Math.round(order.deltaNotionalPts * 100)),
    });
    return;
  }
  await submitPerpOrder(order.ticker, order.nextSide, order.marginPts, order.leverage, mode);
}

export async function markChatRead(chatId: string): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const cur = getStoreSnapshot();
  const target = cur.chats.find((c) => c.id === chatId);
  const unreadChatNotifications = cur.notifications.filter(
    (n) => n.eventKind === "ChatMessage" && n.chatId === chatId && !n.item.read,
  );
  if (target && target.unreadCount > 0) {
    setStoreState({
      chats: cur.chats.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)),
    });
  }
  if (unreadChatNotifications.length > 0) {
    setStoreState({
      notifications: cur.notifications.map((n) =>
        n.eventKind === "ChatMessage" && n.chatId === chatId && !n.item.read
          ? { ...n, item: { ...n.item, read: true } }
          : n,
      ),
      unreadNotifications: Math.max(0, cur.unreadNotifications - unreadChatNotifications.length),
    });
  }
  await requestJson(`/api/chats/${encodeURIComponent(chatId)}/read`, {
    method: "POST",
    body: {},
    parse: passThrough,
  });
}

let chatsLoadCount = 0;

export async function loadChats(loadMessages = true, preferredChatId?: string | null): Promise<void> {
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  if (!viewerId) return;
  const loadId = ++chatsLoadCount;
  if (loadMessages) setStoreState({ chatsLoading: true });
  const [chatsRes, invitesRes] = await Promise.all([
    requestJson("/api/chats", { parse: (raw) => decodeChats(raw, viewerId) }),
    requestJson("/api/chats/invites", { parse: decodeAlphaInvites }),
  ]);
  if (loadId !== chatsLoadCount) return;
  const s = getStoreSnapshot();
  const nextChats = chatsRes.ok ? chatsRes.data : s.chats;
  const preferred = preferredChatId ?? s.selectedChatId;
  const selectedId = preferred && nextChats.some((c) => c.id === preferred)
    ? preferred
    : (nextChats[0]?.id ?? null);
  setStoreState({
    chatsLoading: false,
    chats: nextChats,
    selectedChatId: selectedId,
    ...(selectedId !== s.selectedChatId ? { chatMessages: [] } : {}),
    alphaInvites: invitesRes.ok ? invitesRes.data : s.alphaInvites,
  });
  if (loadMessages && selectedId) {
    await loadChatMessages(selectedId);
  }
}

let chatMessagesLoadCount = 0;

export async function loadChatMessages(chatId: string): Promise<void> {
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  if (!viewerId) return;
  const loadId = ++chatMessagesLoadCount;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    parse: (raw) => decodeChatMessages(raw, viewerId),
  });
  if (loadId !== chatMessagesLoadCount) return;
  if (res.ok && getStoreSnapshot().selectedChatId === chatId) {
    setStoreState({ chatMessages: res.data });
    if (res.data.length > 0) {
      await markChatRead(chatId);
    }
  }
}

export async function selectChat(chatId: string): Promise<void> {
  const s = getStoreSnapshot();
  setStoreState({
    selectedChatId: chatId,
    ...(s.selectedChatId !== chatId ? { chatMessages: [] } : {}),
  });
  await loadChatMessages(chatId);
}

export async function startDirectChat(targetHandleOrId: string): Promise<boolean> {
  if (!requireAuthOrQueue({ kind: "dm", handle: targetHandleOrId, label: `message @${targetHandleOrId}` })) return false;
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  const res = await requestJson("/api/chats/direct", {
    method: "POST",
    body: { targetHandleOrId, recipientHandleOrId: targetHandleOrId },
    parse: (raw) => decodeChats([isRecord(raw) && raw.chat ? raw.chat : raw], viewerId),
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const createdId = res.data[0]?.id ?? null;
  if (getStoreSnapshot().route !== "Chats") {
    pushBrowserRoute("Chats");
    sendNav({ type: "navigateTo", targetRoute: "Chats" });
    sendApp({ type: "navigateApp", targetRoute: "Chats" });
    setStoreState({ route: "Chats" });
  }
  await loadChats(false, createdId);
  if (createdId) {
    await selectChat(createdId);
  }
  return true;
}

export async function createGroupChat(title: string, memberHandles: ReadonlyArray<string>): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson("/api/chats/group", {
    method: "POST",
    body: { title, memberHandles },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const rec = isRecord(res.data) ? (isRecord(res.data.chat) ? res.data.chat : res.data) : {};
  const chatId = optStr(rec.id);
  setStatusNotice(`Created group "${title}".`);
  await loadChats(false, chatId);
  if (chatId) await selectChat(chatId);
  return true;
}

export async function inviteToGroupChat(chatId: string, targetHandleOrId: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const cleaned = targetHandleOrId.trim().replace(/^@/, "");
  if (!cleaned) return false;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/invite`, {
    method: "POST",
    body: { targetHandleOrId: cleaned },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice(`Invited @${cleaned} to group.`);
  await loadChats();
  return true;
}

async function mutateAndClearGroupChat(
  path: string,
  method: "POST" | "DELETE",
  chatId: string,
  notice: string,
  body?: Record<string, unknown>,
): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson(path, {
    method,
    ...(body ? { body } : {}),
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const s = getStoreSnapshot();
  setStoreState({
    selectedChatId: s.selectedChatId === chatId ? null : s.selectedChatId,
    chatMessages: s.selectedChatId === chatId ? [] : s.chatMessages,
  });
  setStatusNotice(notice);
  await loadChats();
  return true;
}

export function leaveGroupChat(chatId: string): Promise<boolean> {
  return mutateAndClearGroupChat(
    `/api/chats/${encodeURIComponent(chatId)}/leave`,
    "POST",
    chatId,
    "Left group chat.",
    {},
  );
}

export async function renameGroupChat(chatId: string, title: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}`, {
    method: "PATCH",
    body: { title: trimmed },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice(`Renamed group to "${trimmed}".`);
  await loadChats(false);
  return true;
}

export async function removeGroupMember(chatId: string, targetHandleOrId: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const cleaned = targetHandleOrId.trim().replace(/^@/, "");
  if (!cleaned) return false;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(cleaned)}`, {
    method: "DELETE",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice("Member removed from group.");
  await loadChats(false);
  return true;
}

export async function transferGroupOwnership(chatId: string, newOwnerHandleOrId: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const cleaned = newOwnerHandleOrId.trim().replace(/^@/, "");
  if (!cleaned) return false;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/transfer`, {
    method: "POST",
    body: { newOwnerHandleOrId: cleaned },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice(`Transferred group ownership to @${cleaned}.`);
  await loadChats(false, chatId);
  return true;
}

export function deleteGroupChat(chatId: string): Promise<boolean> {
  return mutateAndClearGroupChat(
    `/api/chats/${encodeURIComponent(chatId)}`,
    "DELETE",
    chatId,
    "Group chat deleted.",
  );
}

export async function sendChatMessage(chatId: string, content: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  setStoreState({ chatSending: true });
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: { content },
    parse: passThrough,
  });
  setStoreState({ chatSending: false });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const stillOpen = getStoreSnapshot().selectedChatId === chatId;
  await Promise.all([stillOpen ? loadChatMessages(chatId) : undefined, loadChats(false)]);
  return true;
}

export async function reactToChatMessage(messageId: string, emoji: string): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer || !s.selectedChatId) return;
  const res = await requestJson(
    `/api/chats/${encodeURIComponent(s.selectedChatId)}/messages/${encodeURIComponent(messageId)}/reactions`,
    {
      method: "POST",
      body: { emoji },
      parse: passThrough,
    },
  );
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  await loadChatMessages(s.selectedChatId);
}

export async function respondGroupInvite(inviteId: string, accept: boolean): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson(`/api/chats/invites/${encodeURIComponent(inviteId)}/respond`, {
    method: "POST",
    body: { accept },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  setStatusNotice(accept ? "Joined group." : "Invite declined.");
  const cur = getStoreSnapshot();
  setStoreState({
    notifications: cur.notifications.map((n) =>
      n.inviteId === inviteId ? { ...n, item: { ...n.item, read: true, invitePending: false } } : n,
    ),
  });
  await Promise.all([loadChats(cur.route === "Chats"), loadNotifications()]);
}

let notificationsLoadCount = 0;
let notificationsMutationCount = 0;
let notificationsIdsBeforeMutation = new Set<string>();

function invalidateNotificationsLoads(): void {
  notificationsLoadCount += 1;
  notificationsMutationCount += 1;
}

function captureNotificationIdsBeforeMutation(): void {
  notificationsIdsBeforeMutation = new Set(getStoreSnapshot().notifications.map((n) => n.item.id));
}

function mergeNotificationsFromDiscardedRefetch(items: readonly AppNotification[]): boolean {
  const s = getStoreSnapshot();
  const payloadIds = new Set(items.map((n) => n.item.id));
  const merged: AppNotification[] = [];
  for (const n of items) {
    const local = s.notifications.find((l) => l.item.id === n.item.id);
    if (local) {
      merged.push(local);
    } else if (!notificationsIdsBeforeMutation.has(n.item.id)) {
      merged.push(n);
    }
  }
  for (const l of s.notifications) {
    if (!payloadIds.has(l.item.id)) merged.push(l);
  }
  if (merged.length === s.notifications.length && merged.every((n, i) => n === s.notifications[i])) return false;
  setStoreState({
    notifications: merged,
    unreadNotifications: merged.filter((n) => !n.item.read).length,
  });
  return true;
}

export async function loadNotifications(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const loadId = ++notificationsLoadCount;
  const mutationCount = notificationsMutationCount;
  setStoreState({ notificationsLoading: true });
  const res = await requestJson("/api/notifications", { parse: decodeNotifications });
  if (loadId !== notificationsLoadCount) {
    setStoreState({ notificationsLoading: false });
    if (mutationCount !== notificationsMutationCount && res.ok && mergeNotificationsFromDiscardedRefetch(res.data.items)) {
      void loadNotifications();
    }
    return;
  }
  if (res.ok) {
    setStoreState({
      notifications: res.data.items,
      unreadNotifications: res.data.unreadCount,
      notificationsLoading: false,
    });
    return;
  }
  setStoreState({ notificationsLoading: false });
  setErrorNotice(res.message);
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const cur = getStoreSnapshot();
  const target = cur.notifications.find((n) => n.item.id === notificationId);
  if (!target || target.item.read) return;
  captureNotificationIdsBeforeMutation();
  setStoreState({
    notifications: cur.notifications.map((n) =>
      n.item.id === notificationId ? { ...n, item: { ...n.item, read: true } } : n,
    ),
    unreadNotifications: Math.max(0, cur.unreadNotifications - 1),
  });
  const res = await requestJson("/api/notifications/read", {
    method: "POST",
    body: { notificationIds: [notificationId] },
    parse: passThrough,
  });
  if (!res.ok) {
    const latest = getStoreSnapshot();
    const current = latest.notifications.find((n) => n.item.id === notificationId);
    if (current?.item.read) {
      setStoreState({
        notifications: latest.notifications.map((n) =>
          n.item.id === notificationId ? { ...n, item: { ...n.item, read: false } } : n,
        ),
        unreadNotifications: latest.unreadNotifications + 1,
      });
    }
    setErrorNotice(res.message);
    return;
  }
  if (res.ok) {
    invalidateNotificationsLoads();
    const s = getStoreSnapshot();
    setStoreState({
      notifications: s.notifications.map((n) =>
        n.item.id === notificationId ? { ...n, item: { ...n.item, read: true } } : n,
      ),
    });
    if (isRecord(res.data) && typeof res.data.unreadCount === "number") {
      setStoreState({ unreadNotifications: res.data.unreadCount });
    }
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  const initial = getStoreSnapshot();
  const accountId = initial.viewer?.accountId;
  if (!accountId) return;
  const mode = currentUiMode(initial);
  captureNotificationIdsBeforeMutation();
  invalidateNotificationsLoads();
  const res = await requestJson("/api/notifications/read", {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  const s = getStoreSnapshot();
  if (s.viewer?.accountId !== accountId) return;
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  invalidateNotificationsLoads();
  if (currentUiMode(s) !== mode) {
    await loadNotifications();
    return;
  }
  const notifications = s.notifications.map((n) =>
    isNotificationVisibleInMode(n, mode) ? { ...n, item: { ...n.item, read: true } } : n,
  );
  setStoreState({
    notifications,
    unreadNotifications: notifications.filter((n) => isNotificationVisibleInMode(n, mode) && !n.item.read).length,
  });
}

export async function clearNotifications(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  captureNotificationIdsBeforeMutation();
  const res = await requestJson("/api/notifications", {
    method: "DELETE",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  invalidateNotificationsLoads();
  setStoreState({
    notifications: [],
    unreadNotifications: 0,
  });
  setStatusNotice("Notifications cleared.");
}

let profileLoadCount = 0;

export async function loadProfile(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) {
    setStoreState({
      profileBundle: null,
      profileHandle: null,
      profileReplies: [],
      profileLikes: [],
      profileTrades: [],
      profileLoading: false,
    });
    return;
  }
  const loadId = ++profileLoadCount;
  const engagementAtStart = captureEngagement();
  const lower = handle.toLowerCase();
  const bundle = s.profileBundle;
  const sameProfile =
    bundle !== null &&
    (bundle.summary.handle.toLowerCase() === lower ||
      bundle.id.toLowerCase() === lower ||
      bundle.orgMeta?.ticker?.toLowerCase() === lower);
  setStoreState({
    profileLoading: true,
    profileHandle: handle,
    ...(sameProfile ? {} : { profileBundle: null, profileReplies: [], profileLikes: [], profileTrades: [] }),
  });
  const url = appendAnonymousModeParam(`/api/users/${encodeURIComponent(handle)}`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null),
  });
  if (loadId !== profileLoadCount || getStoreSnapshot().profileHandle?.toLowerCase() !== handle.toLowerCase()) return;
  if (res.ok && res.data) {
    setStoreState({
      profileBundle: { ...res.data, posts: preserveEngagementSince(res.data.posts, engagementAtStart) },
      profileLoading: false,
    });
    return;
  }
  const cur = getStoreSnapshot().profileBundle;
  if (!res.ok && res.status !== 404 && cur !== null && cur.summary.handle.toLowerCase() === handle.toLowerCase()) {
    setStoreState({ profileLoading: false });
    setErrorNotice(res.message);
    return;
  }
  setStoreState({ profileBundle: null, profileLoading: false });
  setErrorNotice(res.ok ? "Profile not found" : res.message);
}

let profileRepliesLoadCount = 0;

export async function loadProfileReplies(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileBundle?.summary.handle ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  const loadId = ++profileRepliesLoadCount;
  const engagementAtStart = captureEngagement();
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ profileRepliesLoading: true });
  const url = appendAnonymousModeParam(
    `/api/posts?authorHandle=${encodeURIComponent(handle)}&filter=replies&limit=40`,
    s,
  );
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (loadId !== profileRepliesLoadCount) return;
  if (!isProfileHandleCurrent(handle)) {
    setStoreState({ profileRepliesLoading: false });
    return;
  }
  if (res.ok) {
    setStoreState({ profileReplies: preserveEngagementSince(res.data.items, engagementAtStart), profileRepliesLoading: false });
    return;
  }
  setStoreState({ profileRepliesLoading: false });
  setErrorNotice(res.message);
}

function isProfileHandleCurrent(handle: string): boolean {
  const cur = getStoreSnapshot();
  const lower = handle.toLowerCase();
  const bundle = cur.profileBundle;
  const bundleMatches = (key: string | null) =>
    bundle !== null &&
    key !== null &&
    (bundle.summary.handle.toLowerCase() === key || bundle.id.toLowerCase() === key || bundle.orgMeta?.ticker?.toLowerCase() === key);
  return (
    cur.route === "Profile" &&
    (cur.profileHandle?.toLowerCase() === lower || (bundleMatches(lower) && (cur.profileHandle === null || bundleMatches(cur.profileHandle.toLowerCase()))))
  );
}

let profileLikesLoadCount = 0;

export async function loadProfileLikes(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileBundle?.summary.handle ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  const loadId = ++profileLikesLoadCount;
  const engagementAtStart = captureEngagement();
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ profileLikesLoading: true });
  const url = appendAnonymousModeParam(`/api/users/${encodeURIComponent(handle)}/likes?limit=40`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (loadId !== profileLikesLoadCount) return;
  if (!isProfileHandleCurrent(handle)) {
    setStoreState({ profileLikesLoading: false });
    return;
  }
  if (res.ok) {
    setStoreState({ profileLikes: preserveEngagementSince(res.data.items, engagementAtStart), profileLikesLoading: false });
    return;
  }
  setStoreState({ profileLikesLoading: false });
  setErrorNotice(res.message);
}

let profileTradesLoadCount = 0;

export async function loadProfileTrades(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileBundle?.summary.handle ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  const loadId = ++profileTradesLoadCount;
  setStoreState({ profileTradesLoading: true });
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/trades?limit=50`, {
    parse: decodeMarketTrades,
  });
  if (loadId !== profileTradesLoadCount) return;
  if (!isProfileHandleCurrent(handle)) {
    setStoreState({ profileTradesLoading: false });
    return;
  }
  if (res.ok) {
    setStoreState({ profileTrades: res.data, profileTradesLoading: false });
    return;
  }
  setStoreState({ profileTradesLoading: false });
  setErrorNotice(res.message);
}

export async function loadMoreProfilePosts(): Promise<void> {
  const s = getStoreSnapshot();
  const bundle = s.profileBundle;
  if (!bundle || !bundle.postsNextCursor || s.profileLoading || s.profileLoadingMore) return;
  const loadId = profileLoadCount;
  setStoreState({ profileLoadingMore: true });
  const url = appendAnonymousModeParam(
    `/api/users/${encodeURIComponent(bundle.summary.handle)}?cursor=${encodeURIComponent(bundle.postsNextCursor)}`,
    s,
  );
  const res = await requestJson(url, {
    parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null),
  });
  if (loadId !== profileLoadCount) {
    setStoreState({ profileLoadingMore: false });
    return;
  }
  if (res.ok && res.data) {
    const latest = getStoreSnapshot().profileBundle;
    if (latest && latest.id === res.data.id) {
      setStoreState({
        profileBundle: {
          ...latest,
          posts: appendUniquePosts(latest.posts, res.data.posts),
          postsNextCursor: res.data.postsNextCursor,
        },
        profileLoadingMore: false,
      });
      return;
    }
    setStoreState({ profileLoadingMore: false });
    return;
  }
  setStoreState({ profileLoadingMore: false });
  setErrorNotice(res.ok ? "Profile not found" : res.message);
}

let followListLoadCount = 0;

export async function loadFollowList(handle: string, kind: "followers" | "following"): Promise<void> {
  const loadId = ++followListLoadCount;
  setStoreState({
    followListHandle: handle,
    followListKind: kind,
    followListItems: [],
    followListLoading: true,
  });
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/${kind}`, {
    parse: decodeFollowList,
  });
  if (loadId !== followListLoadCount) return;
  if (res.ok) {
    setStoreState({ followListItems: res.data, followListLoading: false });
    return;
  }
  setStoreState({ followListLoading: false });
  setErrorNotice(res.message);
}

export function closeFollowList(): void {
  setStoreState({ followListKind: null, followListHandle: null, followListItems: [] });
}

export async function loadModerationLists(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  setStoreState({ moderationLoading: true });
  const [blockedRes, mutedRes] = await Promise.all([
    requestJson("/api/moderation/blocks", { parse: decodeModerationList }),
    requestJson("/api/moderation/mutes", { parse: decodeModerationList }),
  ]);
  const cur = getStoreSnapshot();
  setStoreState({
    moderationLoading: false,
    blockedAccounts: blockedRes.ok ? blockedRes.data : cur.blockedAccounts,
    mutedAccounts: mutedRes.ok ? mutedRes.data : cur.mutedAccounts,
  });
  const failed = !blockedRes.ok ? blockedRes : !mutedRes.ok ? mutedRes : null;
  if (failed) {
    setErrorNotice(failed.message);
  }
}

export async function updateOwnProfile(payload: {
  readonly displayName?: string;
  readonly bio?: string;
  readonly avatarUrl?: string | null;
  readonly bannerUrl?: string | null;
}): Promise<boolean> {
  const s = getStoreSnapshot();
  if (!s.viewer) return false;
  const res = await requestJson("/api/users/me", {
    method: "PATCH",
    body: payload,
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const nextDisplayName = str(rec.displayName, payload.displayName ?? s.viewer.displayName);
  const nextBio = str(rec.bio, payload.bio ?? s.viewer.bio);
  const nextAvatar = optStr(rec.avatarUrl) ?? (payload.avatarUrl !== undefined ? payload.avatarUrl : s.viewer.avatarUrl);
  const nextBanner = optStr(rec.bannerUrl) ?? (payload.bannerUrl !== undefined ? payload.bannerUrl : s.viewer.bannerUrl);
  setStoreState({
    viewer: {
      ...s.viewer,
      displayName: nextDisplayName,
      bio: nextBio,
      avatarUrl: nextAvatar,
      bannerUrl: nextBanner,
    },
  });
  const cur = getStoreSnapshot();
  if (cur.profileBundle?.summary.isOwnProfile && cur.profileBundle.summary.handle.toLowerCase() === s.viewer.handle.toLowerCase()) {
    const nextSummary = { ...cur.profileBundle.summary, displayName: nextDisplayName };
    if (nextBio) nextSummary.bio = nextBio;
    else delete nextSummary.bio;
    if (nextAvatar) nextSummary.avatarUrl = nextAvatar;
    else delete nextSummary.avatarUrl;
    if (nextBanner) nextSummary.bannerUrl = nextBanner;
    else delete nextSummary.bannerUrl;
    setStoreState({ profileBundle: { ...cur.profileBundle, summary: nextSummary } });
  }
  setStatusNotice("Profile updated.");
  if (s.route === "Profile" && s.profileBundle?.summary.isOwnProfile) {
    await loadProfile(s.viewer.handle);
    if (getStoreSnapshot().profileReplies.length > 0) {
      await loadProfileReplies(s.viewer.handle);
    }
  }
  return true;
}

function patchFollowAcrossStore(handle: string, nextFollowing: boolean, optimisticBundleHandle?: string | null): void {
  const lower = handle.toLowerCase();
  const cur = getStoreSnapshot();
  const viewerHandle = cur.viewer?.handle.toLowerCase() ?? "";
  const profileMatches = Boolean(cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower);
  const viewingOwnProfile = Boolean(cur.profileBundle?.summary.isOwnProfile && lower !== viewerHandle);
  const sameBundleAsOptimistic = optimisticBundleHandle === undefined
    || (cur.profileBundle !== null && cur.profileBundle.summary.handle.toLowerCase() === optimisticBundleHandle);
  const delta = nextFollowing ? 1 : -1;
  const patchPostAuthor = (p: AppPost): AppPost =>
    p.card.authorHandle.toLowerCase() === lower ? { ...p, card: { ...p.card, isFollowingAuthor: nextFollowing } } : p;
  const patchPosts = (list: ReadonlyArray<AppPost>) => list.map(patchPostAuthor);

  let nextProfileBundle = cur.profileBundle;
  if (cur.profileBundle) {
    const nextPosts = patchPosts(cur.profileBundle.posts);
    if (profileMatches) {
      const countDelta = cur.profileBundle.summary.isFollowing === nextFollowing ? 0 : delta;
      nextProfileBundle = {
        ...cur.profileBundle,
        posts: nextPosts,
        summary: {
          ...cur.profileBundle.summary,
          isFollowing: nextFollowing,
          followersCount: Math.max(0, cur.profileBundle.summary.followersCount + countDelta),
        },
      };
    } else if (viewingOwnProfile) {
      nextProfileBundle = {
        ...cur.profileBundle,
        posts: nextPosts,
        summary: {
          ...cur.profileBundle.summary,
          followingCount: sameBundleAsOptimistic
            ? Math.max(0, cur.profileBundle.summary.followingCount + delta)
            : cur.profileBundle.summary.followingCount,
        },
      };
    } else {
      nextProfileBundle = {
        ...cur.profileBundle,
        posts: nextPosts,
      };
    }
  }

  setStoreState({
    profileBundle: nextProfileBundle,
    profileReplies: patchPosts(cur.profileReplies),
    profileLikes: patchPosts(cur.profileLikes),
    marketSocialPosts: patchPosts(cur.marketSocialPosts),
    activeThread: cur.activeThread
      ? {
          post: patchPostAuthor(cur.activeThread.post),
          parentPost: cur.activeThread.parentPost ? patchPostAuthor(cur.activeThread.parentPost) : null,
          ancestors: patchPosts(cur.activeThread.ancestors),
          replies: patchPosts(cur.activeThread.replies),
        }
      : null,
    explore: {
      ...cur.explore,
      posts: patchPosts(cur.explore.posts),
      accounts: cur.explore.accounts.map((a) =>
        a.handle.toLowerCase() === lower ? { ...a, viewerFollows: nextFollowing } : a,
      ),
      actors: cur.explore.actors.map((a) =>
        a.username.toLowerCase() === lower ? { ...a, viewerFollows: nextFollowing } : a,
      ),
    },
    followListItems: cur.followListItems.map((item) =>
      item.handle.toLowerCase() === lower ? { ...item, viewerFollows: nextFollowing } : item,
    ),
    leaderboard: cur.leaderboard.map((row) =>
      row.handle.toLowerCase() === lower ? { ...row, isFollowing: nextFollowing } : row,
    ),
    feedPosts: patchPosts(cur.feedPosts),
  });
}

export async function toggleFollow(handle: string, currentlyFollowing?: boolean): Promise<void> {
  const s = getStoreSnapshot();
  const lower = handle.toLowerCase();
  const inferred = currentlyFollowing
    ?? (s.profileBundle?.summary.handle.toLowerCase() === lower ? s.profileBundle.summary.isFollowing : undefined)
    ?? s.followListItems.find((item) => item.handle.toLowerCase() === lower)?.viewerFollows
    ?? s.leaderboard.find((row) => row.handle.toLowerCase() === lower)?.isFollowing
    ?? s.explore.accounts.find((a) => a.handle.toLowerCase() === lower)?.viewerFollows
    ?? s.explore.actors.find((a) => a.username.toLowerCase() === lower)?.viewerFollows
    ?? s.feedPosts.find((p) => p.card.authorHandle.toLowerCase() === lower)?.card.isFollowingAuthor
    ?? false;
  if (!requireAuthOrQueue({ kind: "follow", handle, currentlyFollowing: inferred, label: `follow @${handle}` })) return;
  if (followInFlight.has(lower)) return;
  followInFlight.add(lower);
  const nextFollowing = !inferred;
  const optimisticBundleHandle = s.profileBundle?.summary.handle.toLowerCase() ?? null;
  patchFollowAcrossStore(handle, nextFollowing, optimisticBundleHandle);
  try {
    const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/follow`, {
      method: inferred ? "DELETE" : "POST",
      parse: passThrough,
    });
    if (!res.ok) {
      patchFollowAcrossStore(handle, inferred, optimisticBundleHandle);
      setErrorNotice(res.message);
      return;
    }
    const cur = getStoreSnapshot();
    const curBundleHandle = cur.profileBundle?.summary.handle.toLowerCase() ?? null;
    const targetStateStale = curBundleHandle === lower
      && cur.profileBundle?.summary.isFollowing !== nextFollowing;
    if (cur.route === "Profile" && curBundleHandle !== null && (curBundleHandle !== optimisticBundleHandle || targetStateStale)) {
      void loadProfile(cur.profileBundle?.summary.handle);
    }
    setStatusNotice(nextFollowing ? `Following @${handle}.` : `Unfollowed @${handle}.`);
  } finally {
    followInFlight.delete(lower);
  }
}

async function toggleModeration(
  kind: "block" | "mute",
  handle: string,
  currentActive?: boolean,
): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const lower = handle.toLowerCase();
  const isBlock = kind === "block";
  const active = currentActive
    ?? (s.profileBundle?.summary.handle.toLowerCase() === lower
      ? (isBlock ? s.profileBundle.summary.isBlocked : s.profileBundle.summary.isMuted)
      : undefined)
    ?? (isBlock ? s.blockedAccounts : s.mutedAccounts).some((acc) => acc.handle.toLowerCase() === lower);
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/${kind}`, {
    method: active ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  if (!active) {
    authorHideSeq += 1;
    authorHiddenAtSeq.set(lower, authorHideSeq);
    filterAuthorOutOfFeeds(handle);
    if (getStoreSnapshot().feedTab === "following") {
      void loadFeed();
    }
  }
  const cur = getStoreSnapshot();
  if (cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower) {
    setStoreState({
      profileBundle: {
        ...cur.profileBundle,
        viewerFollowedBy: isBlock && !active ? false : cur.profileBundle.viewerFollowedBy,
        summary: isBlock
          ? {
              ...cur.profileBundle.summary,
              isBlocked: !active,
              isFollowing: active ? cur.profileBundle.summary.isFollowing : false,
              followersCount: !active && cur.profileBundle.summary.isFollowing
                ? Math.max(0, cur.profileBundle.summary.followersCount - 1)
                : cur.profileBundle.summary.followersCount,
              followingCount: !active && cur.profileBundle.viewerFollowedBy
                ? Math.max(0, cur.profileBundle.summary.followingCount - 1)
                : cur.profileBundle.summary.followingCount,
            }
          : { ...cur.profileBundle.summary, isMuted: !active },
      },
    });
  }
  if (active) {
    setStoreState(
      isBlock
        ? { blockedAccounts: getStoreSnapshot().blockedAccounts.filter((a) => a.handle.toLowerCase() !== lower) }
        : { mutedAccounts: getStoreSnapshot().mutedAccounts.filter((a) => a.handle.toLowerCase() !== lower) },
    );
  } else if (cur.route === "Settings") {
    void loadModerationLists();
  }
  if (active) {
    const after = getStoreSnapshot();
    const stillHidden = after.mutedAccounts.some((a) => a.handle.toLowerCase() === lower)
      || after.blockedAccounts.some((a) => a.handle.toLowerCase() === lower)
      || (after.profileBundle?.summary.handle.toLowerCase() === lower
        && (after.profileBundle.summary.isMuted || after.profileBundle.summary.isBlocked));
    if (!stillHidden) authorHiddenAtSeq.delete(lower);
  }
  const verb = isBlock ? (active ? "Unblocked" : "Blocked") : (active ? "Unmuted" : "Muted");
  setStatusNotice(`${verb} @${handle}.`);
  if (active) {
    await loadFeed();
    const latest = getStoreSnapshot();
    const viewingProfile = latest.route === "Profile"
      && (latest.profileHandle?.toLowerCase() === lower
        || latest.profileBundle?.summary.handle.toLowerCase() === lower);
    if (viewingProfile) {
      await loadProfile(handle);
      if (getStoreSnapshot().profileBundle?.summary.handle.toLowerCase() === lower) {
        await loadProfileReplies(handle);
      }
    }
  }
}

export function toggleBlock(handle: string, currentBlocked?: boolean): Promise<void> {
  return toggleModeration("block", handle, currentBlocked);
}

export function toggleMute(handle: string, currentMuted?: boolean): Promise<void> {
  return toggleModeration("mute", handle, currentMuted);
}

export async function submitReport(targetKind: "account" | "post", targetId: string, reason: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson("/api/reports", {
    method: "POST",
    body: { targetKind, targetId, reason },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return false;
  }
  setStatusNotice("Report submitted.");
  return true;
}
