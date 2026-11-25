// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import type { LeaderboardMetric, LeaderboardScope, MarketTimeRange, PerpRebalanceOrderInput } from "@repo/ui";
import { passThrough, requestJson } from "./api.ts";
import {
  appendAnonymousModeParam,
  clearNotices,
  getStoreSnapshot,
  pushBrowserRoute,
  recordPublicView,
  requireAuthOrQueue,
  sendApp,
  sendNav,
  setErrorNotice,
  setStatusNotice,
  setStoreState,
  toSpecTab,
  type ThreadReplySort,
  type UiFeedTab,
} from "./store-core.ts";
import {
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
  decodeWorldStatus,
  isRecord,
  arr,
  optStr,
  str,
} from "./types.ts";

const likeInFlight = new Set<string>();
const repostInFlight = new Set<string>();
const followInFlight = new Set<string>();

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
    ?? s.explore.posts.find((p) => p.card.id === postId);
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
  setStoreState({
    feedPosts: cleanList(cur.feedPosts),
    explore: { ...cur.explore, posts: cleanList(cur.explore.posts) },
    profileBundle: cur.profileBundle
      ? { ...cur.profileBundle, posts: cleanList(cur.profileBundle.posts) }
      : null,
    profileReplies: cleanList(cur.profileReplies),
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
  const keep = (p: AppPost) => p.card.authorHandle.toLowerCase() !== normalized;
  const cur = getStoreSnapshot();
  setStoreState({
    feedPosts: cur.feedPosts.filter(keep),
    explore: { ...cur.explore, posts: cur.explore.posts.filter(keep) },
    activeThread: cur.activeThread
      ? {
          ...cur.activeThread,
          replies: cur.activeThread.replies.filter(keep),
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
  setStoreState({ feedLoading: true });
  const url = appendAnonymousModeParam(`/api/feed?tab=${encodeURIComponent(tab)}`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (res.ok) {
    setStoreState({
      feedPosts: res.data.items,
      feedNextCursor: res.data.nextCursor,
      feedLoading: false,
      pendingNewPostCount: 0,
    });
    return;
  }
  setStoreState({ feedLoading: false });
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
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ feedLoadingMore: true });
  const url = appendAnonymousModeParam(
    `/api/feed?tab=${encodeURIComponent(s.feedTab)}&cursor=${encodeURIComponent(s.feedNextCursor)}`,
    s,
  );
  const res = await requestJson(url, { parse: (raw) => decodeFeedPage(raw, viewerId) });
  if (res.ok) {
    const latest = getStoreSnapshot();
    setStoreState({
      feedPosts: appendUniquePosts(latest.feedPosts, res.data.items),
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
  setStoreState({
    trendingLoading: false,
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

export async function openThread(postId: string, sortOverride?: ThreadReplySort): Promise<void> {
  const s = getStoreSnapshot();
  const sort = sortOverride ?? s.threadSort;
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ threadLoading: true, activePostId: postId, threadSort: sort });
  recordPublicView("PostDetail");
  const baseUrl = `/api/posts/${encodeURIComponent(postId)}?sort=${encodeURIComponent(sort)}`;
  const res = await requestJson(appendAnonymousModeParam(baseUrl, s), {
    parse: (raw) => decodePostThread(raw, viewerId),
  });
  if (res.ok && res.data) {
    setStoreState({ activeThread: res.data, threadLoading: false });
    return;
  }
  setStoreState({ threadLoading: false });
  setErrorNotice(res.ok ? "Post not found" : res.message);
}

export function closeThread(): void {
  setStoreState({ activeThread: null, activePostId: null });
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
    setStoreState({
      feedPosts: [res.data, ...cur.feedPosts.filter((p) => p.card.id !== res.data?.card.id)],
      ...(matchesActiveMarket
        ? { marketSocialPosts: [res.data, ...cur.marketSocialPosts.filter((p) => p.card.id !== res.data?.card.id)] }
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
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        liked: currentlyLiked,
        likeCount: prevCount,
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
      likeCount: serverCount,
    }));
  } finally {
    likeInFlight.delete(postId);
  }
}

export async function repostPost(postId: string): Promise<void> {
  const existing = findPostInState(postId);
  const currentlyReposted = existing?.card.reposted ?? false;
  if (!requireAuthOrQueue({ kind: "repost", postId, label: currentlyReposted ? "remove repost" : "repost this post" })) return;
  if (repostInFlight.has(postId)) return;
  repostInFlight.add(postId);
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
      patchPostCardAcrossStore(postId, (card) => ({
        ...card,
        reposted: currentlyReposted,
        repostCount: prevCount,
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
      repostCount: serverCount,
    }));
  } finally {
    repostInFlight.delete(postId);
  }
}

export async function loadExplore(queryOverride?: string): Promise<void> {
  const s = getStoreSnapshot();
  const q = queryOverride ?? s.exploreQuery;
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ exploreLoading: true, exploreQuery: q });
  const url = appendAnonymousModeParam(`/api/explore?q=${encodeURIComponent(q.trim())}`, s);
  const needMarkets = s.perps.length === 0;
  const [res, mktRes] = await Promise.all([
    requestJson(url, {
      parse: (raw) => decodeExplore(raw, viewerId),
    }),
    needMarkets ? requestJson("/api/markets", { parse: passThrough }) : Promise.resolve(null),
  ]);
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
    setStoreState({ explore: res.data, exploreLoading: false, trendingLoading: false, ...marketPatch });
    return;
  }
  setStoreState({ exploreLoading: false, trendingLoading: false, ...marketPatch });
  setErrorNotice(res.message);
}

export async function loadTrendingTag(tag: string): Promise<void> {
  const cleanTag = tag.trim();
  setStoreState({ activeTrendingTag: cleanTag, exploreQuery: cleanTag });
  await loadExplore(cleanTag);
}

export async function searchAccounts(query: string): Promise<{
  readonly accounts: ReadonlyArray<ExploreAccountHit>;
  readonly actors: ReadonlyArray<ExploreActorHit>;
}> {
  const trimmed = query.trim();
  if (!trimmed) return { accounts: [], actors: [] };
  const s = getStoreSnapshot();
  const res = await requestJson(
    appendAnonymousModeParam(`/api/explore?q=${encodeURIComponent(trimmed)}`, s),
    { parse: (raw) => decodeExplore(raw, s.viewer?.accountId ?? null) },
  );
  if (!res.ok) return { accounts: [], actors: [] };
  return { accounts: res.data.accounts, actors: res.data.actors };
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

export async function loadLeaderboard(options?: {
  readonly scope?: LeaderboardScope;
  readonly metric?: LeaderboardMetric;
  readonly page?: number;
  readonly pageSize?: number;
}): Promise<void> {
  const s = getStoreSnapshot();
  const scope = options?.scope ?? s.leaderboardScope;
  const metric = options?.metric ?? s.leaderboardMetric;
  const page = Math.max(1, options?.page ?? s.leaderboardPage);
  const pageSize = options?.pageSize ?? 25;
  setStoreState({
    leaderboardLoading: true,
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
  const res = await requestJson(`/api/leaderboard?${params.toString()}`, {
    parse: (raw) => decodeLeaderboardPage(raw, scope, metric),
  });
  if (res.ok) {
    setStoreState({
      leaderboard: res.data.entries,
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
  setStoreState({ leaderboardLoading: false });
  setErrorNotice(res.message);
}

export async function jumpToMyLeaderboardRank(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const params = new URLSearchParams({
    metric: s.leaderboardMetric,
    pageSize: "25",
  });
  const res = await requestJson(`/api/leaderboard/me?${params.toString()}`, {
    parse: decodeLeaderboardPosition,
  });
  if (res.ok && res.data) {
    setStoreState({ leaderboardCurrentUser: res.data.entry });
    await loadLeaderboard({
      scope: "players",
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
  setStoreState({ economyLoading: true });
  const res = await requestJson("/api/economy/me", { parse: decodeEconomy });
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
  setStoreState({ pnlHistoryLoading: true, pnlTimeRange: range });
  const res = await requestJson(`/api/economy/me/pnl-history?range=${encodeURIComponent(range)}`, {
    parse: decodePnlHistory,
  });
  if (res.ok) {
    setStoreState({ pnlHistory: res.data, pnlHistoryLoading: false });
    return;
  }
  setStoreState({ pnlHistoryLoading: false });
}

export async function loadClosedPositions(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  setStoreState({ closedPositionsLoading: true });
  const res = await requestJson("/api/markets/positions/closed?limit=50", {
    parse: decodeClosedPositions,
  });
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

export async function previewPerpOrder(
  ticker: string,
  side: "long" | "short",
  marginPts: number,
  leverage: number,
): Promise<void> {
  if (!Number.isFinite(marginPts) || marginPts <= 0 || !Number.isFinite(leverage) || leverage < 1) {
    setStoreState({ perpPreview: null });
    return;
  }
  const collateralCents = Math.max(1, Math.round(marginPts * 100));
  const res = await requestJson("/api/markets/perp/preview", {
    method: "POST",
    body: { ticker, side, collateralCents, collateralPts: marginPts, leverage: Math.round(leverage) },
    parse: decodePerpPreview,
  });
  const latest = getStoreSnapshot();
  if (latest.selectedMarketKind !== "perp" || latest.selectedMarketId?.toUpperCase() !== ticker.toUpperCase()) return;
  setStoreState({ perpPreview: res.ok ? res.data : null });
}

export async function loadMarkets(): Promise<void> {
  setStoreState({ marketsLoading: true });
  const sBefore = getStoreSnapshot();
  const lbParams = new URLSearchParams({
    scope: sBefore.leaderboardScope,
    metric: sBefore.leaderboardMetric,
    page: String(sBefore.leaderboardPage),
    pageSize: "25",
  });
  const [mktRes, lbRes] = await Promise.all([
    requestJson("/api/markets", { parse: passThrough }),
    requestJson(`/api/leaderboard?${lbParams.toString()}`, {
      parse: (raw) => decodeLeaderboardPage(raw, sBefore.leaderboardScope, sBefore.leaderboardMetric),
    }),
  ]);
  if (sBefore.viewer) {
    void loadEconomy();
    void loadClosedPositions();
    void loadPnlHistory();
  }
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
  if (!selectedMarketId) {
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
    ...(lbRes.ok
      ? {
          leaderboard: lbRes.data.entries,
          leaderboardTotalCount: lbRes.data.totalCount,
          leaderboardTotalPages: lbRes.data.totalPages,
          leaderboardCurrentUser: lbRes.data.currentUser,
        }
      : {}),
  });
  if (marketsViewMode === "terminal" && selectedMarketId) {
    void loadMarketDetails(selectedMarketKind, selectedMarketId);
    if (selectedMarketKind === "perp") {
      void previewPerpOrder(selectedMarketId, "long", 10, 5);
    }
  }
}

export function selectMarket(kind: "prediction" | "perp", id: string): void {
  recordPublicView("Markets");
  setStoreState({
    selectedMarketKind: kind,
    selectedMarketId: id,
    selectedTicker: kind === "perp" ? id : null,
    marketsViewMode: "terminal",
    perpPreview: null,
    tradeError: null,
  });
  if (typeof window !== "undefined") {
    const targetPath = kind === "perp"
      ? `/markets/perps/${encodeURIComponent(id)}`
      : `/markets/predictions/${encodeURIComponent(id)}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState(null, "", targetPath);
    }
    if (typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
  }
  void loadMarketDetails(kind, id);
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
  return executeTradeRequest({
    endpoint,
    body,
    headers: { "Idempotency-Key": newIdempotencyKey() },
    statusMessage: `${action} ${side.toUpperCase()} executed.`,
  });
}

export async function submitPerpOrder(
  ticker: string,
  side: "long" | "short",
  marginPts: number,
  leverage: number,
): Promise<boolean> {
  if (!requireAuthOrQueue({ kind: "trade_perp", ticker, side, marginPts, leverage, label: `open $${ticker} ${side} perp` })) {
    return false;
  }
  return executeTradeRequest({
    endpoint: `/api/markets/perp/${encodeURIComponent(ticker)}/open`,
    body: { side, collateralCents: Math.max(1, Math.round(marginPts * 100)), collateralPts: marginPts, leverage },
    statusMessage: `Opened $${ticker} ${side} ${leverage}x position.`,
    formatReceiptMessage: (data) => {
      const action = isRecord(data) ? str(data.action, "open") : "open";
      if (action === "add") return `Added to $${ticker} ${side} position.`;
      if (action === "flip") return `Flipped $${ticker} position to ${side} ${leverage}x.`;
      if (action === "reduce") return `Reduced $${ticker} position.`;
      return `Opened $${ticker} ${side} ${leverage}x position.`;
    },
  });
}

export async function closePerpPosition(
  positionId: string,
  options?: { readonly sizeCents?: number; readonly closePct?: number },
): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const body: Record<string, number> = {};
  if (options?.sizeCents !== undefined && options.sizeCents > 0) {
    body.sizeCents = Math.max(1, Math.round(options.sizeCents));
  }
  if (options?.closePct !== undefined && options.closePct > 0 && options.closePct <= 100) {
    body.closePct = options.closePct;
  }
  await executeTradeRequest({
    endpoint: `/api/markets/perp/positions/${encodeURIComponent(positionId)}/close`,
    body,
    statusMessage: "Position closed.",
    formatReceiptMessage: (data) => {
      const isFull = isRecord(data) && typeof data.isFullClose === "boolean" ? data.isFullClose : true;
      return isFull ? "Position closed." : "Position partially closed.";
    },
  });
}

export async function rebalancePerpPosition(order: PerpRebalanceOrderInput): Promise<void> {
  if (order.action === "reduce") {
    await closePerpPosition(order.positionId, {
      sizeCents: Math.max(1, Math.round(order.deltaNotionalPts * 100)),
    });
    return;
  }
  await submitPerpOrder(order.ticker, order.nextSide, order.marginPts, order.leverage);
}

export async function markChatRead(chatId: string): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const cur = getStoreSnapshot();
  const target = cur.chats.find((c) => c.id === chatId);
  if (target && target.unreadCount > 0) {
    setStoreState({
      chats: cur.chats.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)),
    });
  }
  await requestJson(`/api/chats/${encodeURIComponent(chatId)}/read`, {
    method: "POST",
    body: {},
    parse: passThrough,
  });
}

export async function loadChats(loadMessages = true): Promise<void> {
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  if (!viewerId) return;
  if (loadMessages) setStoreState({ chatsLoading: true });
  const [chatsRes, invitesRes] = await Promise.all([
    requestJson("/api/chats", { parse: (raw) => decodeChats(raw, viewerId) }),
    requestJson("/api/chats/invites", { parse: decodeAlphaInvites }),
  ]);
  const s = getStoreSnapshot();
  const nextChats = chatsRes.ok ? chatsRes.data : s.chats;
  const selectedId = s.selectedChatId && nextChats.some((c) => c.id === s.selectedChatId)
    ? s.selectedChatId
    : (nextChats[0]?.id ?? null);
  setStoreState({
    chatsLoading: false,
    chats: nextChats,
    selectedChatId: selectedId,
    alphaInvites: invitesRes.ok ? invitesRes.data : s.alphaInvites,
  });
  if (loadMessages && selectedId) {
    await loadChatMessages(selectedId);
  }
}

export async function loadChatMessages(chatId: string): Promise<void> {
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  if (!viewerId) return;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    parse: (raw) => decodeChatMessages(raw, viewerId),
  });
  if (res.ok) {
    setStoreState({ selectedChatId: chatId, chatMessages: res.data });
    const chat = getStoreSnapshot().chats.find((c) => c.id === chatId);
    if (chat && chat.unreadCount > 0) {
      void markChatRead(chatId);
    }
  }
}

export async function startDirectChat(targetHandleOrId: string): Promise<void> {
  if (!requireAuthOrQueue({ kind: "dm", handle: targetHandleOrId, label: `message @${targetHandleOrId}` })) return;
  const viewerId = getStoreSnapshot().viewer?.accountId ?? "";
  const res = await requestJson("/api/chats/direct", {
    method: "POST",
    body: { targetHandleOrId, recipientHandleOrId: targetHandleOrId },
    parse: (raw) => decodeChats([isRecord(raw) && raw.chat ? raw.chat : raw], viewerId),
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  const createdId = res.data[0]?.id ?? null;
  if (getStoreSnapshot().route !== "Chats") {
    pushBrowserRoute("Chats");
    sendNav({ type: "navigateTo", targetRoute: "Chats" });
    sendApp({ type: "navigateApp", targetRoute: "Chats" });
    setStoreState({ route: "Chats" });
  }
  await loadChats();
  if (createdId) {
    await loadChatMessages(createdId);
  }
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
  await loadChats();
  if (chatId) await loadChatMessages(chatId);
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

export function deleteGroupChat(chatId: string): Promise<boolean> {
  return mutateAndClearGroupChat(
    `/api/chats/${encodeURIComponent(chatId)}`,
    "DELETE",
    chatId,
    "Group chat deleted.",
  );
}

export async function sendChatMessage(chatId: string, content: string): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  setStoreState({ chatSending: true });
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: { content },
    parse: passThrough,
  });
  setStoreState({ chatSending: false });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  await loadChatMessages(chatId);
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

export async function loadNotifications(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  setStoreState({ notificationsLoading: true });
  const res = await requestJson("/api/notifications", { parse: decodeNotifications });
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
  if (res.ok && isRecord(res.data) && typeof res.data.unreadCount === "number") {
    setStoreState({ unreadNotifications: res.data.unreadCount });
  }
}

export async function markAllNotificationsRead(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson("/api/notifications/read", {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  setStoreState({
    notifications: getStoreSnapshot().notifications.map((n) => ({ ...n, item: { ...n.item, read: true } })),
    unreadNotifications: 0,
  });
}

export async function clearNotifications(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson("/api/notifications", {
    method: "DELETE",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  setStoreState({
    notifications: [],
    unreadNotifications: 0,
  });
  setStatusNotice("Notifications cleared.");
}

export async function loadProfile(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  setStoreState({ profileLoading: true, profileHandle: handle, profileReplies: [] });
  const url = appendAnonymousModeParam(`/api/users/${encodeURIComponent(handle)}`, s);
  const res = await requestJson(url, {
    parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null),
  });
  if (res.ok && res.data) {
    setStoreState({ profileBundle: res.data, profileLoading: false });
    return;
  }
  setStoreState({ profileBundle: null, profileLoading: false });
  setErrorNotice(res.ok ? "Profile not found" : res.message);
}

export async function loadProfileReplies(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileBundle?.summary.handle ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ profileRepliesLoading: true });
  const url = appendAnonymousModeParam(
    `/api/posts?authorHandle=${encodeURIComponent(handle)}&filter=replies&limit=40`,
    s,
  );
  const res = await requestJson(url, {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (res.ok) {
    setStoreState({ profileReplies: res.data.items, profileRepliesLoading: false });
    return;
  }
  setStoreState({ profileRepliesLoading: false });
}

export async function loadMoreProfilePosts(): Promise<void> {
  const s = getStoreSnapshot();
  const bundle = s.profileBundle;
  if (!bundle || !bundle.postsNextCursor || s.profileLoading || s.profileLoadingMore) return;
  setStoreState({ profileLoadingMore: true });
  const url = appendAnonymousModeParam(
    `/api/users/${encodeURIComponent(bundle.summary.handle)}?cursor=${encodeURIComponent(bundle.postsNextCursor)}`,
    s,
  );
  const res = await requestJson(url, {
    parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null),
  });
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

export async function loadFollowList(handle: string, kind: "followers" | "following"): Promise<void> {
  setStoreState({
    followListHandle: handle,
    followListKind: kind,
    followListItems: [],
    followListLoading: true,
  });
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/${kind}`, {
    parse: decodeFollowList,
  });
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
  setStatusNotice("Profile updated.");
  if (s.route === "Profile" && s.profileBundle?.summary.isOwnProfile) {
    await loadProfile(s.viewer.handle);
  }
  return true;
}

function patchFollowAcrossStore(handle: string, nextFollowing: boolean): void {
  const lower = handle.toLowerCase();
  const cur = getStoreSnapshot();
  const profileMatches = cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower;
  const delta = nextFollowing ? 1 : -1;
  setStoreState({
    profileBundle: profileMatches && cur.profileBundle
      ? {
          ...cur.profileBundle,
          summary: {
            ...cur.profileBundle.summary,
            isFollowing: nextFollowing,
            followersCount: Math.max(0, cur.profileBundle.summary.followersCount + delta),
          },
        }
      : cur.profileBundle,
    followListItems: cur.followListItems.map((item) =>
      item.handle.toLowerCase() === lower ? { ...item, viewerFollows: nextFollowing } : item,
    ),
    leaderboard: cur.leaderboard.map((row) =>
      row.handle.toLowerCase() === lower ? { ...row, isFollowing: nextFollowing } : row,
    ),
    feedPosts: cur.feedPosts.map((p) =>
      p.card.authorHandle.toLowerCase() === lower ? { ...p, card: { ...p.card, isFollowingAuthor: nextFollowing } } : p,
    ),
  });
}

export async function toggleFollow(handle: string, currentlyFollowing?: boolean): Promise<void> {
  const s = getStoreSnapshot();
  const lower = handle.toLowerCase();
  const inferred = currentlyFollowing
    ?? (s.profileBundle?.summary.handle.toLowerCase() === lower ? s.profileBundle.summary.isFollowing : undefined)
    ?? s.followListItems.find((item) => item.handle.toLowerCase() === lower)?.viewerFollows
    ?? s.leaderboard.find((row) => row.handle.toLowerCase() === lower)?.isFollowing
    ?? false;
  if (!requireAuthOrQueue({ kind: "follow", handle, currentlyFollowing: inferred, label: `follow @${handle}` })) return;
  if (followInFlight.has(lower)) return;
  followInFlight.add(lower);
  const nextFollowing = !inferred;
  patchFollowAcrossStore(handle, nextFollowing);
  try {
    const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/follow`, {
      method: inferred ? "DELETE" : "POST",
      parse: passThrough,
    });
    if (!res.ok) {
      patchFollowAcrossStore(handle, inferred);
      setErrorNotice(res.message);
      return;
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
    filterAuthorOutOfFeeds(handle);
  }
  const cur = getStoreSnapshot();
  if (cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower) {
    setStoreState({
      profileBundle: {
        ...cur.profileBundle,
        summary: isBlock
          ? {
              ...cur.profileBundle.summary,
              isBlocked: !active,
              isFollowing: active ? cur.profileBundle.summary.isFollowing : false,
              followersCount: !active && cur.profileBundle.summary.isFollowing
                ? Math.max(0, cur.profileBundle.summary.followersCount - 1)
                : cur.profileBundle.summary.followersCount,
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
  const verb = isBlock ? (active ? "Unblocked" : "Blocked") : (active ? "Unmuted" : "Muted");
  setStatusNotice(`${verb} @${handle}.`);
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
