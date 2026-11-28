// spec/app/index.md, "Application shell state and single-agent grant tracking"; spec/app/gameplayJourney.md, "Story: Walk the full Feed gameplay loop from visitor to settlement"
import {
  type AgentConnectCardProps,
  type AgentHostId,
  type AgentHostLauncher,
  type AgentLogoKey,
  type ArticleItem,
  type AssetTradeEntry,
  type ChatKind,
  type ChatMessageItem,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardScope,
  type LightweightChartPoint,
  type MarketCardData,
  type NotificationItem,
  type NotificationKind,
  type PositionRowData,
  type PostCardData,
  type PredictionMarketPhase,
  type ProfileSummary,
  type ToastTone,
  type TradeTicketPerpPreview,
  type TrendingItem,
  type UiMode,
  type WalletClosedPosition,
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
  readonly replyPostId?: string;
}

export interface ViewerSession {
  readonly accountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly phoneLast2: string | null;
  readonly phoneVerifiedAt: number | null;
  readonly emailMasked: string | null;
  readonly emailVerifiedAt: number | null;
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
  readonly emailAuthEnabled: boolean;
  readonly devEmailLinkEnabled: boolean;
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
  readonly yesShares: number;
  readonly noShares: number;
  readonly liquidityCents: number;
  readonly volumeCents: number;
  readonly expiresAtMs: number;
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

export interface AppMarketHistoryPoint {
  readonly id: string;
  readonly recordedAt: number;
  readonly priceCents: number;
  readonly yesPriceBps: number | null;
  readonly markPriceCents: number | null;
  readonly volumeCents: number;
}

export interface AppPerpPreview extends TradeTicketPerpPreview {
  readonly ticker: string;
  readonly side: "long" | "short";
  readonly action: string;
  readonly collateralCents: number;
  readonly sizeCents: number;
  readonly leverage: number;
  readonly totalDebitCents: number;
  readonly indexPriceCents: number;
  readonly preMarkPriceCents: number;
  readonly fundingRateBps: number;
}

export interface AppPosition {
  readonly row: PositionRowData;
  readonly marketId: string;
  readonly rawSide: "yes" | "no" | "long" | "short";
  readonly shares: number;
  readonly wholeShares: number;
  readonly costBasisCents: number;
  readonly marginCents: number;
  readonly sizeCents: number;
  readonly grossSizeCents: number;
  readonly leverage: number;
  readonly entryPriceCents: number;
  readonly markPriceCents: number;
  readonly liquidationPriceCents: number;
  readonly unrealizedPnlCents: number;
  readonly pnlPct: number;
  readonly avgPricePct: number;
  readonly currentPricePct: number;
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

export interface AppLeaderboardPage {
  readonly scope: LeaderboardScope;
  readonly metric: LeaderboardMetric;
  readonly entries: ReadonlyArray<AppLeaderboardEntry>;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly page: number;
  readonly pageSize: number;
  readonly currentUser: AppLeaderboardEntry | null;
}

export interface AppLeaderboardPosition {
  readonly rank: number;
  readonly page: number;
  readonly totalCount: number;
  readonly totalPages: number;
  readonly entry: AppLeaderboardEntry;
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
  readonly viewerFollows: boolean;
}

export interface ExploreActorHit {
  readonly id: string;
  readonly username: string;
  readonly name: string;
  readonly tier: string;
  readonly description: string;
  readonly avatarUrl: string | null;
  readonly isParody: boolean;
  readonly viewerFollows: boolean;
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

export interface SearchTagResult {
  readonly tag: string;
  readonly kind: "hashtag" | "ticker";
  readonly postCount: number;
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
  readonly tags: ReadonlyArray<SearchTagResult>;
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
  readonly chatKind: "user_group" | "npc_alpha";
  readonly isAlpha: boolean;
  readonly actorHandle: string;
  readonly actorDisplayName: string;
  readonly actorAvatarUrl: string | null;
  readonly chatTitle: string;
  readonly tier: string | null;
  readonly status: string;
}

export type AppNotificationEventKind =
  | NotificationKind
  | "ChatMessage"
  | "SocialRepost";

export interface AppNotification {
  readonly item: NotificationItem;
  readonly eventKind: AppNotificationEventKind;
  readonly actorIsVerified: boolean;
  readonly postId: string | null;
  readonly marketId: string | null;
  readonly marketKind: "perp" | "prediction" | null;
  readonly ticker: string | null;
  readonly chatId: string | null;
  readonly inviteId: string | null;
  readonly isGameOnly: boolean;
}

export function isNotificationVisibleInMode(n: AppNotification, mode: UiMode): boolean {
  return mode !== "SocialMode" || (!n.isGameOnly && n.item.kind !== "MarketResolved" && n.item.kind !== "PnLDigest");
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

export interface DeviceLookupInfo {
  readonly userCode: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly scopes: ReadonlyArray<string>;
  readonly expiresAt: number;
}

export interface AdminReportRow {
  readonly id: string;
  readonly reporterHandle: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly reason: string;
  readonly status: string;
  readonly createdAtLabel: string;
}

export interface AdminUserRow {
  readonly accountId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly uiMode: "game" | "social";
  readonly balanceCents: number;
  readonly isAdmin: boolean;
  readonly isReviewer: boolean;
  readonly phoneVerifiedAt: number | null;
  readonly emailVerifiedAt: number | null;
  readonly emailMasked: string | null;
  readonly createdAtLabel: string;
}

export interface AdminWorldFactRow {
  readonly id: string;
  readonly factText: string;
  readonly category: string;
  readonly createdAtLabel: string;
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
  | { readonly kind: "trade_prediction"; readonly marketId: string; readonly action: "Buy" | "Sell"; readonly side: "yes" | "no"; readonly amountPts: number; readonly shareUnits?: number; readonly label: string }
  | { readonly kind: "trade_perp"; readonly ticker: string; readonly side: "long" | "short"; readonly marginPts: number; readonly leverage: number; readonly label: string }
  | { readonly kind: "persist_mode"; readonly mode: "game" | "social"; readonly label: string }
  | { readonly kind: "switch_tab"; readonly tab: "latest" | "following" | "top"; readonly label: string }
  | { readonly kind: "navigate"; readonly path: string; readonly label: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function num(value: unknown, fallback = 0): number {
  return parseFiniteNumber(value) ?? fallback;
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
  const month = MONTH_NAMES[d.getMonth()] ?? "Jan";
  const hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, "0");
  const period = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${mins} ${period} · ${month} ${d.getDate()}, ${d.getFullYear()}`;
}

export function formatTimeLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec <= 0) return "just now";
  if (diffSec < 60) return `${Math.max(1, diffSec)}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  const day = new Date(ms);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
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

function optNum(value: unknown): number | null {
  return value === null || value === undefined ? null : parseFiniteNumber(value);
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
    phoneVerifiedAt: optNum(raw.phoneVerifiedAt ?? raw.phone_verified_at),
    emailMasked: optStr(raw.emailMasked ?? raw.email_masked),
    emailVerifiedAt: optNum(raw.emailVerifiedAt ?? raw.email_verified_at),
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
    emailAuthEnabled: bool(rec.emailAuthEnabled, true),
    devEmailLinkEnabled: bool(rec.devEmailLinkEnabled, false),
  };
}

function decodeBadgeSparkline(raw: unknown): Array<{ time: number; yesProbability: number }> | undefined {
  const list = arr(raw);
  if (list.length === 0) return undefined;
  const now = Date.now();
  const points: Array<{ time: number; yesProbability: number }> = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (typeof item === "number" && Number.isFinite(item)) {
      const ratio = item > 1 ? item / 100 : item;
      points.push({
        time: now - (list.length - 1 - i) * 60_000,
        yesProbability: Math.min(1, Math.max(0, ratio)),
      });
    } else if (isRecord(item)) {
      const time = num(item.time ?? item.recordedAt ?? item.timestamp, now - (list.length - 1 - i) * 60_000);
      const rawProb =
        item.yesProbability !== undefined
          ? num(item.yesProbability, 0.5)
          : item.yesPrice !== undefined
            ? num(item.yesPrice, 0.5)
            : item.yesPriceBps !== undefined
              ? num(item.yesPriceBps, 5000) / 10000
              : num(item.value, 0.5);
      const ratio = rawProb > 1 ? rawProb / 100 : rawProb;
      points.push({ time, yesProbability: Math.min(1, Math.max(0, ratio)) });
    }
  }
  return points.length > 0 ? points : undefined;
}

function decodeBadgeStatus(raw: unknown, resolvedFlag: boolean): "active" | "resolved" | "cancelled" {
  const lower = str(raw, "").toLowerCase();
  if (lower === "cancelled") return "cancelled";
  if (lower === "resolved" || resolvedFlag) return "resolved";
  return "active";
}

function decodeBadgeResolvedOutcome(raw: unknown): "yes" | "no" | null {
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  const lower = str(raw, "").toLowerCase();
  if (lower === "yes") return "yes";
  if (lower === "no") return "no";
  return null;
}

function decodeMarketBadge(
  badgeRaw: Record<string, unknown> | null,
  ticker: string | null,
  postMarketId: string | null,
  showTradeEmbed: boolean,
): PostCardData["marketBadge"] {
  if (!showTradeEmbed) return undefined;
  if (badgeRaw) {
    const kind = optStr(badgeRaw.kind);
    if (kind === "prediction") {
      const marketId = optStr(badgeRaw.marketId ?? badgeRaw.market_id) ?? postMarketId ?? undefined;
      const question = str(badgeRaw.question ?? badgeRaw.label, "Prediction market");
      const rawOdds =
        typeof badgeRaw.yesPct === "number"
          ? badgeRaw.yesPct
          : typeof badgeRaw.oddsPct === "number"
            ? badgeRaw.oddsPct
            : num(badgeRaw.yesPriceBps, 5000) / 100;
      const oddsPct = Math.min(99, Math.max(1, Math.round(rawOdds)));
      const rawClosesAt = badgeRaw.closesAt ?? badgeRaw.closes_at ?? badgeRaw.expiresAt ?? badgeRaw.expires_at;
      const closesAt =
        typeof rawClosesAt === "string" && rawClosesAt.trim() !== ""
          ? rawClosesAt
          : typeof rawClosesAt === "number" && rawClosesAt > 0
            ? formatCountdown(rawClosesAt)
            : undefined;
      const status = decodeBadgeStatus(badgeRaw.status, bool(badgeRaw.resolved, false));
      const resolvedOutcome = decodeBadgeResolvedOutcome(badgeRaw.resolvedOutcome ?? badgeRaw.resolved_outcome);
      const yesShares = optNum(badgeRaw.yesShares ?? badgeRaw.yes_shares);
      const noShares = optNum(badgeRaw.noShares ?? badgeRaw.no_shares);
      const rawVolPts = optNum(badgeRaw.volumePts ?? badgeRaw.volume_pts);
      const rawVolCents = optNum(badgeRaw.volumeCents ?? badgeRaw.volume_cents);
      const volumePts = rawVolPts ?? (rawVolCents !== null ? rawVolCents / 100 : null);
      const sparkline = decodeBadgeSparkline(badgeRaw.sparkline ?? badgeRaw.history);
      return {
        kind: "prediction",
        ...(marketId ? { marketId } : {}),
        ticker: optStr(badgeRaw.ticker) ?? ticker ?? "",
        label: question,
        oddsPct,
        ...(closesAt ? { closesAt } : {}),
        status,
        resolvedOutcome,
        ...(yesShares !== null && yesShares > 0 ? { yesShares } : {}),
        ...(noShares !== null && noShares > 0 ? { noShares } : {}),
        ...(volumePts !== null && volumePts > 0 ? { volumePts } : {}),
        ...(sparkline ? { sparkline } : {}),
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
        kind: "perp",
        ticker: perpTicker,
        label,
        ...(typeof badgeRaw.changePct === "number" ? { changePct: badgeRaw.changePct } : {}),
      };
    }
    const badgeTicker = str(badgeRaw.ticker, ticker ?? "");
    if (badgeTicker) {
      return {
        kind: "perp",
        ticker: badgeTicker,
        label: str(badgeRaw.label, `Trade $${badgeTicker}`),
        ...(typeof badgeRaw.oddsPct === "number" ? { oddsPct: badgeRaw.oddsPct } : {}),
        ...(typeof badgeRaw.changePct === "number" ? { changePct: badgeRaw.changePct } : {}),
      };
    }
  }
  if (ticker) {
    return {
      kind: "perp",
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
  const quotePostId = optStr(raw.quotePostId ?? raw.quote_post_id);
  const quoteRaw = raw.quotePost;
  const quoteAvatar = isRecord(quoteRaw) ? optStr(quoteRaw.avatarUrl ?? quoteRaw.authorAvatarUrl) : null;
  const quotePost = isRecord(quoteRaw) && (optStr(quoteRaw.id) || bool(quoteRaw.deleted, false))
    ? {
        id: str(quoteRaw.id, quotePostId ?? "deleted"),
        authorDisplayName: str(quoteRaw.authorDisplayName ?? quoteRaw.author_display_name, str(quoteRaw.authorHandle, "")),
        authorHandle: str(quoteRaw.authorHandle ?? quoteRaw.author_handle, ""),
        ...(quoteAvatar ? { authorAvatarUrl: quoteAvatar } : {}),
        isNpcParody: bool(quoteRaw.isParody ?? quoteRaw.isNpcParody, false),
        content: str(quoteRaw.content),
        ...(bool(quoteRaw.deleted, false) ? { deleted: true } : {}),
      }
    : quotePostId
      ? {
          id: quotePostId,
          authorDisplayName: "",
          authorHandle: "",
          isNpcParody: false,
          content: "",
          deleted: true,
        }
      : undefined;
  const marketId = optStr(raw.marketId ?? raw.market_id);
  const ticker = optStr(raw.ticker);
  const showTradeEmbed = bool(raw.showTradeEmbed, true);
  const badgeRaw = isRecord(raw.marketBadge) ? raw.marketBadge : null;
  const marketBadge = decodeMarketBadge(badgeRaw, ticker, marketId, showTradeEmbed);
  const avatarUrl = optStr(raw.avatarUrl ?? raw.authorAvatarUrl);
  const viaClientName = optStr(raw.viaClientName ?? raw.via_client_name);
  const replyToHandle = optStr(raw.replyToHandle ?? raw.reply_to_handle);
  const repostedByHandle = optStr(raw.repostedByHandle ?? raw.reposted_by_handle);
  const repostedByName = optStr(raw.repostedByName ?? raw.reposted_by_name);
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
      ...(repostedByHandle
        ? {
            repostedByHandle,
            repostedBy: { name: repostedByName ?? repostedByHandle, handle: repostedByHandle },
          }
        : {}),
      ...(quotePost ? { quotePost } : {}),
      ...(marketBadge ? { marketBadge } : {}),
      likeCount: num(raw.likeCount ?? raw.like_count, 0),
      repostCount: num(raw.repostCount ?? raw.repost_count, 0),
      replyCount: num(raw.replyCount ?? raw.reply_count, 0),
      liked: bool(raw.likedByViewer ?? raw.liked, false),
      reposted: bool(raw.repostedByViewer ?? raw.reposted, false),
      isOwn: Boolean(viewerAccountId && authorId && viewerAccountId === authorId),
      isFollowingAuthor: bool(raw.isFollowingAuthor ?? raw.viewerFollows ?? raw.viewerFollowsAuthor, false),
      isMutedAuthor: bool(raw.isMutedAuthor ?? raw.viewerMutes, false),
      isBlockedAuthor: bool(raw.isBlockedAuthor ?? raw.viewerBlocks, false),
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
  const rawStatus = str(raw.status, "open");
  const status = bool(raw.resolved, false) && rawStatus !== "cancelled" && rawStatus !== "Cancelled" ? "resolved" : rawStatus;
  const yesPriceBps = num(raw.yesPriceBps ?? raw.yesProbabilityBps, Math.round(num(raw.yesPrice, 0.5) * 10000));
  const noPriceBps = num(raw.noPriceBps ?? raw.noProbabilityBps, 10000 - yesPriceBps);
  const yesShares = num(raw.yesShares ?? raw.yes_shares, 0);
  const noShares = num(raw.noShares ?? raw.no_shares, 0);
  const liquidityCents = num(raw.liquidityCents ?? raw.liquidity_cents, 0);
  const volumeCents = num(raw.volumeCents ?? raw.volume_cents, 0);
  const outcomeRaw = typeof raw.resolvedOutcome === "boolean"
    ? (raw.resolvedOutcome ? "YES" : "NO")
    : str(raw.resolvedOutcome ?? raw.resolved_outcome).toUpperCase();
  const resolvedOutcome = outcomeRaw === "YES" || outcomeRaw === "NO" || outcomeRaw === "CANCELLED" ? outcomeRaw : undefined;
  const expiresAt = num(raw.expiresAt ?? raw.expires_at, 0);
  return {
    description: str(raw.description, ""),
    category: str(raw.category, "markets"),
    status,
    yesPriceBps,
    noPriceBps,
    yesShares,
    noShares,
    liquidityCents,
    volumeCents,
    expiresAtMs: expiresAt,
    resolutionProof: optStr(raw.resolutionProof ?? raw.resolution_proof),
    resolutionArticleId: optStr(raw.resolutionArticleId ?? raw.resolution_article_id),
    card: {
      kind: "prediction",
      id,
      question: str(raw.question, id),
      timeframe: str(raw.timeframe, "1d"),
      phase: toPredictionPhase(status),
      yesOddsPct: Math.min(98, Math.max(2, Math.round(yesPriceBps / 100))),
      liquidityPts: formatPts(liquidityCents / 100),
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
    history,
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

export function decodeMarketPriceHistory(raw: unknown): ReadonlyArray<AppMarketHistoryPoint> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.history ?? raw.points ?? raw.items) : [];
  return list
    .map((entry, idx): AppMarketHistoryPoint | null => {
      if (!isRecord(entry)) return null;
      const recordedAt = num(entry.recordedAt ?? entry.recorded_at ?? entry.time, 0);
      if (recordedAt <= 0) return null;
      const priceCents = num(entry.priceCents ?? entry.price_cents, 0);
      const yesPriceBps = entry.yesPriceBps !== undefined && entry.yesPriceBps !== null
        ? num(entry.yesPriceBps, 5000)
        : entry.yes_price_bps !== undefined && entry.yes_price_bps !== null
          ? num(entry.yes_price_bps, 5000)
          : null;
      const markPriceCents = entry.markPriceCents !== undefined && entry.markPriceCents !== null
        ? num(entry.markPriceCents, priceCents)
        : entry.mark_price_cents !== undefined && entry.mark_price_cents !== null
          ? num(entry.mark_price_cents, priceCents)
          : null;
      return {
        id: optStr(entry.id) ?? `pt-${recordedAt}-${idx}`,
        recordedAt,
        priceCents,
        yesPriceBps,
        markPriceCents,
        volumeCents: num(entry.volumeCents ?? entry.volume_cents, 0),
      };
    })
    .filter((pt): pt is AppMarketHistoryPoint => pt !== null)
    .sort((a, b) => a.recordedAt - b.recordedAt);
}

export function decodeMarketTrades(raw: unknown): ReadonlyArray<AssetTradeEntry> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.trades ?? raw.items) : [];
  return list
    .map((entry, idx): AssetTradeEntry | null => {
      if (!isRecord(entry)) return null;
      const id = optStr(entry.id) ?? `trade-${idx}`;
      const marketKind = str(entry.marketKind ?? entry.market_kind, "perp");
      const rawSide = str(entry.side, "buy").toLowerCase();
      const traderId = str(entry.traderId ?? entry.trader_id, "trader");
      const handle = optStr(entry.traderHandle ?? entry.handle) ?? traderId;
      const displayName = optStr(entry.traderDisplayName ?? entry.displayName) ?? handle;
      const avatarUrl = optStr(entry.traderAvatarUrl ?? entry.avatarUrl);
      const isNpc = str(entry.traderKind ?? entry.trader_kind) === "npc" || bool(entry.isNpc, false);
      const notionalCents = num(entry.notionalCents ?? entry.notional_cents, 0);
      const priceCents = num(entry.priceCents ?? entry.price_cents, 0);
      const sharesOrSize = num(entry.sharesOrSize ?? entry.shares_or_size, 0);
      const createdAt = num(entry.createdAt ?? entry.created_at, 0);
      const bullish = rawSide.includes("long") || rawSide.includes("yes") || rawSide === "buy";
      const actionLabel = rawSide.replace(/_/gu, " ").toUpperCase();
      const priceLabel = marketKind === "prediction"
        ? `${Math.max(1, Math.min(99, Math.round(priceCents)))}%`
        : formatPts(priceCents / 100);
      return {
        id,
        displayName,
        handle,
        ...(avatarUrl ? { avatarUrl } : {}),
        isNpc,
        actionLabel,
        tone: bullish ? "ok" : "destructive",
        amountPts: notionalCents / 100,
        priceLabel,
        ...(marketKind === "prediction" && sharesOrSize > 0 ? { shares: sharesOrSize / 100 } : {}),
        timeAgoLabel: createdAt > 0 ? formatTimeLabel(createdAt) : "just now",
      };
    })
    .filter((entry): entry is AssetTradeEntry => entry !== null);
}

export function decodePerpPreview(raw: unknown): AppPerpPreview | null {
  if (!isRecord(raw)) return null;
  const rec = isRecord(raw.preview) ? raw.preview : raw;
  const ticker = optStr(rec.ticker);
  if (!ticker) return null;
  const entryPriceCents = num(rec.executionPriceCents ?? rec.entryPriceCents, 0);
  const liquidationPriceCents = num(rec.estimatedLiquidationPriceCents ?? rec.liquidationPriceCents, 0);
  return {
    ticker,
    side: str(rec.side, "long").toLowerCase() === "short" ? "short" : "long",
    action: str(rec.action, "open"),
    collateralCents: num(rec.collateralCents, 0),
    sizeCents: num(rec.sizeCents, 0),
    leverage: num(rec.leverage, 1),
    feeCents: num(rec.feeCents, 0),
    totalDebitCents: num(rec.totalDebitCents, 0),
    indexPriceCents: num(rec.indexPriceCents, 0),
    preMarkPriceCents: num(rec.preMarkPriceCents, entryPriceCents),
    entryPriceCents,
    liquidationPriceCents,
    priceImpactBps: num(rec.priceImpactBps, 0),
    fundingRateBps: num(rec.fundingRateBps, 0),
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
      const grossCents = num(entry.grossEstimatedValueCents, estCents > 0 ? estCents + Math.ceil(estCents / 999) : estCents);
      const sidePriceBps = rawSide === "yes" ? num(entry.yesPriceBps, 5000) : num(entry.noPriceBps, 5000);
      const wholeShares = shares / 100;
      const unrealizedPnlCents = estCents - costCents;
      const avgPricePct = wholeShares > 0 ? Math.min(99, Math.max(1, (costCents / wholeShares))) : Math.round(sidePriceBps / 100);
      const currentPricePct = Math.min(99, Math.max(1, sidePriceBps / 100));
      const pnlPct = costCents > 0 ? (unrealizedPnlCents / costCents) * 100 : 0;
      return {
        marketId,
        rawSide,
        shares,
        wholeShares,
        costBasisCents: costCents,
        marginCents: costCents,
        sizeCents: estCents,
        grossSizeCents: grossCents,
        leverage: 1,
        entryPriceCents: Math.round(avgPricePct),
        markPriceCents: Math.round(currentPricePct),
        liquidationPriceCents: 0,
        unrealizedPnlCents,
        pnlPct,
        avgPricePct,
        currentPricePct,
        isClosed: entry.settledAt !== null && entry.settledAt !== undefined,
        row: {
          id: `pred:${marketId}:${rawSide}`,
          kind: "prediction",
          marketLabel: str(entry.question, marketId),
          side: rawSide === "yes" ? "YES" : "NO",
          quantityLabel: `${wholeShares.toFixed(2)} shares`,
          entryLabel: `${Math.round(avgPricePct)}%`,
          markLabel: `${Math.round(sidePriceBps / 100)}%`,
          pnlPts: unrealizedPnlCents / 100,
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
      const leverage = num(entry.leverage, 1);
      const entryCents = num(entry.entryPriceCents ?? entry.entry_price_cents, 0);
      const markCents = num(entry.markPriceCents ?? entry.mark_price_cents, entryCents);
      const liqCents = num(entry.liquidationPriceCents, 0);
      const rawEquity = entry.equityCents ?? entry.equity_cents;
      const pnlCents = rawEquity !== undefined
        ? num(rawEquity, marginCents) - marginCents
        : num(entry.unrealizedPnlCents, 0) - num(entry.accruedFundingCents ?? entry.accrued_funding_cents, 0);
      const pnlPct = marginCents > 0 ? (pnlCents / marginCents) * 100 : 0;
      return {
        marketId: ticker,
        rawSide,
        shares: sizeCents,
        wholeShares: sizeCents / 100,
        costBasisCents: marginCents,
        marginCents,
        sizeCents,
        grossSizeCents: sizeCents,
        leverage,
        entryPriceCents: entryCents,
        markPriceCents: markCents,
        liquidationPriceCents: liqCents,
        unrealizedPnlCents: pnlCents,
        pnlPct,
        avgPricePct: 0,
        currentPricePct: 0,
        isClosed: str(entry.status, "open") !== "open",
        row: {
          id,
          kind: "perp",
          marketLabel: `$${ticker} Perp`,
          side: rawSide === "long" ? "Long" : "Short",
          quantityLabel: formatPts(sizeCents / 100),
          leverage,
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

export function decodeClosedPositions(raw: unknown): ReadonlyArray<WalletClosedPosition> {
  const rec = isRecord(raw) ? raw : {};
  const predRaw = arr(rec.predictionPositions ?? rec.predictions);
  const perpRaw = arr(rec.perpPositions ?? rec.perps);
  const closedPreds = predRaw
    .map((entry, idx): { readonly item: WalletClosedPosition; readonly closedAt: number } | null => {
      if (!isRecord(entry)) return null;
      const marketId = optStr(entry.marketId ?? entry.market_id) ?? `pred-${idx}`;
      const rawSide = str(entry.side, "yes").toLowerCase() === "no" ? "NO" : "YES";
      const costCents = num(entry.costBasisCents ?? entry.cost_basis_cents, 0);
      const realizedPnlCents = num(entry.realizedPnlCents ?? entry.realized_pnl_cents, num(entry.payoutCents, 0) - costCents);
      const settledAt = num(entry.settledAt ?? entry.settled_at, 0);
      return {
        closedAt: settledAt,
        item: {
          id: `closed-pred:${marketId}:${rawSide}:${settledAt}:${idx}`,
          kind: "prediction",
          marketLabel: str(entry.question, marketId),
          side: rawSide,
          realizedPnlPts: realizedPnlCents / 100,
          realizedPnlPct: costCents > 0 ? (realizedPnlCents / costCents) * 100 : 0,
          closedAtLabel: settledAt > 0 ? formatTimeLabel(settledAt) : "Settled",
        },
      };
    })
    .filter((v): v is { readonly item: WalletClosedPosition; readonly closedAt: number } => v !== null);

  const closedPerps = perpRaw
    .map((entry, idx): { readonly item: WalletClosedPosition; readonly closedAt: number } | null => {
      if (!isRecord(entry)) return null;
      const id = optStr(entry.id) ?? `closed-perp-${idx}`;
      const ticker = optStr(entry.ticker) ?? "PERP";
      const rawSide = str(entry.side, "long").toLowerCase() === "short" ? "Short" : "Long";
      const marginCents = num(entry.marginCents ?? entry.margin_cents, 0);
      const realizedPnlCents = num(entry.realizedPnlCents ?? entry.realized_pnl_cents, 0);
      const closedAt = num(entry.closedAt ?? entry.closed_at, 0);
      return {
        closedAt,
        item: {
          id,
          kind: "perp",
          marketLabel: `$${ticker} Perp`,
          side: rawSide,
          realizedPnlPts: realizedPnlCents / 100,
          realizedPnlPct: marginCents > 0 ? (realizedPnlCents / marginCents) * 100 : 0,
          closedAtLabel: closedAt > 0 ? formatTimeLabel(closedAt) : "Closed",
        },
      };
    })
    .filter((v): v is { readonly item: WalletClosedPosition; readonly closedAt: number } => v !== null);

  return [...closedPreds, ...closedPerps]
    .sort((a, b) => b.closedAt - a.closedAt)
    .map((v) => v.item);
}

export function decodeLeaderboardEntry(entry: unknown, fallbackRank = 1): AppLeaderboardEntry | null {
  if (!isRecord(entry)) return null;
  const accountId = optStr(entry.accountId ?? entry.account_id);
  const handle = optStr(entry.handle);
  if (!accountId && !handle) return null;
  const winRatePct = typeof entry.winRatePct === "number"
    ? Math.round(entry.winRatePct)
    : typeof entry.winRateBps === "number"
      ? Math.round(entry.winRateBps / 100)
      : Math.round(num(entry.winRate, 0) * 100);
  const balanceCents = num(entry.balanceCents ?? entry.balance_cents, 0);
  const positionValueCents = num(entry.positionValueCents ?? entry.position_value_cents, 0);
  const equityCents = num(entry.equityCents ?? entry.equity_cents, balanceCents + positionValueCents);
  const startingGrantCents = num(entry.startingGrantCents ?? entry.starting_grant_cents, 10000);
  const netProfitCents = num(entry.netProfitCents ?? entry.net_profit_cents, Math.round(num(entry.netProfitPts, 0) * 100));
  const tradeCount = num(entry.tradeCount ?? entry.trade_count, 0);
  const wins = num(entry.wins, 0);
  const settledCount = num(entry.settledCount ?? entry.settled_count, 0);
  const returnPct = typeof entry.returnPct === "number"
    ? entry.returnPct
    : typeof entry.returnBps === "number"
      ? entry.returnBps / 100
      : typeof entry.roiPct === "number"
        ? entry.roiPct
        : startingGrantCents > 0
          ? (netProfitCents / startingGrantCents) * 100
          : 0;
  const avatarUrl = optStr(entry.avatarUrl ?? entry.avatar_url);
  return {
    rank: num(entry.rank, fallbackRank),
    accountId: accountId ?? handle ?? String(fallbackRank),
    displayName: str(entry.displayName ?? entry.display_name, handle ?? accountId ?? "Trader"),
    handle: handle ?? accountId ?? "trader",
    ...(avatarUrl ? { avatarUrl } : {}),
    isNpc: bool(entry.isNpc, false),
    isFollowing: bool(entry.isFollowing ?? entry.viewerFollows, false),
    netProfitPts: num(entry.netProfitPts, netProfitCents / 100),
    returnPct,
    roiPct: returnPct,
    winRatePct,
    volumePts: num(entry.volumePts, num(entry.volumeCents, 0) / 100),
    equityPts: equityCents / 100,
    tradeCount,
    balanceCents,
    positionValueCents,
    equityCents,
    startingGrantCents,
    wins,
    settledCount,
  };
}

export function decodeLeaderboard(raw: unknown): ReadonlyArray<AppLeaderboardEntry> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.entries ?? raw.leaderboard ?? raw.rows) : [];
  return list
    .map((entry, idx) => decodeLeaderboardEntry(entry, idx + 1))
    .filter((e): e is AppLeaderboardEntry => e !== null);
}

export function decodeLeaderboardPage(
  raw: unknown,
  fallbackScope: LeaderboardScope = "players",
  fallbackMetric: LeaderboardMetric = "net_profit",
): AppLeaderboardPage {
  const rec = isRecord(raw) ? raw : {};
  const entries = decodeLeaderboard(raw);
  const rawScope = str(rec.scope, fallbackScope);
  const scope: LeaderboardScope = rawScope === "characters" ? "characters" : "players";
  const rawMetric = str(rec.metric, fallbackMetric);
  const metric: LeaderboardMetric = rawMetric === "return_pct" || rawMetric === "win_rate" || rawMetric === "volume"
    ? rawMetric
    : "net_profit";
  const page = Math.max(1, num(rec.page, 1));
  const pageSize = Math.max(1, num(rec.pageSize, 25));
  const totalCount = Math.max(entries.length, num(rec.totalCount, entries.length));
  const totalPages = Math.max(1, num(rec.totalPages, Math.ceil(totalCount / pageSize)));
  const currentUser = decodeLeaderboardEntry(rec.currentUser, 1);
  return {
    scope,
    metric,
    entries,
    totalCount,
    totalPages,
    page,
    pageSize,
    currentUser,
  };
}

export function decodeLeaderboardPosition(raw: unknown): AppLeaderboardPosition | null {
  if (!isRecord(raw)) return null;
  const rec = isRecord(raw.position) ? raw.position : raw;
  const entry = decodeLeaderboardEntry(rec.entry ?? rec, num(rec.rank, 1));
  if (!entry) return null;
  const page = Math.max(1, num(rec.page, 1));
  const totalCount = Math.max(1, num(rec.totalCount, 1));
  const totalPages = Math.max(1, num(rec.totalPages, page));
  return {
    rank: num(rec.rank, entry.rank),
    page,
    totalCount,
    totalPages,
    entry,
  };
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
      const rawSubtitle = optStr(t.subtitle)?.replace(/\b1 posts\b/giu, "1 post");
      return {
        id: optStr(t.id) ?? `${kind}:${tag}:${idx}`,
        title: tag,
        subtitle: count > 0 ? `${count} ${count === 1 ? "post" : "posts"}` : rawSubtitle ?? undefined,
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
        viewerFollows: bool(u.viewerFollows ?? u.isFollowing, false),
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
        viewerFollows: bool(a.viewerFollows ?? a.isFollowing, false),
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

  const tags = arr(searchRec.tags)
    .map((t): SearchTagResult | null => {
      if (typeof t === "string" && t.trim() !== "") {
        const trimmed = t.trim();
        const isTicker = trimmed.startsWith("$");
        return {
          tag: trimmed.replace(/^[#$]+/u, ""),
          kind: isTicker ? "ticker" : "hashtag",
          postCount: 0,
        };
      }
      if (isRecord(t)) {
        const rawTag = optStr(t.tag);
        if (!rawTag) return null;
        const kind: "hashtag" | "ticker" = str(t.kind, "") === "ticker" || rawTag.startsWith("$") ? "ticker" : "hashtag";
        return {
          tag: rawTag.replace(/^[#$]+/u, ""),
          kind,
          postCount: num(t.postCount ?? t.post_count, 0),
        };
      }
      return null;
    })
    .filter((t): t is SearchTagResult => t !== null);

  return { trending, articles, posts, accounts, actors, organizations, tags };
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
      const rawKind = str(inv.chatKind ?? inv.chat_kind, bool(inv.isAlpha, true) ? "npc_alpha" : "user_group");
      const chatKind: "user_group" | "npc_alpha" = rawKind === "user_group" ? "user_group" : "npc_alpha";
      const isAlpha = bool(inv.isAlpha, chatKind === "npc_alpha");
      return {
        id,
        chatId: str(inv.chatId, ""),
        chatKind,
        isAlpha,
        actorHandle: str(inv.inviterHandle ?? inv.actorHandle, "user"),
        actorDisplayName: str(inv.inviterDisplayName ?? inv.actorDisplayName, isAlpha ? "Character" : "Member"),
        actorAvatarUrl: optStr(inv.actorAvatarUrl ?? inv.actor_avatar_url),
        chatTitle: str(inv.chatTitle, isAlpha ? "Alpha Group" : "Group Chat"),
        tier: optStr(inv.tier),
        status: str(inv.status, "pending"),
      };
    })
    .filter((inv): inv is AppAlphaInvite => inv !== null && inv.status === "pending");
}

function toNotificationEventKind(rawKind: string): AppNotificationEventKind {
  switch (rawKind) {
    case "mention":
    case "SocialMention":
      return "SocialMention";
    case "like":
    case "SocialLike":
      return "SocialLike";
    case "repost":
    case "SocialRepost":
      return "SocialRepost";
    case "follow":
    case "SocialFollow":
      return "SocialFollow";
    case "group_invite":
    case "alpha_invite":
    case "GroupInvite":
      return "GroupInvite";
    case "chat_message":
    case "ChatMessage":
      return "ChatMessage";
    case "market_resolved":
    case "MarketResolved":
    case "perp_liquidated":
      return "MarketResolved";
    case "pnl_digest":
    case "PnLDigest":
      return "PnLDigest";
    default:
      return "SocialReply";
  }
}

function toUiNotificationKind(eventKind: AppNotificationEventKind): NotificationKind {
  if (eventKind === "SocialRepost") return "SocialLike";
  if (eventKind === "ChatMessage") return "SocialReply";
  return eventKind;
}

export function decodeNotifications(raw: unknown): AppNotificationsPayload {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.notifications ?? raw.items) : [];
  const items = list
    .map((n): AppNotification | null => {
      if (!isRecord(n)) return null;
      const id = optStr(n.id);
      if (!id) return null;
      const eventKind = toNotificationEventKind(str(n.kind, "reply"));
      const kind = toUiNotificationKind(eventKind);
      const createdAtMs = num(n.createdAt ?? n.created_at, 0);
      const actorName = optStr(n.actorName ?? n.actor_name);
      const actorHandle = optStr(n.actorHandle ?? n.actor_handle);
      const actorAvatarUrl = optStr(n.actorAvatarUrl ?? n.actor_avatar_url);
      const actorIsVerified = bool(n.actorIsVerified ?? n.isVerified ?? n.actorIsParody ?? n.isParody, false);
      const detail = optStr(n.body ?? n.detail);
      const inviteId = optStr(n.inviteId ?? n.invite_id);
      const chatId = optStr(n.chatId ?? n.chat_id);
      const marketId = optStr(n.marketId ?? n.market_id);
      const ticker = optStr(n.ticker);
      const rawMarketKind = str(n.marketKind ?? n.market_kind, "").toLowerCase();
      const marketKind: "perp" | "prediction" | null =
        rawMarketKind === "perp"
          ? "perp"
          : rawMarketKind === "prediction"
            ? "prediction"
            : ticker
              ? "perp"
              : marketId
                ? "prediction"
                : null;
      const read = bool(n.isRead ?? n.read, false);
      const inviteStatus = str(n.inviteStatus ?? n.invite_status, "").toLowerCase();
      const invitePending =
        typeof n.invitePending === "boolean"
          ? n.invitePending
          : inviteStatus === "pending";
      return {
        eventKind,
        actorIsVerified,
        postId: optStr(n.postId ?? n.post_id),
        marketId,
        marketKind,
        ticker,
        chatId,
        inviteId,
        isGameOnly: bool(n.isGameOnly ?? n.is_game_only, eventKind === "MarketResolved" || eventKind === "PnLDigest"),
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
          invitePending,
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

function decodeScopeList(scopeRaw: unknown): ReadonlyArray<string> {
  if (Array.isArray(scopeRaw)) return scopeRaw.filter((s): s is string => typeof s === "string");
  if (typeof scopeRaw === "string") return scopeRaw.trim().split(/\s+/u).filter(Boolean);
  return ["read", "social:write", "messages", "trade"];
}

export function decodeOAuthConsent(raw: unknown): OAuthConsentInfo | null {
  if (!isRecord(raw)) return null;
  const clientId = optStr(raw.clientId ?? raw.client_id);
  const clientName = optStr(raw.clientName ?? raw.client_name);
  if (!clientId && !clientName) return null;
  const scopes = decodeScopeList(raw.scopes ?? raw.scope);
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

export interface AppWorldStatus {
  readonly currentDay: number;
  readonly currentHour: number;
  readonly phase: string;
  readonly gameRunning: boolean;
  readonly lastTickAt: number;
  readonly activeMarketsCount: number;
  readonly totalPostsCount: number;
  readonly activeActorsCount: number;
}

export function decodeWorldStatus(raw: unknown): AppWorldStatus | null {
  if (!isRecord(raw)) return null;
  return {
    currentDay: Math.max(1, num(raw.currentDay ?? raw.current_day, 1)),
    currentHour: Math.max(0, num(raw.currentHour ?? raw.current_hour, 0)),
    phase: str(raw.phase, "active"),
    gameRunning: bool(raw.gameRunning ?? raw.game_running, true),
    lastTickAt: Math.max(0, num(raw.lastTickAt ?? raw.last_tick_at, 0)),
    activeMarketsCount: Math.max(0, num(raw.activeMarketsCount ?? raw.active_markets_count, 0)),
    totalPostsCount: Math.max(0, num(raw.totalPostsCount ?? raw.total_posts_count, 0)),
    activeActorsCount: Math.max(0, num(raw.activeActorsCount ?? raw.active_actors_count, 0)),
  };
}

export function decodePnlHistory(raw: unknown): ReadonlyArray<LightweightChartPoint> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.points) : [];
  return list
    .map((pt): LightweightChartPoint | null => {
      if (!isRecord(pt)) return null;
      const time = num(pt.timestamp ?? pt.time, 0);
      if (time <= 0) return null;
      const value = pt.pnlCents !== undefined
        ? num(pt.pnlCents, 0) / 100
        : pt.cumulativePnlCents !== undefined
          ? num(pt.cumulativePnlCents, 0) / 100
          : num(pt.value, 0);
      return { time, value };
    })
    .filter((pt): pt is LightweightChartPoint => pt !== null);
}

export function decodeDeviceLookup(raw: unknown): DeviceLookupInfo | null {
  if (!isRecord(raw)) return null;
  const userCode = optStr(raw.userCode ?? raw.user_code);
  const clientId = optStr(raw.clientId ?? raw.client_id);
  const clientName = optStr(raw.clientName ?? raw.client_name);
  if (!userCode && !clientName) return null;
  const scopes = decodeScopeList(raw.scopes ?? raw.scope);
  return {
    userCode: userCode ?? "",
    clientId: clientId ?? "",
    clientName: clientName ?? clientId ?? "AI Agent",
    scopes,
    expiresAt: num(raw.expiresAt ?? raw.expires_at, 0),
  };
}

export function decodeAdminReports(raw: unknown): ReadonlyArray<AdminReportRow> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.reports ?? raw.items) : [];
  return list
    .map((r): AdminReportRow | null => {
      if (!isRecord(r)) return null;
      const id = optStr(r.id);
      if (!id) return null;
      const createdAtMs = num(r.createdAt ?? r.created_at, 0);
      return {
        id,
        reporterHandle: str(r.reporterHandle ?? r.reporter_handle ?? r.reporterId ?? r.reporter_id, "user"),
        targetKind: str(r.targetKind ?? r.target_kind, "post"),
        targetId: str(r.targetId ?? r.target_id, ""),
        reason: str(r.reason, ""),
        status: str(r.status, "open"),
        createdAtLabel: createdAtMs > 0 ? formatTimeLabel(createdAtMs) : "just now",
      };
    })
    .filter((r): r is AdminReportRow => r !== null);
}

export function decodeAdminUsers(raw: unknown): ReadonlyArray<AdminUserRow> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.users ?? raw.items) : [];
  return list
    .map((u): AdminUserRow | null => {
      if (!isRecord(u)) return null;
      const accountId = optStr(u.accountId ?? u.account_id);
      const handle = optStr(u.handle);
      if (!accountId || !handle) return null;
      const createdAtMs = num(u.createdAt ?? u.created_at, 0);
      return {
        accountId,
        handle,
        displayName: str(u.displayName ?? u.display_name, handle),
        avatarUrl: optStr(u.avatarUrl ?? u.avatar_url),
        uiMode: str(u.uiMode ?? u.ui_mode) === "social" ? "social" : "game",
        balanceCents: num(u.balanceCents ?? u.balance_cents, 0),
        isAdmin: bool(u.isAdmin ?? u.is_admin, false),
        isReviewer: bool(u.isReviewer ?? u.is_reviewer, false),
        phoneVerifiedAt: optNum(u.phoneVerifiedAt ?? u.phone_verified_at),
        emailVerifiedAt: optNum(u.emailVerifiedAt ?? u.email_verified_at),
        emailMasked: optStr(u.emailMasked ?? u.email_masked),
        createdAtLabel: createdAtMs > 0 ? formatTimeLabel(createdAtMs) : "",
      };
    })
    .filter((u): u is AdminUserRow => u !== null);
}

export function decodeAdminWorldFacts(raw: unknown): ReadonlyArray<AdminWorldFactRow> {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.facts ?? raw.items) : [];
  return list
    .map((f): AdminWorldFactRow | null => {
      if (!isRecord(f)) return null;
      const id = optStr(f.id);
      if (!id) return null;
      const createdAtMs = num(f.createdAt ?? f.created_at, 0);
      return {
        id,
        factText: str(f.factText ?? f.fact_text, ""),
        category: str(f.category, "markets"),
        createdAtLabel: createdAtMs > 0 ? formatTimeLabel(createdAtMs) : "",
      };
    })
    .filter((f): f is AdminWorldFactRow => f !== null);
}

export function decodeUsersSearch(raw: unknown): {
  readonly accounts: ReadonlyArray<ExploreAccountHit>;
  readonly actors: ReadonlyArray<ExploreActorHit>;
} {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? arr(raw.items ?? raw.users) : [];
  const accounts: ExploreAccountHit[] = [];
  const actors: ExploreActorHit[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const handle = optStr(item.handle ?? item.username);
    if (!handle) continue;
    const isNpc = bool(item.isNpc, str(item.kind) === "npc");
    if (isNpc) {
      actors.push({
        id: str(item.id, handle),
        username: handle,
        name: str(item.displayName ?? item.name, handle),
        tier: str(item.tier, "NPC"),
        description: str(item.description, ""),
        avatarUrl: optStr(item.avatarUrl ?? item.avatar_url),
        isParody: true,
        viewerFollows: bool(item.viewerFollows ?? item.isFollowing, false),
      });
    } else {
      accounts.push({
        accountId: str(item.id ?? item.accountId, handle),
        handle,
        displayName: str(item.displayName ?? item.name, handle),
        bio: str(item.bio, ""),
        avatarUrl: optStr(item.avatarUrl ?? item.avatar_url),
        viewerFollows: bool(item.viewerFollows ?? item.isFollowing, false),
      });
    }
  }
  return { accounts, actors };
}
