// spec/app/index.md, "Application shell state and single-agent grant tracking"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import {
  type AgentConnectCardProps,
  type AgentHostId,
  type AgentHostLauncher,
  type AgentLogoKey,
  type ArticleItem,
  type ChatKind,
  type ChatMessageItem,
  type LeaderboardEntry,
  type MarketCardData,
  type NotificationItem,
  type NotificationKind,
  type PositionRowData,
  type PostCardData,
  type PredictionMarketPhase,
  type ProfileSummary,
  type ToastTone,
  type TrendingItem,
  defaultAgentLaunchers,
  defaultSkillPrompt,
  formatPts,
} from "@repo/ui";
import type { AgentHost } from "../../gen/app__onboarding.ts";

export type AgentGrantSummary = NonNullable<AgentConnectCardProps["grant"]>;

export type ThemePreference = "light" | "dark" | "system";

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly description?: string;
  readonly tone: ToastTone;
}

export interface ViewerSession {
  readonly accountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly phoneLast2: string | null;
  readonly uiMode: "game" | "social";
  readonly balanceCents: number;
  readonly startingGrantCents: number;
  readonly isAdmin: boolean;
  readonly isReviewer: boolean;
  readonly agentGrant: AgentGrantSummary | null;
}

export interface AuthMePayload {
  readonly authenticated: boolean;
  readonly viewer: ViewerSession | null;
  readonly acceptedCountries: ReadonlyArray<string>;
  readonly publicAppUrl: string;
  readonly turnstileSiteKey: string | null;
  readonly devSmsCodeEnabled: boolean;
}

export interface AppFeedPage {
  readonly items: ReadonlyArray<AppPost>;
  readonly nextCursor: string | null;
}

export interface AppPost {
  readonly card: PostCardData;
  readonly authorId: string;
  readonly authorKind: string;
  readonly replyToPostId: string | null;
  readonly marketId: string | null;
  readonly ticker: string | null;
  readonly createdAtMs: number;
}

export interface PostThreadData {
  readonly post: AppPost;
  readonly parentPost: AppPost | null;
  readonly ancestors: ReadonlyArray<AppPost>;
  readonly replies: ReadonlyArray<AppPost>;
}

export interface AppPredictionMarket {
  readonly card: Extract<MarketCardData, { kind: "prediction" }>;
  readonly description: string;
  readonly category: string;
  readonly status: string;
  readonly yesPriceBps: number;
  readonly noPriceBps: number;
  readonly resolutionProof: string | null;
  readonly resolutionArticleId: string | null;
}

export interface AppPerpMarket {
  readonly card: Extract<MarketCardData, { kind: "perp" }>;
  readonly ticker: string;
  readonly organizationId: string | null;
  readonly orgImageUrl: string | null;
  readonly indexCents: number;
  readonly markCents: number;
  readonly change24hPct: number;
  readonly volume24hCents: number;
  readonly fundingRateBps: number;
  readonly openInterestCents: number;
  readonly history: ReadonlyArray<{ readonly label: string; readonly value: number }>;
}

export interface AppPosition {
  readonly row: PositionRowData;
  readonly marketId: string;
  readonly rawSide: "yes" | "no" | "long" | "short";
  readonly shares: number;
  readonly isClosed: boolean;
}

export interface AppLeaderboardEntry extends LeaderboardEntry {
  readonly balanceCents: number;
  readonly positionValueCents: number;
  readonly equityCents: number;
  readonly startingGrantCents: number;
  readonly wins: number;
  readonly settledCount: number;
}

export interface AppAccountEconomy {
  readonly accountId: string;
  readonly balanceCents: number;
  readonly positionValueCents: number;
  readonly equityCents: number;
  readonly startingGrantCents: number;
  readonly totalFeesPaidCents: number;
  readonly netProfitCents: number;
}

export interface AppLedgerEntry {
  readonly id: string;
  readonly kind: string;
  readonly deltaCents: number;
  readonly balanceAfterCents: number;
  readonly refId: string | null;
  readonly createdAtMs: number;
  readonly timestamp: string;
}

export interface AppEconomyPayload {
  readonly economy: AppAccountEconomy | null;
  readonly ledger: ReadonlyArray<AppLedgerEntry>;
}

export interface ExploreAccountHit {
  readonly accountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
}

export interface ExploreActorHit {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly tier: string;
  readonly description: string;
  readonly avatarUrl: string | null;
  readonly isParody: boolean;
}

export interface ExploreOrgHit {
  readonly id: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly orgType: string;
  readonly description: string;
  readonly avatarUrl: string | null;
  readonly initialPriceCents: number | null;
}

export interface AppArticle extends ArticleItem {
  readonly authorOrgId: string | null;
  readonly body: string;
  readonly relatedMarketId: string | null;
  readonly isResolutionProof: boolean;
  readonly publishedAtMs: number;
}

export interface ExploreData {
  readonly trending: ReadonlyArray<TrendingItem>;
  readonly articles: ReadonlyArray<AppArticle>;
  readonly posts: ReadonlyArray<AppPost>;
  readonly accounts: ReadonlyArray<ExploreAccountHit>;
  readonly actors: ReadonlyArray<ExploreActorHit>;
  readonly organizations: ReadonlyArray<ExploreOrgHit>;
}

export interface AppChatMember {
  readonly memberId: string;
  readonly memberKind: "user" | "npc";
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly role: "owner" | "admin" | "member";
}

export interface AppChatSummary {
  readonly id: string;
  readonly chatType: ChatKind;
  readonly title: string;
  readonly subtitle: string;
  readonly memberCount: number;
  readonly unreadCount: number;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: number | null;
  readonly peerAvatarUrl: string | null;
  readonly peerHandle: string | null;
  readonly members: ReadonlyArray<AppChatMember>;
  readonly isOwner: boolean;
  readonly isBlocked: boolean;
}

export interface AppAlphaInvite {
  readonly id: string;
  readonly chatId: string;
  readonly actorHandle: string;
  readonly actorDisplayName: string;
  readonly actorAvatarUrl: string | null;
  readonly chatTitle: string;
  readonly tier: string | null;
  readonly status: string;
}

export interface AppNotification {
  readonly item: NotificationItem;
  readonly postId: string | null;
  readonly marketId: string | null;
  readonly chatId: string | null;
  readonly inviteId: string | null;
  readonly isGameOnly: boolean;
}

export interface AppNotificationsPayload {
  readonly items: ReadonlyArray<AppNotification>;
  readonly unreadCount: number;
}

export interface AppProfileActorMeta {
  readonly tier: string;
  readonly affiliations: ReadonlyArray<string>;
}

export interface AppProfileOrgMeta {
  readonly ticker: string | null;
  readonly orgType: string;
}

export interface AppProfileBundle {
  readonly summary: ProfileSummary;
  readonly id: string;
  readonly kind: string;
  readonly postsCount: number;
  readonly createdAtMs: number;
  readonly actorMeta: AppProfileActorMeta | null;
  readonly orgMeta: AppProfileOrgMeta | null;
  readonly viewerFollowedBy: boolean;
  readonly viewerBlockedBy: boolean;
  readonly tradeCount: number | null;
  readonly openPositionCount: number | null;
  readonly posts: ReadonlyArray<AppPost>;
  readonly postsNextCursor: string | null;
  readonly positions: ReadonlyArray<AppPosition>;
}

export interface AppFollowListEntry {
  readonly id: string;
  readonly kind: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
  readonly viewerFollows: boolean;
  readonly isParody: boolean;
}

export interface AppModerationEntry {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly bio: string;
}

export interface AppHostOption {
  readonly launcher: AgentHostLauncher;
  readonly prompt: string;
  readonly cliCommand: string | null;
  readonly webUrl: string | null;
  readonly resolvedLaunchKind: string;
  readonly notes: string;
}

export interface AppSkillsPayload {
  readonly skillUrl: string;
  readonly mcpUrl: string;
  readonly skillMarkdown: string;
  readonly prompt: string;
  readonly hosts: ReadonlyArray<AppHostOption>;
}

export interface OAuthConsentInfo {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: ReadonlyArray<string>;
  readonly state: string;
  readonly resource: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly responseType: string;
  readonly priorGrantClientName: string | null;
  readonly error: string | null;
}

export interface AdminTickRow {
  readonly jobName: string;
  readonly lastStatus: string;
  readonly lastError: string | null;
  readonly pendingCount: number;
  readonly durationMs: number;
  readonly lastSuccessLabel: string;
}

export interface AdminSpendInfo {
  readonly utcDay: string;
  readonly dailyBudgetCents: number;
  readonly confirmedCents: number;
  readonly reservedCents: number;
  readonly carryoverReservedCents: number;
  readonly committedCents: number;
  readonly remainingCents: number;
  readonly throttleLevel: string;
  readonly maxStepsAllowed: number;
  readonly effectiveBatchSize: number;
}

export interface AdminHoldMarket {
  readonly id: string;
  readonly question: string;
  readonly timeframe: string;
  readonly expiresLabel: string;
}

export interface AdminStatusData {
  readonly currentDay: number;
  readonly currentHour: number;
  readonly phase: string;
  readonly gameRunning: boolean;
  readonly ticks: ReadonlyArray<AdminTickRow>;
  readonly spend: AdminSpendInfo;
  readonly manualHolds: ReadonlyArray<AdminHoldMarket>;
}

export type PendingAction =
  | { readonly kind: "like"; readonly postId: string; readonly currentlyLiked: boolean; readonly label: string }
  | { readonly kind: "repost"; readonly postId: string; readonly label: string }
  | { readonly kind: "reply"; readonly postId: string; readonly content: string; readonly label: string }
  | { readonly kind: "post"; readonly content: string; readonly quotePostId?: string; readonly label: string }
  | { readonly kind: "follow"; readonly handle: string; readonly currentlyFollowing: boolean; readonly label: string }
  | { readonly kind: "dm"; readonly handle: string; readonly label: string }
  | { readonly kind: "trade_prediction"; readonly marketId: string; readonly action: "Buy" | "Sell"; readonly side: "yes" | "no"; readonly amountPts: number; readonly label: string }
  | { readonly kind: "trade_perp"; readonly ticker: string; readonly side: "long" | "short"; readonly marginPts: number; readonly leverage: number; readonly label: string }
  | { readonly kind: "persist_mode"; readonly mode: "game" | "social"; readonly label: string }
  | { readonly kind: "switch_tab"; readonly tab: "latest" | "following" | "top"; readonly label: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function arr(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatJoinedLabel(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  const month = MONTH_NAMES[d.getUTCMonth()];
  if (!month) return undefined;
  return `Joined ${month} ${d.getUTCFullYear()}`;
}

export function formatFullTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  const month = MONTH_NAMES[d.getUTCMonth()] ?? "Jan";
  const hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${mins} ${period} · ${month} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatTimeLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60 && diffSec >= 0) return `${Math.max(1, diffSec)}s`;
  if (diffSec < 3600 && diffSec >= 0) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400 && diffSec >= 0) return `${Math.floor(diffSec / 3600)}h`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatCountdown(expiresAtMs: number): string {
  const diffMs = expiresAtMs - Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return "";
  if (diffMs <= 0) return "Expired";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function matchAgentLogo(clientName: string | null): AgentLogoKey | undefined {
  if (!clientName) return undefined;
  const lower = clientName.toLowerCase();
  if (lower.includes("claude")) return "Claude";
  if (lower.includes("chatgpt") || lower.includes("openai")) return "ChatGPT";
  if (lower.includes("cursor")) return "Cursor";
  if (lower.includes("grok")) return "Grok";
  if (lower.includes("meta") || lower.includes("muse")) return "Meta AI (Muse Spark)";
  if (lower.includes("openclaw")) return "OpenClaw";
  if (lower.includes("hermes")) return "Hermes Agent";
  return undefined;
}

export function toSpecAgentHost(hostId: AgentHostId): AgentHost {
  if (hostId === "HostCursor") return "HostCopyPrompt";
  return hostId;
}

function decodeScopesRecord(raw: unknown): AgentGrantSummary["scopes"] {
  if (Array.isArray(raw)) {
    const set = new Set(raw.filter((v): v is string => typeof v === "string"));
    return {
      read: set.has("read"),
      socialWrite: set.has("social:write"),
      messages: set.has("messages"),
      trade: set.has("trade"),
    };
  }
  if (typeof raw === "string") {
    const set = new Set(raw.trim().split(/\s+/));
    return {
      read: set.has("read"),
      socialWrite: set.has("social:write"),
      messages: set.has("messages"),
      trade: set.has("trade"),
    };
  }
  if (isRecord(raw)) {
    return {
      read: bool(raw.read, true),
      socialWrite: bool(raw.socialWrite ?? raw["social:write"], false),
      messages: bool(raw.messages, false),
      trade: bool(raw.trade, false),
    };
  }
  return { read: true, socialWrite: false, messages: false, trade: false };
}

export function decodeAgentGrant(raw: unknown): AgentGrantSummary | null {
  if (!isRecord(raw)) return null;
  const grantId = optStr(raw.grantId ?? raw.grant_id);
  const clientName = optStr(raw.clientName ?? raw.client_name);
  if (!grantId || !clientName) return null;
  return {
    grantId,
    clientName,
    agentMark: matchAgentLogo(clientName),
    scopes: decodeScopesRecord(raw.scopes ?? raw.scopeSet),
    connectedAt: typeof raw.connectedAt === "string" ? raw.connectedAt : formatTimeLabel(num(raw.createdAt ?? raw.created_at)),
    lastUsedAt: typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : formatTimeLabel(num(raw.lastUsedAt ?? raw.last_used_at)),
  };
}

export function decodeViewer(raw: unknown): ViewerSession | null {
  if (!isRecord(raw)) return null;
  const accountId = optStr(raw.accountId ?? raw.account_id);
  const handle = optStr(raw.handle);
  if (!accountId || !handle) return null;
  const modeRaw = str(raw.uiMode ?? raw.playMode ?? raw.ui_mode, "game");
  return {
    accountId,
    handle,
    displayName: str(raw.displayName ?? raw.display_name, handle),
    bio: str(raw.bio, ""),
    avatarUrl: optStr(raw.avatarUrl ?? raw.avatar_url),
    bannerUrl: optStr(raw.bannerUrl ?? raw.banner_url),
    phoneLast2: optStr(raw.phoneLast2 ?? raw.phone_last2),
    uiMode: modeRaw === "social" || modeRaw === "SocialMode" ? "social" : "game",
    balanceCents: num(raw.balanceCents ?? raw.balance_cents, 0),
    startingGrantCents: num(raw.startingGrantCents ?? raw.starting_grant_cents, 10000),
    isAdmin: bool(raw.isAdmin ?? raw.is_admin, false),
    isReviewer: bool(raw.isReviewer ?? raw.is_reviewer, false),
    agentGrant: decodeAgentGrant(raw.agentGrant ?? raw.activeGrant ?? raw.activeAgentGrant),
  };
}

export function decodeAuthMe(raw: unknown): AuthMePayload {
  const rec = isRecord(raw) ? raw : {};
  const viewer = decodeViewer(rec.viewer ?? rec.account);
  const authenticated = bool(rec.authenticated, viewer !== null) && viewer !== null;
  const acceptedCountries = arr(rec.acceptedCountries).filter((c): c is string => typeof c === "string");
  return {
    authenticated,
    viewer,
    acceptedCountries,
    publicAppUrl: str(rec.publicAppUrl, typeof window !== "undefined" ? window.location.origin : "https://feed.fun"),
    turnstileSiteKey: optStr(rec.turnstileSiteKey),
    devSmsCodeEnabled: bool(rec.devSmsCodeEnabled, false),
  };
}

function decodeMarketBadge(
  badgeRaw: Record<string, unknown> | null,
  ticker: string | null,
  showTradeEmbed: boolean,
): PostCardData["marketBadge"] {
  if (!showTradeEmbed) return undefined;
  if (badgeRaw) {
    const kind = optStr(badgeRaw.kind);
    if (kind === "prediction") {
      const question = str(badgeRaw.question, "Prediction market");
      const yesBps = num(badgeRaw.yesPriceBps, 5000);
      return {
        ticker: ticker ?? "PRED",
        label: question,
        oddsPct: Math.min(99, Math.max(1, Math.round(yesBps / 100))),
      };
    }
    if (kind === "perp") {
      const perpTicker = str(badgeRaw.ticker, ticker ?? "");
      if (!perpTicker) return undefined;
      const markCents = num(badgeRaw.markPriceCents, 0);
      const label = markCents > 0
        ? `${str(badgeRaw.name, perpTicker)} · ${formatPts(markCents / 100)}`
        : str(badgeRaw.name, perpTicker);
      return {
        ticker: perpTicker,
        label,
        ...(typeof badgeRaw.changePct === "number" ? { changePct: badgeRaw.changePct } : {}),
      };
    }
    const badgeTicker = str(badgeRaw.ticker, ticker ?? "");
    if (badgeTicker) {
      return {
        ticker: badgeTicker,
        label: str(badgeRaw.label, `Trade $${badgeTicker}`),
        ...(typeof badgeRaw.oddsPct === "number" ? { oddsPct: badgeRaw.oddsPct } : {}),
        ...(typeof badgeRaw.changePct === "number" ? { changePct: badgeRaw.changePct } : {}),
      };
    }
  }
  if (ticker) {
    return {
      ticker,
      label: `Trade $${ticker}`,
    };
  }
  return undefined;
}

export function decodePost(raw: unknown, viewerAccountId?: string | null): AppPost | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw.id);
  if (!id) return null;
  const authorId = str(raw.authorId ?? raw.author_id, "");
  const authorHandle = str(raw.authorHandle ?? raw.author_handle, "unknown");
  const authorDisplayName = str(raw.authorDisplayName ?? raw.author_display_name, authorHandle);
  const createdAtMs = num(raw.createdAt ?? raw.created_at, 0);
  const quoteRaw = raw.quotePost;
  const quoteAvatar = isRecord(quoteRaw) ? optStr(quoteRaw.avatarUrl ?? quoteRaw.authorAvatarUrl) : null;
  const quotePost = isRecord(quoteRaw) && optStr(quoteRaw.id)
    ? {
        id: str(quoteRaw.id),
        authorDisplayName: str(quoteRaw.authorDisplayName ?? quoteRaw.author_display_name, str(quoteRaw.authorHandle, "user")),
        authorHandle: str(quoteRaw.authorHandle ?? quoteRaw.author_handle, "user"),
        ...(quoteAvatar ? { authorAvatarUrl: quoteAvatar } : {}),
        isNpcParody: bool(quoteRaw.isParody ?? quoteRaw.isNpcParody, false),
        content: str(quoteRaw.content),
        ...(bool(quoteRaw.deleted, false) ? { deleted: true } : {}),
      }
    : undefined;
  const marketId = optStr(raw.marketId ?? raw.market_id);
  const ticker = optStr(raw.ticker);
  const showTradeEmbed = bool(raw.showTradeEmbed, true);
  const badgeRaw = isRecord(raw.marketBadge) ? raw.marketBadge : null;
  const marketBadge = decodeMarketBadge(badgeRaw, ticker, showTradeEmbed);
  const avatarUrl = optStr(raw.avatarUrl ?? raw.authorAvatarUrl);
  const viaClientName = optStr(raw.viaClientName ?? raw.via_client_name);
  const replyToHandle = optStr(raw.replyToHandle ?? raw.reply_to_handle);
  return {
    authorId,
    authorKind: str(raw.authorKind ?? raw.author_kind, "user"),
    replyToPostId: optStr(raw.replyToPostId ?? raw.reply_to_post_id),
    marketId,
    ticker,
    createdAtMs,
    card: {
      id,
      authorDisplayName,
      authorHandle,
      ...(avatarUrl ? { authorAvatarUrl: avatarUrl } : {}),
      isNpcParody: bool(raw.isParody ?? raw.isNpcParody, false),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : formatTimeLabel(createdAtMs),
      content: str(raw.content),
      ...(viaClientName ? { viaClientName } : {}),
      ...(replyToHandle ? { replyToHandle } : {}),
      ...(quotePost ? { quotePost } : {}),
      ...(marketBadge ? { marketBadge } : {}),
      likeCount: num(raw.likeCount ?? raw.like_count, 0),
      repostCount: num(raw.repostCount ?? raw.repost_count, 0),
      replyCount: num(raw.replyCount ?? raw.reply_count, 0),
      liked: bool(raw.likedByViewer ?? raw.liked, false),
      reposted: bool(raw.repostedByViewer ?? raw.reposted, false),
      isOwn: Boolean(viewerAccountId && authorId && viewerAccountId === authorId),
    },
  };
}

export function decodePosts(raw: unknown, viewerAccountId?: string | null): ReadonlyArray<AppPost> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.items ?? raw.posts) : [];
  return list.map((item) => decodePost(item, viewerAccountId)).filter((p): p is AppPost => p !== null);
}

export function decodeFeedPage(raw: unknown, viewerAccountId?: string | null): AppFeedPage {
  return {
    items: decodePosts(raw, viewerAccountId),
    nextCursor: isRecord(raw) ? optStr(raw.nextCursor) : null,
  };
}

export function decodePostThread(raw: unknown, viewerAccountId?: string | null): PostThreadData | null {
  if (!isRecord(raw)) return null;
  const post = decodePost(raw.post, viewerAccountId);
  if (!post) return null;
  const parentPost = decodePost(raw.parentPost, viewerAccountId);
  const decodedAncestors = arr(raw.ancestors)
    .map((item) => decodePost(item, viewerAccountId))
    .filter((p): p is AppPost => p !== null);
  const ancestors = decodedAncestors.length > 0 ? decodedAncestors : parentPost ? [parentPost] : [];
  return {
    post,
    parentPost,
    ancestors,
    replies: arr(raw.replies).map((item) => decodePost(item, viewerAccountId)).filter((p): p is AppPost => p !== null),
  };
}

function toPredictionPhase(status: string): PredictionMarketPhase {
  switch (status) {
    case "open":
    case "Trading":
      return "Trading";
    case "expired":
    case "awaiting_proof":
    case "AwaitingProof":
      return "AwaitingProof";
    case "manual_hold":
    case "ManualReviewHold":
      return "ManualReviewHold";
    case "resolved":
    case "Resolved":
      return "Resolved";
    case "cancelled":
    case "Cancelled":
      return "Cancelled";
    default:
      return "PendingOpen";
  }
}

export function decodePredictionMarket(raw: unknown): AppPredictionMarket | null {
  if (!isRecord(raw)) return null;
  const id = optStr(raw.id);
  if (!id) return null;
  const status = str(raw.status, "open");
  const yesPriceBps = num(raw.yesPriceBps ?? raw.yesProbabilityBps, Math.round(num(raw.yesPrice, 0.5) * 10000));
  const noPriceBps = num(raw.noPriceBps ?? raw.noProbabilityBps, 10000 - yesPriceBps);
  const yesShares = num(raw.yesShares ?? raw.yes_shares, 0);
  const noShares = num(raw.noShares ?? raw.no_shares, 0);
  const outcomeRaw = str(raw.resolvedOutcome ?? raw.resolved_outcome).toUpperCase();
  const resolvedOutcome = outcomeRaw === "YES" || outcomeRaw === "NO" ? outcomeRaw : undefined;
  const expiresAt = num(raw.expiresAt ?? raw.expires_at, 0);
  return {
    description: str(raw.description, ""),
    category: str(raw.category, "markets"),
    status,
    yesPriceBps,
    noPriceBps,
    resolutionProof: optStr(raw.resolutionProof ?? raw.resolution_proof),
    resolutionArticleId: optStr(raw.resolutionArticleId ?? raw.resolution_article_id),
    card: {
      kind: "prediction",
      id,
      question: str(raw.question, id),
      timeframe: str(raw.timeframe, "1d"),
      phase: toPredictionPhase(status),
      yesOddsPct: Math.min(98, Math.max(2, Math.round(yesPriceBps / 100))),
      liquidityPts: formatPts(num(raw.liquidityCents ?? raw.liquidity_cents, 0) / 100),
      ...(yesShares > 0 && noShares > 0 ? { yesShares, noShares } : {}),
      ...(expiresAt > 0 ? { closesIn: formatCountdown(expiresAt) } : {}),
      ...(resolvedOutcome ? { resolvedOutcome } : {}),
    },
  };
}

export function decodePerpMarket(raw: unknown): AppPerpMarket | null {
  if (!isRecord(raw)) return null;
  const ticker = optStr(raw.ticker ?? raw.id);
  if (!ticker) return null;
  const indexCents = num(raw.indexPriceCents ?? raw.index_price_cents, 10000);
  const markCents = num(raw.markPriceCents ?? raw.mark_price_cents, indexCents);
  const fundingRateBps = num(raw.fundingRateBps ?? raw.funding_rate_bps, 0);
  const openInterestCents = num(raw.openInterestCents, num(raw.longOiCents, 0) + num(raw.shortOiCents, 0));
  const change24hPct = num(raw.change24hPct ?? raw.change_24h_pct, 0);
  const volume24hCents = num(raw.volume24hCents ?? raw.volume_24h_cents, 0);
  const rawHistory = arr(raw.history ?? raw.priceHistory);
  const history = rawHistory
    .map((pt) => (isRecord(pt) ? { label: str(pt.label, ""), value: num(pt.value, markCents / 100) } : null))
    .filter((pt): pt is { label: string; value: number } => pt !== null);
  const fallbackHistory = history.length > 0
    ? history
    : [
        { label: "Index", value: indexCents / 100 },
        { label: "Mark", value: markCents / 100 },
      ];
  return {
    ticker,
    organizationId: optStr(raw.organizationId ?? raw.organization_id),
    orgImageUrl: optStr(raw.orgImageUrl ?? raw.org_image_url),
    indexCents,
    markCents,
    change24hPct,
    volume24hCents,
    fundingRateBps,
    openInterestCents,
    history: fallbackHistory,
    card: {
      kind: "perp",
      id: ticker,
      ticker,
      name: str(raw.name, ticker),
      indexPricePts: formatPts(indexCents / 100),
      markPricePts: formatPts(markCents / 100),
      fundingRatePct: `${(fundingRateBps / 100).toFixed(2)}%`,
      openInterestPts: formatPts(openInterestCents / 100),
      change24hPct,
      maxLeverage: num(raw.maxLeverage ?? raw.max_leverage, 20),
    },
  };
}

export function decodePositions(raw: unknown): ReadonlyArray<AppPosition> {
  const rec = isRecord(raw) ? raw : {};
  const predRaw = arr(rec.predictionPositions ?? rec.predictions);
  const perpRaw = arr(rec.perpPositions ?? rec.perps);
  const predPositions: AppPosition[] = predRaw
    .map((entry): AppPosition | null => {
      if (!isRecord(entry)) return null;
      const marketId = optStr(entry.marketId ?? entry.market_id);
      const shares = num(entry.shares, 0);
      if (!marketId || shares <= 0) return null;
      const rawSide = str(entry.side, "yes").toLowerCase() === "no" ? "no" : "yes";
      const costCents = num(entry.costBasisCents ?? entry.cost_basis_cents, 0);
      const estCents = num(entry.estimatedValueCents, costCents);
      const sidePriceBps = rawSide === "yes" ? num(entry.yesPriceBps, 5000) : num(entry.noPriceBps, 5000);
      return {
        marketId,
        rawSide,
        shares,
        isClosed: entry.settledAt !== null && entry.settledAt !== undefined,
        row: {
          id: `pred:${marketId}:${rawSide}`,
          kind: "prediction",
          marketLabel: str(entry.question, marketId),
          side: rawSide === "yes" ? "YES" : "NO",
          quantityLabel: `${shares} shares`,
          entryLabel: formatPts(costCents / 100),
          markLabel: `${Math.round(sidePriceBps / 100)}%`,
          pnlPts: (estCents - costCents) / 100,
        },
      };
    })
    .filter((p): p is AppPosition => p !== null);

  const perpPositions: AppPosition[] = perpRaw
    .map((entry): AppPosition | null => {
      if (!isRecord(entry)) return null;
      const id = optStr(entry.id);
      const ticker = optStr(entry.ticker);
      if (!id || !ticker) return null;
      const rawSide = str(entry.side, "long").toLowerCase() === "short" ? "short" : "long";
      const sizeCents = num(entry.sizeCents ?? entry.size_cents, 0);
      const marginCents = num(entry.marginCents ?? entry.margin_cents, 0);
      const entryCents = num(entry.entryPriceCents ?? entry.entry_price_cents, 0);
      const markCents = num(entry.markPriceCents ?? entry.mark_price_cents, entryCents);
      const liqCents = num(entry.liquidationPriceCents, 0);
      const rawEquity = entry.equityCents ?? entry.equity_cents;
      const pnlCents = rawEquity !== undefined
        ? num(rawEquity, marginCents) - marginCents
        : num(entry.unrealizedPnlCents, 0) - num(entry.accruedFundingCents ?? entry.accrued_funding_cents, 0);
      return {
        marketId: ticker,
        rawSide,
        shares: sizeCents,
        isClosed: str(entry.status, "open") !== "open",
        row: {
          id,
          kind: "perp",
          marketLabel: `$${ticker} Perp`,
          side: rawSide === "long" ? "Long" : "Short",
          quantityLabel: formatPts(sizeCents / 100),
          leverage: num(entry.leverage, 1),
          entryLabel: formatPts(entryCents / 100),
          markLabel: formatPts(markCents / 100),
          pnlPts: pnlCents / 100,
          ...(liqCents > 0 ? { liquidationLabel: formatPts(liqCents / 100) } : {}),
        },
      };
    })
    .filter((p): p is AppPosition => p !== null);

  return [...predPositions, ...perpPositions];
}

export function decodeLeaderboard(raw: unknown): ReadonlyArray<AppLeaderboardEntry> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.leaderboard ?? raw.entries ?? raw.rows) : [];
  return list
    .map((entry, idx): AppLeaderboardEntry | null => {
      if (!isRecord(entry)) return null;
      const accountId = optStr(entry.accountId ?? entry.account_id);
      const handle = optStr(entry.handle);
      if (!accountId && !handle) return null;
      const winRateRaw = num(entry.winRate ?? entry.winRatePct, 0);
      const winRatePct = winRateRaw <= 1 && winRateRaw > 0 ? Math.round(winRateRaw * 100) : Math.round(winRateRaw);
      const balanceCents = num(entry.balanceCents ?? entry.balance_cents, 0);
      const positionValueCents = num(entry.positionValueCents ?? entry.position_value_cents, 0);
      const equityCents = num(entry.equityCents ?? entry.equity_cents, balanceCents + positionValueCents);
      const startingGrantCents = num(entry.startingGrantCents ?? entry.starting_grant_cents, 10000);
      const netProfitCents = num(entry.netProfitCents ?? entry.net_profit_cents, Math.round(num(entry.netProfitPts, 0) * 100));
      const tradeCount = num(entry.tradeCount ?? entry.trade_count, 0);
      const wins = num(entry.wins, 0);
      const settledCount = num(entry.settledCount ?? entry.settled_count, 0);
      const roiPct = typeof entry.roiPct === "number"
        ? entry.roiPct
        : startingGrantCents > 0
          ? (netProfitCents / startingGrantCents) * 100
          : 0;
      const avatarUrl = optStr(entry.avatarUrl ?? entry.avatar_url);
      return {
        rank: num(entry.rank, idx + 1),
        accountId: accountId ?? handle ?? String(idx + 1),
        displayName: str(entry.displayName ?? entry.display_name, handle ?? accountId ?? "Trader"),
        handle: handle ?? accountId ?? "trader",
        ...(avatarUrl ? { avatarUrl } : {}),
        isNpc: bool(entry.isNpc, false),
        netProfitPts: num(entry.netProfitPts, netProfitCents / 100),
        winRatePct,
        volumePts: num(entry.volumePts, num(entry.volumeCents, 0) / 100),
        roiPct,
        equityPts: equityCents / 100,
        tradeCount,
        balanceCents,
        positionValueCents,
        equityCents,
        startingGrantCents,
        wins,
        settledCount,
      };
    })
    .filter((e): e is AppLeaderboardEntry => e !== null);
}

export function decodeEconomy(raw: unknown): AppEconomyPayload {
  const rec = isRecord(raw) ? raw : {};
  const econRec = isRecord(rec.economy) ? rec.economy : null;
  const economy: AppAccountEconomy | null = econRec
    ? {
        accountId: str(econRec.accountId ?? econRec.account_id, ""),
        balanceCents: num(econRec.balanceCents ?? econRec.balance_cents, 0),
        positionValueCents: num(econRec.positionValueCents ?? econRec.position_value_cents, 0),
        equityCents: num(econRec.equityCents ?? econRec.equity_cents, 0),
        startingGrantCents: num(econRec.startingGrantCents ?? econRec.starting_grant_cents, 10000),
        totalFeesPaidCents: num(econRec.totalFeesPaidCents ?? econRec.total_fees_paid_cents, 0),
        netProfitCents: num(econRec.netProfitCents ?? econRec.net_profit_cents, 0),
      }
    : null;
  const ledger = arr(rec.ledger)
    .map((entry): AppLedgerEntry | null => {
      if (!isRecord(entry)) return null;
      const id = optStr(entry.id);
      if (!id) return null;
      const createdAtMs = num(entry.createdAt ?? entry.created_at, 0);
      return {
        id,
        kind: str(entry.kind, "entry"),
        deltaCents: num(entry.deltaCents ?? entry.delta_cents, 0),
        balanceAfterCents: num(entry.balanceAfterCents ?? entry.balance_after_cents, 0),
        refId: optStr(entry.refId ?? entry.ref_id),
        createdAtMs,
        timestamp: formatTimeLabel(createdAtMs),
      };
    })
    .filter((entry): entry is AppLedgerEntry => entry !== null);
  return { economy, ledger };
}

export function decodeTrendingList(raw: unknown): ReadonlyArray<TrendingItem> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.trending ?? raw.items) : [];
  return list
    .map((t, idx): TrendingItem | null => {
      if (!isRecord(t)) return null;
      const tag = optStr(t.tag ?? t.title);
      if (!tag) return null;
      const kind = str(t.kind, "hashtag");
      const count = num(t.postCount, 0);
      return {
        id: optStr(t.id) ?? `${kind}:${tag}:${idx}`,
        title: tag,
        subtitle: count > 0 ? `${count} posts` : optStr(t.subtitle) ?? undefined,
        ...(optStr(t.metric) ? { metric: optStr(t.metric) ?? undefined } : {}),
        financial: kind === "ticker" || bool(t.financial, false),
      };
    })
    .filter((t): t is TrendingItem => t !== null);
}

export function decodeArticle(raw: unknown): AppArticle | null {
  if (!isRecord(raw)) return null;
  const rec = isRecord(raw.article) ? raw.article : raw;
  const id = optStr(rec.id);
  if (!id) return null;
  const publishedAtMs = num(rec.publishedAt ?? rec.published_at, 0);
  const isProof = bool(rec.isResolutionProof ?? rec.is_resolution_proof, false);
  const orgAvatarUrl = optStr(rec.authorOrgAvatarUrl ?? rec.orgAvatarUrl);
  const coverImageUrl = optStr(rec.imageUrl ?? rec.coverImageUrl);
  const ticker = optStr(rec.ticker);
  return {
    id,
    authorOrgId: optStr(rec.authorOrgId ?? rec.author_org_id),
    title: str(rec.title, "Dispatch"),
    summary: str(rec.summary, ""),
    body: str(rec.body, str(rec.summary, "")),
    source: str(rec.authorOrgName ?? rec.source, "Feed Wire"),
    ...(orgAvatarUrl ? { orgAvatarUrl } : {}),
    ...(coverImageUrl ? { coverImageUrl } : {}),
    category: isProof ? "Resolution Proof" : optStr(rec.category) ?? undefined,
    timestamp: typeof rec.timestamp === "string" ? rec.timestamp : formatTimeLabel(publishedAtMs),
    ...(ticker ? { ticker } : {}),
    relatedMarketId: optStr(rec.relatedMarketId ?? rec.related_market_id),
    isResolutionProof: isProof,
    publishedAtMs,
  };
}

export function decodeArticles(raw: unknown): ReadonlyArray<AppArticle> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.articles ?? raw.items) : [];
  return list.map(decodeArticle).filter((a): a is AppArticle => a !== null);
}

export function decodeExplore(raw: unknown, viewerAccountId?: string | null): ExploreData {
  const rec = isRecord(raw) ? raw : {};
  const trending = decodeTrendingList(rec.trending);
  const articles = decodeArticles(rec.articles);

  const searchRec = isRecord(rec.search) ? rec.search : {};
  const posts = decodePosts(searchRec.posts, viewerAccountId);
  const accounts = arr(searchRec.accounts)
    .map((u): ExploreAccountHit | null => {
      if (!isRecord(u)) return null;
      const handle = optStr(u.handle);
      if (!handle) return null;
      return {
        accountId: str(u.accountId, handle),
        handle,
        displayName: str(u.displayName, handle),
        bio: str(u.bio, ""),
        avatarUrl: optStr(u.avatarUrl ?? u.avatar_url),
      };
    })
    .filter((u): u is ExploreAccountHit => u !== null);
  const actors = arr(searchRec.actors)
    .map((a): ExploreActorHit | null => {
      if (!isRecord(a)) return null;
      const username = optStr(a.username);
      if (!username) return null;
      return {
        id: str(a.id, username),
        username,
        name: str(a.name, username),
        tier: str(a.tier, "NPC"),
        description: str(a.description, ""),
        avatarUrl: optStr(a.avatarUrl ?? a.avatar_url ?? a.profileImageUrl),
        isParody: bool(a.isParody, true),
      };
    })
    .filter((a): a is ExploreActorHit => a !== null);
  const organizations = arr(searchRec.organizations)
    .map((o): ExploreOrgHit | null => {
      if (!isRecord(o)) return null;
      const id = optStr(o.id);
      if (!id) return null;
      return {
        id,
        name: str(o.name, id),
        ticker: optStr(o.ticker),
        orgType: str(o.orgType, "org"),
        description: str(o.description, ""),
        avatarUrl: optStr(o.avatarUrl ?? o.avatar_url ?? o.imageUrl),
        initialPriceCents: typeof o.initialPriceCents === "number" ? o.initialPriceCents : null,
      };
    })
    .filter((o): o is ExploreOrgHit => o !== null);

  return { trending, articles, posts, accounts, actors, organizations };
}

function decodeChatMembers(raw: unknown): ReadonlyArray<AppChatMember> {
  return arr(raw)
    .map((m): AppChatMember | null => {
      if (!isRecord(m)) return null;
      const memberId = optStr(m.memberId ?? m.member_id);
      const handle = optStr(m.handle);
      if (!memberId && !handle) return null;
      const rawRole = str(m.role, "member");
      const role: AppChatMember["role"] = rawRole === "owner" ? "owner" : rawRole === "admin" ? "admin" : "member";
      return {
        memberId: memberId ?? handle ?? "",
        memberKind: str(m.memberKind ?? m.member_kind) === "npc" ? "npc" : "user",
        handle: handle ?? memberId ?? "user",
        displayName: str(m.displayName ?? m.display_name, handle ?? memberId ?? "User"),
        avatarUrl: optStr(m.avatarUrl ?? m.avatar_url),
        role,
      };
    })
    .filter((m): m is AppChatMember => m !== null);
}

export function decodeChats(raw: unknown, viewerId: string): ReadonlyArray<AppChatSummary> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.chats ?? raw.items) : [];
  return list
    .map((c): AppChatSummary | null => {
      if (!isRecord(c)) return null;
      const id = optStr(c.id);
      if (!id) return null;
      const rawKind = str(c.kind, "direct");
      const chatType: ChatKind = rawKind === "npc_alpha" || rawKind === "NpcAlpha"
        ? "NpcAlpha"
        : rawKind === "user_group" || rawKind === "group" || rawKind === "UserGroup"
          ? "UserGroup"
          : "Direct";
      const createdBy = str(c.createdBy ?? c.created_by, "");
      const members = decodeChatMembers(c.members);
      const peer = members.find((m) => m.memberId !== viewerId) ?? members[0] ?? null;
      const memberCount = num(c.memberCount, members.length);
      return {
        id,
        chatType,
        title: str(c.title, peer?.displayName ?? "Chat"),
        subtitle: optStr(c.tier) ? `Tier ${str(c.tier)}` : chatType === "Direct" && peer ? `@${peer.handle}` : chatType === "Direct" ? "Direct message" : "Group chat",
        memberCount,
        unreadCount: num(c.unreadCount, 0),
        lastMessagePreview: optStr(c.lastMessagePreview),
        lastMessageAt: typeof c.lastMessageAt === "number" ? c.lastMessageAt : null,
        peerAvatarUrl: peer?.avatarUrl ?? null,
        peerHandle: chatType === "Direct" ? peer?.handle ?? null : null,
        members,
        isOwner: createdBy !== "" && createdBy === viewerId,
        isBlocked: bool(c.isBlocked, false),
      };
    })
    .filter((c): c is AppChatSummary => c !== null);
}

export function decodeChatMessages(raw: unknown, viewerId: string): ReadonlyArray<ChatMessageItem> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.messages ?? raw.items) : [];
  return list
    .map((m): ChatMessageItem | null => {
      if (!isRecord(m)) return null;
      const id = optStr(m.id);
      if (!id) return null;
      const senderId = str(m.senderId ?? m.sender_id, "");
      const senderHandle = str(m.senderHandle ?? m.sender_handle, senderId);
      const createdAtMs = num(m.createdAt ?? m.created_at, 0);
      const senderAvatarUrl = optStr(m.senderAvatarUrl ?? m.sender_avatar_url);
      const reactions = arr(m.reactions)
        .map((r) => {
          if (!isRecord(r)) return null;
          const emoji = optStr(r.emoji);
          if (!emoji) return null;
          return { emoji, count: num(r.count, 1), reacted: bool(r.reactedByViewer ?? r.reacted, false) };
        })
        .filter((r): r is { emoji: string; count: number; reacted: boolean } => r !== null);
      return {
        id,
        senderName: str(m.senderDisplayName ?? m.senderName, senderHandle),
        senderHandle,
        ...(senderAvatarUrl ? { senderAvatarUrl } : {}),
        isNpc: str(m.senderKind ?? m.sender_kind) === "npc" || bool(m.isNpc, false),
        isOwn: senderId !== "" && senderId === viewerId,
        timestamp: typeof m.timestamp === "string" ? m.timestamp : formatTimeLabel(createdAtMs),
        content: str(m.content, ""),
        reactions,
      };
    })
    .filter((m): m is ChatMessageItem => m !== null);
}

export function decodeAlphaInvites(raw: unknown): ReadonlyArray<AppAlphaInvite> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.invites ?? raw.items) : [];
  return list
    .map((inv): AppAlphaInvite | null => {
      if (!isRecord(inv)) return null;
      const id = optStr(inv.id);
      if (!id) return null;
      return {
        id,
        chatId: str(inv.chatId, ""),
        actorHandle: str(inv.actorHandle, "npc"),
        actorDisplayName: str(inv.actorDisplayName, "Character"),
        actorAvatarUrl: optStr(inv.actorAvatarUrl ?? inv.actor_avatar_url),
        chatTitle: str(inv.chatTitle, "Alpha Group"),
        tier: optStr(inv.tier),
        status: str(inv.status, "pending"),
      };
    })
    .filter((inv): inv is AppAlphaInvite => inv !== null && inv.status === "pending");
}

function toNotificationKind(rawKind: string): NotificationKind {
  switch (rawKind) {
    case "mention":
    case "SocialMention":
      return "SocialMention";
    case "like":
    case "repost":
    case "SocialLike":
      return "SocialLike";
    case "follow":
    case "SocialFollow":
      return "SocialFollow";
    case "group_invite":
    case "alpha_invite":
    case "GroupInvite":
      return "GroupInvite";
    case "market_resolved":
    case "MarketResolved":
      return "MarketResolved";
    case "pnl_digest":
    case "PnLDigest":
      return "PnLDigest";
    default:
      return "SocialReply";
  }
}

export function decodeNotifications(raw: unknown): AppNotificationsPayload {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.notifications ?? raw.items) : [];
  const items = list
    .map((n): AppNotification | null => {
      if (!isRecord(n)) return null;
      const id = optStr(n.id);
      if (!id) return null;
      const kind = toNotificationKind(str(n.kind, "reply"));
      const createdAtMs = num(n.createdAt ?? n.created_at, 0);
      const actorName = optStr(n.actorName ?? n.actor_name);
      const actorHandle = optStr(n.actorHandle ?? n.actor_handle);
      const actorAvatarUrl = optStr(n.actorAvatarUrl ?? n.actor_avatar_url);
      const detail = optStr(n.body ?? n.detail);
      const inviteId = optStr(n.inviteId ?? n.invite_id);
      const chatId = optStr(n.chatId ?? n.chat_id);
      const read = bool(n.isRead ?? n.read, false);
      return {
        postId: optStr(n.postId ?? n.post_id),
        marketId: optStr(n.marketId ?? n.market_id),
        chatId,
        inviteId,
        isGameOnly: bool(n.isGameOnly ?? n.is_game_only, kind === "MarketResolved" || kind === "PnLDigest"),
        item: {
          id,
          kind,
          title: str(n.title, "Notification"),
          ...(detail ? { detail } : {}),
          ...(actorName ? { actorName } : {}),
          ...(actorHandle ? { actorHandle } : {}),
          ...(actorAvatarUrl ? { actorAvatarUrl } : {}),
          timestamp: typeof n.timestamp === "string" ? n.timestamp : formatTimeLabel(createdAtMs),
          read,
          invitePending: bool(n.invitePending, kind === "GroupInvite" && Boolean(inviteId) && !read),
        },
      };
    })
    .filter((n): n is AppNotification => n !== null);
  const unreadFallback = items.filter((n) => !n.item.read).length;
  const unreadCount = isRecord(raw) && typeof raw.unreadCount === "number" ? raw.unreadCount : unreadFallback;
  return { items, unreadCount };
}

export function decodeProfileBundle(raw: unknown, viewerAccountId: string | null): AppProfileBundle | null {
  if (!isRecord(raw) || !isRecord(raw.profile)) return null;
  const p = raw.profile;
  const id = optStr(p.id ?? p.accountId);
  const handle = optStr(p.handle);
  if (!id || !handle) return null;
  const activeClient = optStr(p.activeAgentClientName ?? p.connectedClient);
  const balanceCents = typeof p.balanceCents === "number" ? p.balanceCents : null;
  const isOwnProfile = viewerAccountId !== null && viewerAccountId === id;
  const createdAtMs = num(p.createdAt ?? p.created_at, 0);
  const joinedLabel = formatJoinedLabel(createdAtMs);
  const avatarUrl = optStr(p.avatarUrl ?? p.avatar_url);
  const bannerUrl = optStr(p.bannerUrl ?? p.banner_url);
  const bio = optStr(p.bio);
  const actorMetaRaw = isRecord(p.actorMeta) ? p.actorMeta : null;
  const actorMeta: AppProfileActorMeta | null = actorMetaRaw
    ? {
        tier: str(actorMetaRaw.tier, ""),
        affiliations: arr(actorMetaRaw.affiliations).filter((v): v is string => typeof v === "string"),
      }
    : null;
  const orgMetaRaw = isRecord(p.orgMeta) ? p.orgMeta : null;
  const orgMeta: AppProfileOrgMeta | null = orgMetaRaw
    ? {
        ticker: optStr(orgMetaRaw.ticker),
        orgType: str(orgMetaRaw.orgType, "organization"),
      }
    : null;
  return {
    id,
    kind: str(p.kind, "user"),
    postsCount: num(p.postsCount, 0),
    createdAtMs,
    actorMeta,
    orgMeta,
    viewerFollowedBy: bool(p.viewerFollowedBy, false),
    viewerBlockedBy: bool(p.viewerBlockedBy, false),
    tradeCount: typeof p.tradeCount === "number" ? p.tradeCount : null,
    openPositionCount: typeof p.openPositionCount === "number" ? p.openPositionCount : null,
    posts: decodePosts(raw.posts, viewerAccountId),
    postsNextCursor: optStr(raw.nextCursor),
    positions: decodePositions(raw.positions),
    summary: {
      displayName: str(p.displayName, handle),
      handle,
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(bannerUrl ? { bannerUrl } : {}),
      ...(bio ? { bio } : {}),
      ...(joinedLabel ? { joinedLabel } : {}),
      isNpcParody: bool(p.isParody ?? p.isNpcParody, false),
      ...(activeClient ? { connectedClient: activeClient, connectedAgentMark: matchAgentLogo(activeClient) } : {}),
      followersCount: num(p.followersCount, 0),
      followingCount: num(p.followingCount, 0),
      ...(balanceCents !== null ? { balancePts: formatPts(balanceCents / 100) } : {}),
      isFollowing: bool(p.viewerFollows, false),
      isMuted: bool(p.viewerMutes, false),
      isBlocked: bool(p.viewerBlocks, false),
      isOwnProfile,
    },
  };
}

export function decodeFollowList(raw: unknown): ReadonlyArray<AppFollowListEntry> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.items ?? raw.followers ?? raw.following) : [];
  return list
    .map((entry): AppFollowListEntry | null => {
      if (!isRecord(entry)) return null;
      const handle = optStr(entry.handle);
      if (!handle) return null;
      return {
        id: str(entry.id, handle),
        kind: str(entry.kind, "user"),
        handle,
        displayName: str(entry.displayName, handle),
        bio: str(entry.bio, ""),
        avatarUrl: optStr(entry.avatarUrl ?? entry.avatar_url),
        viewerFollows: bool(entry.viewerFollows, false),
        isParody: bool(entry.isParody, false),
      };
    })
    .filter((entry): entry is AppFollowListEntry => entry !== null);
}

export function decodeModerationList(raw: unknown): ReadonlyArray<AppModerationEntry> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.items) : [];
  return list
    .map((entry): AppModerationEntry | null => {
      if (!isRecord(entry)) return null;
      const handle = optStr(entry.handle);
      if (!handle) return null;
      return {
        id: str(entry.id ?? entry.accountId, handle),
        handle,
        displayName: str(entry.displayName, handle),
        avatarUrl: optStr(entry.avatarUrl ?? entry.avatar_url),
        bio: str(entry.bio, ""),
      };
    })
    .filter((entry): entry is AppModerationEntry => entry !== null);
}

function toUiHostId(raw: string): AgentHostId | null {
  const exact = defaultAgentLaunchers.find((l) => l.id === raw)?.id;
  if (exact) return exact;
  switch (raw.toLowerCase()) {
    case "chatgpt":
      return "HostChatGPT";
    case "claude":
      return "HostClaude";
    case "gemini":
      return "HostGemini";
    case "grok":
      return "HostGrok";
    case "perplexity":
      return "HostPerplexity";
    case "muse":
      return "HostMuse";
    case "hermes":
      return "HostHermes";
    case "openclaw":
      return "HostOpenClaw";
    case "cursor":
      return "HostCursor";
    default:
      return null;
  }
}

export function decodeSkillHosts(raw: unknown): AppSkillsPayload {
  const rec = isRecord(raw) ? raw : {};
  const fallbackById = new Map<AgentHostId, AgentHostLauncher>(defaultAgentLaunchers.map((l) => [l.id, l]));
  const parsedHosts: AppHostOption[] = [];
  for (const entry of arr(rec.hosts)) {
    if (!isRecord(entry)) continue;
    const uiId = toUiHostId(str(entry.specHost ?? entry.id, ""));
    if (!uiId) continue;
    const base = fallbackById.get(uiId);
    const launchRaw = str(entry.resolvedLaunchKind ?? entry.launchKind, "CopyPromptFallback");
    const launchKind: AgentHostLauncher["launchKind"] = launchRaw === "PromptDeepLink" || launchRaw === "deep_link"
      ? "PromptDeepLink"
      : launchRaw === "CliOrSchemeInstall" || launchRaw === "cli_or_scheme"
        ? "CliOrSchemeInstall"
        : launchRaw === "PastePromptOnly"
          ? "PastePromptOnly"
          : "CopyPromptFallback";
    const href = optStr(entry.href) ?? undefined;
    parsedHosts.push({
      launcher: {
        id: uiId,
        label: str(entry.label, base?.label ?? uiId),
        ...(base?.mark ? { mark: base.mark } : {}),
        launchKind,
        ...(href ? { href } : {}),
      },
      prompt: str(entry.prompt, defaultSkillPrompt),
      cliCommand: optStr(entry.cliCommand),
      webUrl: optStr(entry.webUrl),
      resolvedLaunchKind: launchRaw,
      notes: str(entry.notes, ""),
    });
  }
  const hosts = parsedHosts.length > 0
    ? parsedHosts
    : defaultAgentLaunchers.map((launcher) => ({
        launcher,
        prompt: defaultSkillPrompt,
        cliCommand: null,
        webUrl: null,
        resolvedLaunchKind: launcher.launchKind,
        notes: "",
      }));
  const skillUrl = str(rec.skillUrl, "https://feed.fun/SKILL.md");
  const mcpUrl = str(rec.mcpUrl, "https://feed.fun/mcp");
  const prompt = hosts[0]?.prompt ?? defaultSkillPrompt;
  return {
    skillUrl,
    mcpUrl,
    skillMarkdown: str(rec.skillMarkdown, ""),
    prompt,
    hosts,
  };
}

export function decodeOAuthConsent(raw: unknown): OAuthConsentInfo | null {
  if (!isRecord(raw)) return null;
  const clientId = optStr(raw.clientId ?? raw.client_id);
  const clientName = optStr(raw.clientName ?? raw.client_name);
  if (!clientId && !clientName) return null;
  const scopeRaw = raw.scopes ?? raw.scope;
  const scopes = Array.isArray(scopeRaw)
    ? scopeRaw.filter((s): s is string => typeof s === "string")
    : typeof scopeRaw === "string"
      ? scopeRaw.trim().split(/\s+/).filter(Boolean)
      : ["read", "social:write", "messages", "trade"];
  return {
    clientId: clientId ?? "",
    clientName: clientName ?? clientId ?? "MCP Client",
    redirectUri: str(raw.redirectUri ?? raw.redirect_uri, ""),
    scopes,
    state: str(raw.state, ""),
    resource: str(raw.resource, "https://feed.fun/mcp"),
    codeChallenge: str(raw.codeChallenge ?? raw.code_challenge, ""),
    codeChallengeMethod: str(raw.codeChallengeMethod ?? raw.code_challenge_method, "S256"),
    responseType: str(raw.responseType ?? raw.response_type, "code"),
    priorGrantClientName: optStr(raw.priorGrantClientName ?? raw.activeAgentClientName),
    error: optStr(raw.error),
  };
}

export function decodeAdminStatus(raw: unknown): AdminStatusData {
  const rec = isRecord(raw) ? raw : {};
  const world = isRecord(rec.worldState) ? rec.worldState : rec;
  const rawSpend = rec.spend ?? rec.spendStatus;
  const spendRec = isRecord(rawSpend) ? rawSpend : {};
  const ticks = arr(rec.ticks ?? rec.tickHealth)
    .map((t): AdminTickRow | null => {
      if (!isRecord(t)) return null;
      const jobName = optStr(t.jobName ?? t.job_name);
      if (!jobName) return null;
      const successAt = num(t.lastSuccessAt ?? t.last_success_at, 0);
      return {
        jobName,
        lastStatus: str(t.lastStatus ?? t.last_status, "unknown"),
        lastError: optStr(t.lastError ?? t.last_error),
        pendingCount: num(t.pendingCount ?? t.pending_count, 0),
        durationMs: num(t.durationMs ?? t.duration_ms, 0),
        lastSuccessLabel: successAt > 0 ? formatTimeLabel(successAt) : "never",
      };
    })
    .filter((t): t is AdminTickRow => t !== null);
  const manualHolds = arr(rec.manualHolds ?? rec.holds)
    .map((h): AdminHoldMarket | null => {
      if (!isRecord(h)) return null;
      const id = optStr(h.id);
      if (!id) return null;
      return {
        id,
        question: str(h.question, id),
        timeframe: str(h.timeframe, "1h"),
        expiresLabel: formatTimeLabel(num(h.expiresAt ?? h.expires_at, 0)),
      };
    })
    .filter((h): h is AdminHoldMarket => h !== null);
  return {
    currentDay: num(world.currentDay ?? world.current_day, 1),
    currentHour: num(world.currentHour ?? world.current_hour, 0),
    phase: str(world.phase, "active"),
    gameRunning: bool(world.gameRunning ?? world.game_running, true),
    ticks,
    spend: {
      utcDay: str(spendRec.utcDay ?? spendRec.utc_day, new Date().toISOString().slice(0, 10)),
      dailyBudgetCents: num(spendRec.dailyBudgetCents, 10000),
      confirmedCents: num(spendRec.confirmedCents, 0),
      reservedCents: num(spendRec.reservedCents, 0),
      carryoverReservedCents: num(spendRec.carryoverReservedCents, 0),
      committedCents: num(spendRec.committedCents, 0),
      remainingCents: num(spendRec.remainingCents, 10000),
      throttleLevel: str(spendRec.throttleLevel, "ThrottleNormal"),
      maxStepsAllowed: num(spendRec.maxStepsAllowed, 4),
      effectiveBatchSize: num(spendRec.effectiveBatchSize, 6),
    },
    manualHolds,
  };
}
