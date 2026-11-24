// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import type { LeaderboardAudienceFilter, LeaderboardTimeframe, MarketTimeRange } from "@repo/ui";
import { passThrough, requestJson } from "./api.ts";
import {
  appendAnonymousModeParam,
  clearNotices,
  getStoreSnapshot,
  hasAtRiskOpenPositions,
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
  type ClosedOutcomeFilter,
  type ExploreAccountHit,
  type ExploreActorHit,
  decodeAlphaInvites,
  decodeArticle,
  decodeArticles,
  decodeAssetTrades,
  decodeChatMessages,
  decodeChats,
  decodeClosedPositions,
  decodeEconomy,
  decodeExplore,
  decodeFeedPage,
  decodeFollowList,
  decodeLeaderboardPage,
  decodeLeaderboardViewerRank,
  decodeModerationList,
  decodeNotifications,
  decodePerpHistory,
  decodePerpMarket,
  decodePnlHistory,
  decodePositions,
  decodePost,
  decodePostThread,
  decodePredictionHistory,
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
    ?? s.marketSocialPosts.find((p) => p.card.id === postId)
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
    marketSocialPosts: patchList(cur.marketSocialPosts),
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

export function removePostAcrossStore(postId: string): void {
  const cur = getStoreSnapshot();
  const thread = cur.activeThread;
  setStoreState({
    feedPosts: cur.feedPosts.filter((p) => p.card.id !== postId),
    marketSocialPosts: cur.marketSocialPosts.filter((p) => p.card.id !== postId),
    explore: { ...cur.explore, posts: cur.explore.posts.filter((p) => p.card.id !== postId) },
    profileBundle: cur.profileBundle
      ? { ...cur.profileBundle, posts: cur.profileBundle.posts.filter((p) => p.card.id !== postId) }
      : null,
    activeThread: thread
      ? thread.post.card.id === postId
        ? null
        : {
            ...thread,
            ancestors: thread.ancestors.filter((p) => p.card.id !== postId),
            replies: thread.replies.filter((p) => p.card.id !== postId),
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
    marketSocialPosts: cur.marketSocialPosts.filter(keep),
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
  const [trendRes, articlesRes] = await Promise.all([
    requestJson(appendAnonymousModeParam("/api/trending", s), { parse: decodeTrendingList }),
    requestJson(appendAnonymousModeParam("/api/articles?limit=10", s), { parse: decodeArticles }),
  ]);
  const cur = getStoreSnapshot();
  setStoreState({
    explore: {
      ...cur.explore,
      ...(trendRes.ok ? { trending: trendRes.data } : {}),
      ...(articlesRes.ok && articlesRes.data.length > 0 ? { articles: articlesRes.data } : {}),
    },
  });
}

export async function selectFeedTab(tab: UiFeedTab): Promise<void> {
  const s = getStoreSnapshot();
  if ((tab === "following" || tab === "top") && s.viewer === null) {
    requireAuthOrQueue({ kind: "switch_tab", tab, label: `view the ${tab === "top" ? "For You" : "Following"} feed` });
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
  const wasActiveDetail = getStoreSnapshot().route === "PostDetail" && getStoreSnapshot().activePostId === postId;
  removePostAcrossStore(postId);
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
  const res = await requestJson(url, {
    parse: (raw) => decodeExplore(raw, viewerId),
  });
  if (res.ok) {
    setStoreState({ explore: res.data, exploreLoading: false });
    return;
  }
  setStoreState({ exploreLoading: false });
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

export async function loadWorldStatus(): Promise<void> {
  const res = await requestJson("/api/world/status", { parse: decodeWorldStatus });
  if (res.ok && res.data) {
    setStoreState({ worldStatus: res.data });
  }
}

export async function loadPerpHistory(ticker: string, rangeOverride?: MarketTimeRange): Promise<void> {
  const range = rangeOverride ?? getStoreSnapshot().marketTimeRange;
  setStoreState({ marketChartLoading: true, marketTimeRange: range });
  const res = await requestJson(
    `/api/markets/perp/${encodeURIComponent(ticker)}/history?range=${encodeURIComponent(range)}&limit=200`,
    { parse: decodePerpHistory },
  );
  if (res.ok) {
    const latest = getStoreSnapshot();
    if (latest.selectedMarketKind === "perp" && latest.selectedMarketId?.toUpperCase() === ticker.toUpperCase()) {
      setStoreState({ perpHistory: res.data, marketChartLoading: false });
      return;
    }
  }
  setStoreState({ marketChartLoading: false });
}

export async function loadPredictionHistory(marketId: string, rangeOverride?: MarketTimeRange): Promise<void> {
  const range = rangeOverride ?? getStoreSnapshot().marketTimeRange;
  setStoreState({ marketChartLoading: true, marketTimeRange: range });
  const res = await requestJson(
    `/api/markets/prediction/${encodeURIComponent(marketId)}/history?range=${encodeURIComponent(range)}&limit=200`,
    { parse: decodePredictionHistory },
  );
  if (res.ok) {
    const latest = getStoreSnapshot();
    if (latest.selectedMarketKind === "prediction" && latest.selectedMarketId === marketId) {
      setStoreState({ predictionHistory: res.data, marketChartLoading: false });
      return;
    }
  }
  setStoreState({ marketChartLoading: false });
}

export async function loadMarketTrades(kind: "perp" | "prediction", ref: string): Promise<void> {
  setStoreState({ marketTradesLoading: true });
  const endpoint = kind === "perp"
    ? `/api/markets/perp/${encodeURIComponent(ref)}/trades?limit=50`
    : `/api/markets/prediction/${encodeURIComponent(ref)}/trades?limit=50`;
  const res = await requestJson(endpoint, { parse: decodeAssetTrades });
  if (res.ok) {
    const latest = getStoreSnapshot();
    const matches = kind === "perp"
      ? latest.selectedMarketKind === "perp" && latest.selectedMarketId?.toUpperCase() === ref.toUpperCase()
      : latest.selectedMarketKind === "prediction" && latest.selectedMarketId === ref;
    if (matches) {
      setStoreState({ marketTrades: res.data, marketTradesLoading: false });
      return;
    }
  }
  setStoreState({ marketTradesLoading: false });
}

export async function loadMarketSocialFeed(kind: "perp" | "prediction", ref: string): Promise<void> {
  const s = getStoreSnapshot();
  const viewerId = s.viewer?.accountId ?? null;
  setStoreState({ marketSocialLoading: true });
  const baseUrl = kind === "perp"
    ? `/api/feed?ticker=${encodeURIComponent(ref)}&limit=30`
    : `/api/feed?marketId=${encodeURIComponent(ref)}&limit=30`;
  const res = await requestJson(appendAnonymousModeParam(baseUrl, s), {
    parse: (raw) => decodeFeedPage(raw, viewerId),
  });
  if (res.ok) {
    const latest = getStoreSnapshot();
    const matches = kind === "perp"
      ? latest.selectedMarketKind === "perp" && latest.selectedMarketId?.toUpperCase() === ref.toUpperCase()
      : latest.selectedMarketKind === "prediction" && latest.selectedMarketId === ref;
    if (matches) {
      setStoreState({ marketSocialPosts: res.data.items, marketSocialLoading: false });
      return;
    }
  }
  setStoreState({ marketSocialLoading: false });
}

export async function loadActiveMarketTerminalData(
  kind: "perp" | "prediction",
  ref: string,
  rangeOverride?: MarketTimeRange,
): Promise<void> {
  const historyTask = kind === "perp"
    ? loadPerpHistory(ref, rangeOverride)
    : loadPredictionHistory(ref, rangeOverride);
  await Promise.all([
    historyTask,
    loadMarketTrades(kind, ref),
    loadMarketSocialFeed(kind, ref),
  ]);
}

export async function setMarketTimeRange(range: MarketTimeRange): Promise<void> {
  const s = getStoreSnapshot();
  setStoreState({ marketTimeRange: range });
  if (!s.selectedMarketId) return;
  if (s.selectedMarketKind === "perp") {
    await loadPerpHistory(s.selectedMarketId, range);
  } else {
    await loadPredictionHistory(s.selectedMarketId, range);
  }
}

export async function loadClosedPositions(
  outcomeOverride?: ClosedOutcomeFilter,
  pageOverride?: number,
  limit = 50,
): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const outcome = outcomeOverride ?? s.closedPositionsOutcome;
  const page = pageOverride ?? s.closedPositionsPage;
  setStoreState({ closedPositionsLoading: true, closedPositionsOutcome: outcome, closedPositionsPage: page });
  const res = await requestJson(
    `/api/markets/positions/closed?outcome=${encodeURIComponent(outcome)}&page=${page}&limit=${limit}`,
    { parse: decodeClosedPositions },
  );
  if (res.ok) {
    setStoreState({
      closedPositions: res.data.items,
      closedPositionsPage: res.data.page,
      closedPositionsTotalPages: res.data.totalPages,
      closedPositionsLoading: false,
    });
    return;
  }
  setStoreState({ closedPositionsLoading: false });
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

export async function loadLeaderboardFiltered(
  filterOverride?: LeaderboardAudienceFilter,
  timeframeOverride?: LeaderboardTimeframe,
  pageOverride?: number,
): Promise<void> {
  const s = getStoreSnapshot();
  const filter = filterOverride ?? s.leaderboardFilter;
  const timeframe = timeframeOverride ?? s.leaderboardTimeframe;
  const page = Math.max(1, pageOverride ?? s.leaderboardPage);
  const apiTimeframe = timeframe.toLowerCase();
  setStoreState({
    leaderboardLoading: true,
    leaderboardFilter: filter,
    leaderboardTimeframe: timeframe,
    leaderboardPage: page,
  });
  const listReq = requestJson(
    `/api/leaderboard?filter=${encodeURIComponent(filter)}&timeframe=${encodeURIComponent(apiTimeframe)}&page=${page}&pageSize=50`,
    { parse: decodeLeaderboardPage },
  );
  const meReq = s.viewer
    ? requestJson(
        `/api/leaderboard/me?filter=${encodeURIComponent(filter)}&timeframe=${encodeURIComponent(apiTimeframe)}&pageSize=50`,
        { parse: decodeLeaderboardViewerRank },
      )
    : Promise.resolve(null);
  const [listRes, meRes] = await Promise.all([listReq, meReq]);
  if (listRes.ok) {
    setStoreState({
      leaderboard: listRes.data.entries,
      leaderboardPage: listRes.data.page,
      leaderboardTotalPages: listRes.data.totalPages,
      leaderboardViewerRank: meRes && meRes.ok ? meRes.data : (s.viewer ? getStoreSnapshot().leaderboardViewerRank : null),
      leaderboardLoading: false,
    });
    return;
  }
  setStoreState({ leaderboardLoading: false });
  setErrorNotice(listRes.message);
}

export async function loadLeaderboard(): Promise<void> {
  await loadLeaderboardFiltered();
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

export async function loadMarkets(): Promise<void> {
  setStoreState({ marketsLoading: true });
  const sBefore = getStoreSnapshot();
  const mktRes = await requestJson("/api/markets", { parse: passThrough });
  if (sBefore.viewer) {
    void loadEconomy();
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
  if (s.selectedTicker) {
    const matchedPerp = perps.find((p) => p.ticker.toUpperCase() === s.selectedTicker?.toUpperCase());
    selectedMarketKind = "perp";
    selectedMarketId = matchedPerp ? matchedPerp.ticker : s.selectedTicker.toUpperCase();
  }
  setStoreState({
    marketsLoading: false,
    predictions,
    perps,
    positions,
    selectedMarketKind,
    selectedMarketId,
  });
}

export function selectMarket(kind: "prediction" | "perp", id: string): void {
  recordPublicView("Markets");
  setStoreState({
    selectedMarketKind: kind,
    selectedMarketId: id,
    selectedTicker: kind === "perp" ? id : null,
    perpHistory: [],
    predictionHistory: [],
    marketTrades: [],
    marketSocialPosts: [],
    tradeError: null,
  });
  void loadActiveMarketTerminalData(kind, id);
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function refreshAfterTrade(): Promise<void> {
  const s = getStoreSnapshot();
  const tasks: Promise<void>[] = [loadMarkets()];
  if (s.viewer) {
    tasks.push(loadEconomy(), loadPnlHistory(), loadClosedPositions());
  }
  if (s.selectedMarketId) {
    if (s.selectedMarketKind === "perp") {
      tasks.push(loadPerpHistory(s.selectedMarketId), loadMarketTrades("perp", s.selectedMarketId));
    } else {
      tasks.push(loadPredictionHistory(s.selectedMarketId), loadMarketTrades("prediction", s.selectedMarketId));
    }
  }
  await Promise.all(tasks);
}

async function executeTradeRequest({
  endpoint,
  body,
  headers,
  statusMessage,
}: {
  readonly endpoint: string;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly statusMessage: string;
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
  setStatusNotice(statusMessage);
  await refreshAfterTrade();
  return true;
}

export async function submitPredictionOrder(
  marketId: string,
  action: "Buy" | "Sell",
  side: "yes" | "no",
  amountPts: number,
): Promise<boolean> {
  if (getStoreSnapshot().tradeLoading) return false;
  if (!requireAuthOrQueue({ kind: "trade_prediction", marketId, action, side, amountPts, label: `${action} ${side.toUpperCase()} prediction` })) {
    return false;
  }
  const endpoint = action === "Buy"
    ? `/api/markets/prediction/${encodeURIComponent(marketId)}/buy`
    : `/api/markets/prediction/${encodeURIComponent(marketId)}/sell`;
  const body = action === "Buy"
    ? { side, amountCents: Math.max(1, Math.round(amountPts * 100)), amountPts }
    : { side, shares: Math.max(1, Math.round(amountPts)) };
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
  if (getStoreSnapshot().tradeLoading) return false;
  if (!requireAuthOrQueue({ kind: "trade_perp", ticker, side, marginPts, leverage, label: `open $${ticker} ${side} perp` })) {
    return false;
  }
  return executeTradeRequest({
    endpoint: `/api/markets/perp/${encodeURIComponent(ticker)}/open`,
    body: { side, collateralCents: Math.max(1, Math.round(marginPts * 100)), collateralPts: marginPts, leverage },
    statusMessage: `Opened $${ticker} ${side} ${leverage}x position.`,
  });
}

export async function closePerpPosition(positionId: string): Promise<void> {
  if (!getStoreSnapshot().viewer || getStoreSnapshot().tradeLoading) return;
  await executeTradeRequest({
    endpoint: `/api/markets/perp/positions/${encodeURIComponent(positionId)}/close`,
    body: {},
    statusMessage: "Position closed.",
  });
}

export async function rebalancePerpPosition(input: {
  readonly positionId?: string;
  readonly ticker: string;
  readonly action: "add" | "reduce" | "close" | "flip";
  readonly side: "long" | "short";
  readonly marginPts: number;
  readonly resultingNotionalPts?: number;
  readonly leverage: number;
}): Promise<boolean> {
  const s = getStoreSnapshot();
  if (s.tradeLoading) return false;
  if (
    !requireAuthOrQueue({
      kind: "trade_perp",
      ticker: input.ticker,
      side: input.side,
      marginPts: input.marginPts,
      leverage: input.leverage,
      label: `${input.action} $${input.ticker} perp`,
    })
  ) {
    return false;
  }
  const existing = s.positions.find(
    (p) =>
      !p.isClosed &&
      p.row.kind === "perp" &&
      ((input.positionId && p.row.id === input.positionId) ||
        p.marketId.toUpperCase() === input.ticker.toUpperCase()),
  );
  if (!existing) {
    if (input.action === "close" || input.action === "reduce") {
      setErrorNotice(`No open $${input.ticker} position to ${input.action}.`);
      return false;
    }
    return submitPerpOrder(input.ticker, input.side, input.marginPts, input.leverage);
  }
  setStoreState({ tradeLoading: true, tradeError: null });
  const closeRes = await requestJson(`/api/markets/perp/positions/${encodeURIComponent(existing.row.id)}/close`, {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  if (!closeRes.ok) {
    setStoreState({ tradeLoading: false, tradeError: closeRes.message });
    setErrorNotice(closeRes.message);
    return false;
  }
  const curViewer = getStoreSnapshot().viewer;
  const balAfterClose = isRecord(closeRes.data) && typeof closeRes.data.balanceAfterCents === "number"
    ? closeRes.data.balanceAfterCents
    : curViewer?.balanceCents;
  if (curViewer && balAfterClose !== undefined) {
    setStoreState({ viewer: { ...curViewer, balanceCents: balAfterClose } });
  }
  const targetLeverage = Math.max(1, Math.min(20, Math.round(input.leverage)));
  const targetNotionalPts = input.action === "close"
    ? 0
    : input.resultingNotionalPts !== undefined
      ? Math.max(0, input.resultingNotionalPts)
      : input.action === "add"
        ? (existing.sizeCents / 100) + input.marginPts * targetLeverage
        : input.action === "reduce"
          ? Math.max(0, (existing.sizeCents / 100) - input.marginPts * targetLeverage)
          : input.marginPts * targetLeverage;
  if (input.action === "close" || targetNotionalPts <= 0) {
    setStoreState({ tradeLoading: false });
    setStatusNotice(`Closed $${input.ticker} position.`);
    await refreshAfterTrade();
    return true;
  }
  const nextMarginPts = input.action === "flip"
    ? Math.max(0.01, input.marginPts)
    : Math.max(0.01, targetNotionalPts / targetLeverage);
  const openRes = await requestJson(`/api/markets/perp/${encodeURIComponent(input.ticker)}/open`, {
    method: "POST",
    body: {
      side: input.side,
      collateralCents: Math.max(1, Math.round(nextMarginPts * 100)),
      collateralPts: nextMarginPts,
      leverage: targetLeverage,
    },
    parse: passThrough,
  });
  if (!openRes.ok) {
    setStoreState({ tradeLoading: false, tradeError: openRes.message });
    setErrorNotice(`Closed prior $${input.ticker} position, reopen failed: ${openRes.message}`);
    await refreshAfterTrade();
    return false;
  }
  const latestViewer = getStoreSnapshot().viewer;
  const balAfterOpen = isRecord(openRes.data) && typeof openRes.data.balanceAfterCents === "number"
    ? openRes.data.balanceAfterCents
    : latestViewer?.balanceCents;
  setStoreState({
    tradeLoading: false,
    ...(latestViewer && balAfterOpen !== undefined ? { viewer: { ...latestViewer, balanceCents: balAfterOpen } } : {}),
  });
  const actionVerb = input.action === "add" ? "Increased" : input.action === "reduce" ? "Reduced" : "Flipped";
  setStatusNotice(`${actionVerb} $${input.ticker} to ${input.side.toUpperCase()} ${targetLeverage}x.`);
  await refreshAfterTrade();
  return true;
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
    requestJson("/api/chats/alpha-invites", { parse: decodeAlphaInvites }),
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

export async function leaveGroupChat(chatId: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson(`/api/chats/${encodeURIComponent(chatId)}/leave`, {
    method: "POST",
    body: {},
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
  setStatusNotice("Left group chat.");
  await loadChats();
  return true;
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
  const res = await requestJson(`/api/chats/messages/${encodeURIComponent(messageId)}/react`, {
    method: "POST",
    body: { emoji },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  await loadChatMessages(s.selectedChatId);
}

export async function respondAlphaInvite(inviteId: string, accept: boolean): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson(`/api/chats/alpha-invites/${encodeURIComponent(inviteId)}/respond`, {
    method: "POST",
    body: { accept },
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  setStatusNotice(accept ? "Joined alpha group." : "Invite declined.");
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

export async function loadProfile(handleOrSelf?: string | null): Promise<void> {
  const s = getStoreSnapshot();
  const handle = (handleOrSelf ?? s.profileHandle ?? s.viewer?.handle ?? "").replace(/^@/, "").trim();
  if (!handle) return;
  setStoreState({ profileLoading: true, profileHandle: handle });
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
    requestJson("/api/users/me/blocked", { parse: decodeModerationList }),
    requestJson("/api/users/me/muted", { parse: decodeModerationList }),
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
    marketSocialPosts: cur.marketSocialPosts.map((p) =>
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

export async function toggleBlock(handle: string, currentBlocked?: boolean): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const lower = handle.toLowerCase();
  const blocked = currentBlocked
    ?? (s.profileBundle?.summary.handle.toLowerCase() === lower ? s.profileBundle.summary.isBlocked : undefined)
    ?? s.blockedAccounts.some((acc) => acc.handle.toLowerCase() === lower);
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/block`, {
    method: blocked ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  if (!blocked) {
    filterAuthorOutOfFeeds(handle);
  }
  const cur = getStoreSnapshot();
  if (cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower) {
    setStoreState({
      profileBundle: {
        ...cur.profileBundle,
        summary: { ...cur.profileBundle.summary, isBlocked: !blocked, isFollowing: blocked ? cur.profileBundle.summary.isFollowing : false },
      },
    });
  }
  if (blocked) {
    setStoreState({
      blockedAccounts: getStoreSnapshot().blockedAccounts.filter((a) => a.handle.toLowerCase() !== lower),
    });
  } else if (cur.route === "Settings") {
    void loadModerationLists();
  }
  setStatusNotice(blocked ? `Unblocked @${handle}.` : `Blocked @${handle}.`);
}

export async function toggleMute(handle: string, currentMuted?: boolean): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const lower = handle.toLowerCase();
  const muted = currentMuted
    ?? (s.profileBundle?.summary.handle.toLowerCase() === lower ? s.profileBundle.summary.isMuted : undefined)
    ?? s.mutedAccounts.some((acc) => acc.handle.toLowerCase() === lower);
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/mute`, {
    method: muted ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setErrorNotice(res.message);
    return;
  }
  if (!muted) {
    filterAuthorOutOfFeeds(handle);
  }
  const cur = getStoreSnapshot();
  if (cur.profileBundle && cur.profileBundle.summary.handle.toLowerCase() === lower) {
    setStoreState({
      profileBundle: {
        ...cur.profileBundle,
        summary: { ...cur.profileBundle.summary, isMuted: !muted },
      },
    });
  }
  if (muted) {
    setStoreState({
      mutedAccounts: getStoreSnapshot().mutedAccounts.filter((a) => a.handle.toLowerCase() !== lower),
    });
  } else if (cur.route === "Settings") {
    void loadModerationLists();
  }
  setStatusNotice(muted ? `Unmuted @${handle}.` : `Muted @${handle}.`);
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

export { hasAtRiskOpenPositions };
