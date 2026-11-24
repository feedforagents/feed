// spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import { passThrough, requestJson } from "./api.ts";
import {
  clearNotices,
  getStoreSnapshot,
  pushBrowserRoute,
  recordPublicView,
  requireAuthOrQueue,
  sendApp,
  sendNav,
  setStoreState,
  toSpecTab,
  type UiFeedTab,
} from "./store-core.ts";
import {
  type AppPerpMarket,
  type AppPost,
  type AppPredictionMarket,
  decodeAlphaInvites,
  decodeChatMessages,
  decodeChats,
  decodeExplore,
  decodeFeedPage,
  decodeLeaderboard,
  decodeNotifications,
  decodePerpMarket,
  decodePointPacks,
  decodePositions,
  decodePost,
  decodePostThread,
  decodePredictionMarket,
  decodeProfileBundle,
  decodeTrendingList,
  isRecord,
  arr,
  optStr,
  str,
} from "./types.ts";

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
    ?? s.activeThread?.replies.find((p) => p.card.id === postId)
    ?? s.profileBundle?.posts.find((p) => p.card.id === postId)
    ?? s.explore.posts.find((p) => p.card.id === postId);
}

let feedLoadId = 0;
let feedMoreId = 0;

export async function loadFeed(tabOverride?: UiFeedTab): Promise<void> {
  const s = getStoreSnapshot();
  const tab = tabOverride ?? s.feedTab;
  const loadId = ++feedLoadId;
  setStoreState({ feedLoading: true });
  const res = await requestJson(`/api/feed?tab=${encodeURIComponent(tab)}`, {
    parse: decodeFeedPage,
  });
  if (loadId !== feedLoadId || getStoreSnapshot().feedTab !== tab) return;
  if (res.ok) {
    setStoreState({ feedPosts: res.data.items, feedNextCursor: res.data.nextCursor, feedLoading: false });
    return;
  }
  setStoreState({ feedLoading: false, errorMessage: res.message });
}

export async function loadMoreFeed(): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.feedNextCursor || s.feedLoading || s.feedLoadingMore) return;
  const tab = s.feedTab;
  const cursor = s.feedNextCursor;
  const loadId = feedLoadId;
  const moreId = ++feedMoreId;
  setStoreState({ feedLoadingMore: true });
  const res = await requestJson(
    `/api/feed?tab=${encodeURIComponent(tab)}&cursor=${encodeURIComponent(cursor)}`,
    { parse: decodeFeedPage },
  );
  if (loadId !== feedLoadId || getStoreSnapshot().feedTab !== tab) {
    if (moreId === feedMoreId) setStoreState({ feedLoadingMore: false });
    return;
  }
  if (res.ok) {
    const latest = getStoreSnapshot();
    setStoreState({
      feedPosts: appendUniquePosts(latest.feedPosts, res.data.items),
      feedNextCursor: res.data.nextCursor,
      feedLoadingMore: false,
    });
    return;
  }
  setStoreState({ feedLoadingMore: false, errorMessage: res.message });
}

export async function loadTrending(): Promise<void> {
  const res = await requestJson("/api/trending", { parse: decodeTrendingList });
  if (res.ok) {
    const cur = getStoreSnapshot();
    setStoreState({ explore: { ...cur.explore, trending: res.data } });
  }
}

export async function selectFeedTab(tab: UiFeedTab): Promise<void> {
  const s = getStoreSnapshot();
  if ((tab === "following" || tab === "top") && s.viewer === null) {
    requireAuthOrQueue({ kind: "switch_tab", tab, label: `view the ${tab} feed` });
    return;
  }
  if (s.feedTab === tab && s.feedLoading) return;
  const specTab = toSpecTab(tab);
  sendNav({ type: "selectFeedTab", tab: specTab });
  sendApp({ type: "selectTab", tab: specTab });
  if (s.feedTab !== tab) setStoreState({ feedTab: tab, feedPosts: [], feedNextCursor: null, feedLoading: true });
  await loadFeed(tab);
}

export async function openThread(postId: string): Promise<void> {
  setStoreState({ threadLoading: true });
  recordPublicView("Home");
  const res = await requestJson(`/api/posts/${encodeURIComponent(postId)}`, {
    parse: decodePostThread,
  });
  if (res.ok && res.data) {
    setStoreState({ activeThread: res.data, threadLoading: false });
    return;
  }
  setStoreState({ threadLoading: false, errorMessage: res.ok ? "Post not found" : res.message });
}

export function closeThread(): void {
  setStoreState({ activeThread: null });
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
  const res = await requestJson("/api/posts", {
    method: "POST",
    body: {
      content,
      ...(options?.replyToPostId ? { replyToPostId: options.replyToPostId } : {}),
      ...(options?.quotePostId ? { quotePostId: options.quotePostId } : {}),
      ...(options?.marketId ? { marketId: options.marketId } : {}),
      ...(options?.ticker ? { ticker: options.ticker } : {}),
    },
    parse: decodePost,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return false;
  }
  setStoreState({ statusMessage: options?.replyToPostId ? "Reply posted." : "Post published." });
  await loadFeed();
  const thread = getStoreSnapshot().activeThread;
  if (thread && options?.replyToPostId === thread.post.card.id) {
    await openThread(thread.post.card.id);
  }
  return true;
}

export async function deletePost(postId: string): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson(`/api/posts/${encodeURIComponent(postId)}`, {
    method: "DELETE",
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return;
  }
  const thread = getStoreSnapshot().activeThread;
  setStoreState({
    feedPosts: getStoreSnapshot().feedPosts.filter((p) => p.card.id !== postId),
    activeThread: thread?.post.card.id === postId ? null : thread,
    statusMessage: "Post deleted.",
  });
}

async function executePostAction({
  postId,
  endpoint,
  method,
  includeThread,
  buildPatch,
}: {
  readonly postId: string;
  readonly endpoint: string;
  readonly method: "POST" | "DELETE";
  readonly includeThread: boolean;
  readonly buildPatch: (data: unknown) => (card: AppPost["card"]) => AppPost["card"];
}): Promise<void> {
  const res = await requestJson(endpoint, { method, parse: passThrough });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return;
  }
  const updateCard = buildPatch(res.data);
  const patchPost = (post: AppPost): AppPost =>
    post.card.id === postId ? { ...post, card: updateCard(post.card) } : post;
  const patchList = (list: ReadonlyArray<AppPost>) => list.map(patchPost);
  const cur = getStoreSnapshot();
  setStoreState({
    feedPosts: patchList(cur.feedPosts),
    explore: { ...cur.explore, posts: patchList(cur.explore.posts) },
    profileBundle: cur.profileBundle ? { ...cur.profileBundle, posts: patchList(cur.profileBundle.posts) } : null,
    ...(includeThread
      ? {
          activeThread: cur.activeThread
            ? {
                post: patchPost(cur.activeThread.post),
                parentPost: cur.activeThread.parentPost,
                replies: patchList(cur.activeThread.replies),
              }
            : null,
        }
      : {}),
  });
}

export async function toggleLike(postId: string): Promise<void> {
  const existing = findPostInState(postId);
  const currentlyLiked = existing?.card.liked ?? false;
  if (!requireAuthOrQueue({ kind: "like", postId, currentlyLiked, label: "like this post" })) return;
  await executePostAction({
    postId,
    endpoint: `/api/posts/${encodeURIComponent(postId)}/like`,
    method: currentlyLiked ? "DELETE" : "POST",
    includeThread: true,
    buildPatch: (data) => {
      const rec = isRecord(data) ? data : {};
      const nextLiked = typeof rec.liked === "boolean" ? rec.liked : !currentlyLiked;
      const nextCount = typeof rec.likeCount === "number"
        ? rec.likeCount
        : Math.max(0, (existing?.card.likeCount ?? 0) + (nextLiked ? 1 : -1));
      return (card) => ({ ...card, liked: nextLiked, likeCount: nextCount });
    },
  });
}

export async function repostPost(postId: string): Promise<void> {
  const existing = findPostInState(postId);
  const currentlyReposted = existing?.card.reposted ?? false;
  if (!requireAuthOrQueue({ kind: "repost", postId, label: currentlyReposted ? "remove repost" : "repost this post" })) return;
  await executePostAction({
    postId,
    endpoint: `/api/posts/${encodeURIComponent(postId)}/repost`,
    method: currentlyReposted ? "DELETE" : "POST",
    includeThread: true,
    buildPatch: (data) => {
      const rec = isRecord(data) ? data : {};
      const nextReposted = typeof rec.reposted === "boolean" ? rec.reposted : !currentlyReposted;
      const nextCount = typeof rec.repostCount === "number" ? rec.repostCount : undefined;
      return (card) => ({
        ...card,
        reposted: nextReposted,
        repostCount: nextCount ?? Math.max(0, card.repostCount + (nextReposted ? 1 : -1)),
      });
    },
  });
}

export async function loadExplore(queryOverride?: string): Promise<void> {
  const q = queryOverride ?? getStoreSnapshot().exploreQuery;
  setStoreState({ exploreLoading: true, exploreQuery: q });
  const res = await requestJson(`/api/explore?q=${encodeURIComponent(q.trim())}`, {
    parse: decodeExplore,
  });
  if (res.ok) {
    setStoreState({ explore: res.data, exploreLoading: false });
    return;
  }
  setStoreState({ exploreLoading: false, errorMessage: res.message });
}

export async function loadMarkets(): Promise<void> {
  setStoreState({ marketsLoading: true });
  const [mktRes, lbRes, packsRes] = await Promise.all([
    requestJson("/api/markets", { parse: passThrough }),
    requestJson("/api/leaderboard", { parse: decodeLeaderboard }),
    requestJson("/api/economy/packs", { parse: decodePointPacks }),
  ]);
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
  const hasAtRisk = positions.length > 0;
  sendNav({ type: "setAtRiskPositions", atRisk: hasAtRisk });
  sendApp({ type: "updateAtRiskPositions", atRisk: hasAtRisk });
  let selectedMarketKind = s.selectedMarketKind;
  let selectedMarketId = s.selectedMarketId;
  if (s.selectedTicker) {
    const matchedPerp = perps.find((p) => p.ticker.toUpperCase() === s.selectedTicker?.toUpperCase());
    if (matchedPerp) {
      selectedMarketKind = "perp";
      selectedMarketId = matchedPerp.ticker;
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
    predictions,
    perps,
    positions,
    selectedMarketKind,
    selectedMarketId,
    leaderboard: lbRes.ok ? lbRes.data : s.leaderboard,
    packs: packsRes.ok ? packsRes.data : s.packs,
  });
}

export function selectMarket(kind: "prediction" | "perp", id: string): void {
  recordPublicView("Markets");
  setStoreState({ selectedMarketKind: kind, selectedMarketId: id, tradeError: null });
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
    return false;
  }
  const curViewer = getStoreSnapshot().viewer;
  const bal = isRecord(res.data) && typeof res.data.balanceAfterCents === "number" ? res.data.balanceAfterCents : curViewer?.balanceCents;
  setStoreState({
    tradeLoading: false,
    statusMessage,
    ...(curViewer && bal !== undefined ? { viewer: { ...curViewer, balanceCents: bal } } : {}),
  });
  await loadMarkets();
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
  if (!getStoreSnapshot().viewer) return;
  await executeTradeRequest({
    endpoint: `/api/markets/perp/positions/${encodeURIComponent(positionId)}/close`,
    body: {},
    statusMessage: "Position closed.",
  });
}

export async function startPointPackCheckout(packId: string, billingState: string): Promise<string | null> {
  if (!getStoreSnapshot().viewer) return null;
  setStoreState({ checkoutLoading: true, checkoutError: null });
  const res = await requestJson("/api/economy/checkout", {
    method: "POST",
    body: { packId, billingState },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ checkoutLoading: false, checkoutError: res.message });
    return null;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const url = optStr(rec.checkoutUrl ?? rec.url);
  setStoreState({
    checkoutLoading: false,
    statusMessage: url ? "Checkout session created." : "Points pack request recorded.",
  });
  if (url && typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
  return url;
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
    setStoreState({ errorMessage: res.message });
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
    setStoreState({ errorMessage: res.message });
    return false;
  }
  const rec = isRecord(res.data) ? (isRecord(res.data.chat) ? res.data.chat : res.data) : {};
  const chatId = optStr(rec.id);
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
    setStoreState({ errorMessage: res.message });
    return false;
  }
  setStoreState({ statusMessage: `Invited @${cleaned} to group.` });
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
    setStoreState({ errorMessage: res.message });
    return false;
  }
  const s = getStoreSnapshot();
  setStoreState({
    selectedChatId: s.selectedChatId === chatId ? null : s.selectedChatId,
    chatMessages: s.selectedChatId === chatId ? [] : s.chatMessages,
    statusMessage: "Left group chat.",
  });
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
    setStoreState({ errorMessage: res.message });
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
    setStoreState({ errorMessage: res.message });
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
    setStoreState({ errorMessage: res.message });
    return;
  }
  setStoreState({ statusMessage: accept ? "Joined NPC alpha group." : "Invite declined." });
  await loadChats();
}

export async function loadNotifications(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  setStoreState({ notificationsLoading: true });
  const res = await requestJson("/api/notifications", { parse: decodeNotifications });
  if (res.ok) {
    const unread = res.data.filter((n) => !n.item.read).length;
    setStoreState({ notifications: res.data, unreadNotifications: unread, notificationsLoading: false });
    return;
  }
  setStoreState({ notificationsLoading: false, errorMessage: res.message });
}

export async function markAllNotificationsRead(): Promise<void> {
  if (!getStoreSnapshot().viewer) return;
  const res = await requestJson("/api/notifications/read", {
    method: "POST",
    body: {},
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
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
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}`, {
    parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null),
  });
  if (res.ok && res.data) {
    setStoreState({ profileBundle: res.data, profileLoading: false });
    return;
  }
  setStoreState({ profileBundle: null, profileLoading: false, errorMessage: res.ok ? "Profile not found" : res.message });
}

export async function loadMoreProfilePosts(): Promise<void> {
  const s = getStoreSnapshot();
  const bundle = s.profileBundle;
  if (!bundle || !bundle.postsNextCursor || s.profileLoading || s.profileLoadingMore) return;
  setStoreState({ profileLoadingMore: true });
  const res = await requestJson(
    `/api/users/${encodeURIComponent(bundle.summary.handle)}?cursor=${encodeURIComponent(bundle.postsNextCursor)}`,
    { parse: (raw) => decodeProfileBundle(raw, s.viewer?.accountId ?? null) },
  );
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
  setStoreState({ profileLoadingMore: false, errorMessage: res.ok ? "Profile not found" : res.message });
}

export async function updateOwnProfile(payload: {
  readonly displayName?: string;
  readonly bio?: string;
}): Promise<boolean> {
  const s = getStoreSnapshot();
  if (!s.viewer) return false;
  const res = await requestJson("/api/users/me", {
    method: "PATCH",
    body: payload,
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return false;
  }
  const rec = isRecord(res.data) ? res.data : {};
  const nextDisplayName = str(rec.displayName, payload.displayName ?? s.viewer.displayName);
  const nextBio = str(rec.bio, payload.bio ?? s.viewer.bio);
  setStoreState({
    viewer: { ...s.viewer, displayName: nextDisplayName, bio: nextBio },
    statusMessage: "Profile updated.",
  });
  await loadProfile(s.viewer.handle);
  return true;
}

export async function toggleFollow(handle: string, currentlyFollowing?: boolean): Promise<void> {
  const active = currentlyFollowing ?? getStoreSnapshot().profileBundle?.summary.isFollowing ?? false;
  if (!requireAuthOrQueue({ kind: "follow", handle, currentlyFollowing: active, label: `follow @${handle}` })) return;
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/follow`, {
    method: active ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return;
  }
  await loadProfile(handle);
}

export async function toggleBlock(handle: string): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const blocked = s.profileBundle?.summary.isBlocked ?? false;
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/block`, {
    method: blocked ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return;
  }
  setStoreState({ statusMessage: blocked ? `Unblocked @${handle}.` : `Blocked @${handle}.` });
  await loadProfile(handle);
}

export async function toggleMute(handle: string): Promise<void> {
  const s = getStoreSnapshot();
  if (!s.viewer) return;
  const muted = s.profileBundle?.summary.isMuted ?? false;
  const res = await requestJson(`/api/users/${encodeURIComponent(handle)}/mute`, {
    method: muted ? "DELETE" : "POST",
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return;
  }
  setStoreState({ statusMessage: muted ? `Unmuted @${handle}.` : `Muted @${handle}.` });
  await loadProfile(handle);
}

export async function submitReport(targetKind: "account" | "post", targetId: string, reason: string): Promise<boolean> {
  if (!getStoreSnapshot().viewer) return false;
  const res = await requestJson("/api/reports", {
    method: "POST",
    body: { targetKind, targetId, reason },
    parse: passThrough,
  });
  if (!res.ok) {
    setStoreState({ errorMessage: res.message });
    return false;
  }
  setStoreState({ statusMessage: "Report submitted." });
  return true;
}
