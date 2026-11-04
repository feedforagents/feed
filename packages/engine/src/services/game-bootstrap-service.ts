/**
 * Game Bootstrap Service
 *
 * Ensures all game data is properly seeded and synced at tick start.
 * Replaces the need for manual seeding scripts.
 */

import { getSyntheticPerpQuoteState } from '@feed/core/markets/perps';
import {
  actorState,
  and,
  db,
  eq,
  games,
  generateSnowflakeId,
  inArray,
  lt,
  organizationState,
  perpMarketSnapshots,
  pools,
  rssFeedSources,
  sql,
  users,
  withTransaction,
} from '@feed/db';
import type { ActorTier } from '@feed/shared';
import { logger } from '@feed/shared';
import { DEFAULT_RSS_SOURCES } from '../config/rss-sources';
import { CapitalAllocationService } from './capital-allocation-service';
import { realPriceService } from './real-price-service';
import { StaticDataRegistry } from './static-data-registry';

// Minimum balance thresholds by tier
const MINIMUM_BALANCE_BY_TIER: Record<string, number> = {
  S_TIER: 50000,
  A_TIER: 25000,
  B_TIER: 10000,
  C_TIER: 5000,
};

const DEFAULT_MINIMUM_BALANCE = 5000;
const MAX_TOP_UP_AMOUNT = 100000;

/** Funding interval in hours for perpetual markets */
const FUNDING_INTERVAL_HOURS = 8;
/** Funding interval in milliseconds */
const FUNDING_INTERVAL_MS = FUNDING_INTERVAL_HOURS * 60 * 60 * 1000;

export interface GameBootstrapResult {
  actorsCreated: number;
  actorsUpdated: number;
  actorsToppedUp: number;
  npcUsersCreated: number;
  organizationsCreated: number;
  organizationsUpdated: number;
  poolsCreated: number;
  rssFeedsCreated: number;
  perpMarketsCreated: number;
  gameStateInitialized: boolean;
  totalTopUpAmount: number;
}

function createEmptyBootstrapResult(): GameBootstrapResult {
  return {
    actorsCreated: 0,
    actorsUpdated: 0,
    actorsToppedUp: 0,
    npcUsersCreated: 0,
    organizationsCreated: 0,
    organizationsUpdated: 0,
    poolsCreated: 0,
    rssFeedsCreated: 0,
    perpMarketsCreated: 0,
    gameStateInitialized: false,
    totalTopUpAmount: 0,
  };
}

export class GameBootstrapService {
  private static lastBootstrapTime = 0;
  private static BOOTSTRAP_COOLDOWN_MS = 60000;
  /** The bootstrap/full sync currently running in this process, if any. */
  private static inFlight: Promise<GameBootstrapResult> | null = null;

  /**
   * Run `run` after any in-flight bootstrap/sync finishes, and track it as
   * the in-flight operation. Replaces a boolean guard that forceFullSync used
   * to reset while another bootstrap was still running.
   */
  private static runExclusive(
    run: () => Promise<GameBootstrapResult>
  ): Promise<GameBootstrapResult> {
    const previous = this.inFlight;
    const tracked: Promise<GameBootstrapResult> = (async () => {
      // The previous operation's own caller observes its failure.
      if (previous) await previous.catch(() => undefined);
      return run();
    })().finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return tracked;
  }

  private static getFirstPositivePrice(
    ...candidates: Array<number | null | undefined>
  ): number | null {
    for (const candidate of candidates) {
      if (
        typeof candidate === 'number' &&
        Number.isFinite(candidate) &&
        candidate > 0
      ) {
        return candidate;
      }
    }
    return null;
  }

  private static async resolveCanonicalOrganizationSeedPrice(org: {
    id: string;
    initialPrice: number | null;
  }): Promise<number> {
    return (
      this.getFirstPositivePrice(
        realPriceService.getBasePriceForOrg(org.id),
        org.initialPrice
      ) ?? 100
    );
  }

  static async bootstrapIfNeeded(): Promise<GameBootstrapResult | null> {
    // Check if we've bootstrapped (successfully) recently
    if (Date.now() - this.lastBootstrapTime < this.BOOTSTRAP_COOLDOWN_MS) {
      return null;
    }

    // Prevent concurrent bootstrapping
    if (this.inFlight) {
      return null;
    }

    const result = await this.runExclusive(() => this.runBootstrap()).catch(
      (error: Error) => {
        logger.error(
          'Game bootstrap failed',
          { error: error.message },
          'GameBootstrapService'
        );
        throw error;
      }
    );
    // Start the cooldown only after success so a failed bootstrap can retry
    // immediately.
    this.lastBootstrapTime = Date.now();
    return result;
  }

  private static async runBootstrap(): Promise<GameBootstrapResult> {
    const result = createEmptyBootstrapResult();

    // Get static data from registry (no file loading needed)
    const staticActors = StaticDataRegistry.getAllActors();
    const staticOrgs = StaticDataRegistry.getAllOrganizations();

    // Get existing database state from state tables
    const [existingActorStates, existingOrgStates] = await Promise.all([
      db.select({ id: actorState.id }).from(actorState),
      db.select({ id: organizationState.id }).from(organizationState),
    ]);
    const existingActorIds = new Set(existingActorStates.map((a) => a.id));
    const existingOrgIds = new Set(existingOrgStates.map((o) => o.id));

    // 1. Sync actor states (only dynamic data)
    for (const actor of staticActors) {
      if (
        !existingActorIds.has(actor.id) &&
        (await this.seedActorState(actor))
      ) {
        result.actorsCreated++;
      }
    }

    // 2. Sync organization states (only dynamic data)
    for (const org of staticOrgs) {
      if (
        !existingOrgIds.has(org.id) &&
        (await this.seedOrganizationState(org))
      ) {
        result.organizationsCreated++;
      }
    }

    await this.runSharedBootstrapSteps(result, staticActors);

    // Log summary if anything changed
    const hasChanges =
      result.actorsCreated > 0 ||
      result.actorsToppedUp > 0 ||
      result.npcUsersCreated > 0 ||
      result.organizationsCreated > 0 ||
      result.poolsCreated > 0 ||
      result.rssFeedsCreated > 0 ||
      result.perpMarketsCreated > 0 ||
      result.gameStateInitialized;

    if (hasChanges) {
      logger.info('Game bootstrap complete', result, 'GameBootstrapService');
    }

    return result;
  }

  /** Steps shared by bootstrapIfNeeded and forceFullSync. */
  private static async runSharedBootstrapSteps(
    result: GameBootstrapResult,
    staticActors: Array<{ id: string; name: string }>
  ): Promise<void> {
    // Ensure minimum balances
    const topUpResult = await this.ensureMinimumBalances();
    result.actorsToppedUp = topUpResult.count;
    result.totalTopUpAmount = topUpResult.totalAmount;

    // Ensure pools exist
    result.poolsCreated = await this.ensureActorPools();

    // Ensure NPC User records exist (for wallet/payout operations)
    result.npcUsersCreated = await this.ensureNpcUsers(staticActors);

    // Ensure game state exists
    result.gameStateInitialized = await this.ensureGameState();

    // Ensure RSS feeds
    result.rssFeedsCreated = await this.ensureRSSFeeds();

    // Ensure perp market snapshots exist for all tradeable organizations
    result.perpMarketsCreated = await this.ensurePerpMarketSnapshots();
  }

  static async forceFullSync(): Promise<GameBootstrapResult> {
    const result = await this.runExclusive(() => this.runFullSync());
    this.lastBootstrapTime = Date.now();
    return result;
  }

  private static async runFullSync(): Promise<GameBootstrapResult> {
    const result = createEmptyBootstrapResult();

    // Get static data from registry
    const staticActors = StaticDataRegistry.getAllActors();
    const staticOrgs = StaticDataRegistry.getAllOrganizations();

    // Sync all actor states (update existing, create missing)
    for (const actor of staticActors) {
      const syncResult = await this.syncActorState(actor);
      if (syncResult.created) result.actorsCreated++;
      if (syncResult.updated) result.actorsUpdated++;
    }

    // Sync all organization states
    for (const org of staticOrgs) {
      const syncResult = await this.syncOrganizationState(org);
      if (syncResult.created) result.organizationsCreated++;
      if (syncResult.updated) result.organizationsUpdated++;
    }

    await this.runSharedBootstrapSteps(result, staticActors);

    logger.info('Force full sync complete', result, 'GameBootstrapService');
    return result;
  }

  private static async seedActorState(actor: {
    id: string;
    name: string;
    tier: ActorTier | null;
    domain: string[];
  }): Promise<boolean> {
    const capital = CapitalAllocationService.calculateCapital({
      id: actor.id,
      name: actor.name,
      description: undefined,
      domain: actor.domain,
      tier: actor.tier ?? undefined,
    });

    // Conflict-safe: another process may seed the same actor concurrently.
    const inserted = await db
      .insert(actorState)
      .values({
        id: actor.id,
        tradingBalance: capital.tradingBalance.toString(),
        reputationPoints: capital.reputationPoints,
        hasPool: false,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: actorState.id })
      .returning({ id: actorState.id });

    if (inserted.length > 0) {
      logger.debug(
        `Seeded actor state ${actor.name} with $${capital.tradingBalance}`,
        { actorId: actor.id },
        'GameBootstrapService'
      );
    }
    return inserted.length > 0;
  }

  private static async syncActorState(actor: {
    id: string;
    name: string;
    tier: ActorTier | null;
    domain: string[];
  }): Promise<{ created: boolean; updated: boolean }> {
    const existing = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState)
      .where(eq(actorState.id, actor.id))
      .limit(1);

    if (existing.length === 0) {
      const created = await this.seedActorState(actor);
      return { created, updated: false };
    }

    const existingState = existing[0];
    if (!existingState) return { created: false, updated: false };

    const tier = actor.tier || 'C_TIER';
    const minimumBalance =
      MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;
    const currentBalance = Number(existingState.tradingBalance) || 0;

    // Only raise the balance if below minimum. Conditional + GREATEST so a
    // concurrent trade that changed the balance is never overwritten.
    if (currentBalance < minimumBalance) {
      await db
        .update(actorState)
        .set({
          tradingBalance: sql`GREATEST(${actorState.tradingBalance}, ${minimumBalance})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(actorState.id, actor.id),
            lt(actorState.tradingBalance, minimumBalance.toString())
          )
        );
    }

    return { created: false, updated: true };
  }

  private static async seedOrganizationState(org: {
    id: string;
    name: string;
    initialPrice: number | null;
  }): Promise<boolean> {
    const effectivePrice =
      await this.resolveCanonicalOrganizationSeedPrice(org);

    // Conflict-safe: another process may seed the same org concurrently.
    const inserted = await db
      .insert(organizationState)
      .values({
        id: org.id,
        currentPrice: effectivePrice,
        basePrice: effectivePrice,
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: organizationState.id })
      .returning({ id: organizationState.id });

    if (inserted.length > 0) {
      logger.debug(
        `Seeded organization state ${org.name}`,
        { orgId: org.id, price: effectivePrice },
        'GameBootstrapService'
      );
    }
    return inserted.length > 0;
  }

  private static async syncOrganizationState(org: {
    id: string;
    name: string;
    initialPrice: number | null;
  }): Promise<{ created: boolean; updated: boolean }> {
    const existing = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState)
      .where(eq(organizationState.id, org.id))
      .limit(1);

    if (existing.length === 0) {
      const created = await this.seedOrganizationState(org);
      return { created, updated: false };
    }

    const existingState = existing[0];
    if (!existingState) return { created: false, updated: false };

    const currentPrice =
      typeof existingState.currentPrice === 'number'
        ? existingState.currentPrice
        : Number(existingState.currentPrice);
    const basePrice =
      typeof existingState.basePrice === 'number'
        ? existingState.basePrice
        : Number(existingState.basePrice);

    const hasInvalidCurrentPrice =
      !Number.isFinite(currentPrice) || currentPrice <= 0;
    const hasInvalidBasePrice = !Number.isFinite(basePrice) || basePrice <= 0;

    if (hasInvalidCurrentPrice || hasInvalidBasePrice) {
      const canonicalPrice =
        await this.resolveCanonicalOrganizationSeedPrice(org);
      await db
        .update(organizationState)
        .set({
          currentPrice: hasInvalidCurrentPrice ? canonicalPrice : currentPrice,
          basePrice: hasInvalidBasePrice ? canonicalPrice : basePrice,
          updatedAt: new Date(),
        })
        .where(eq(organizationState.id, org.id));

      logger.warn(
        `Repaired invalid organization state for ${org.name}`,
        {
          orgId: org.id,
          previousCurrentPrice: existingState.currentPrice,
          previousBasePrice: existingState.basePrice,
          canonicalPrice,
        },
        'GameBootstrapService'
      );

      return { created: false, updated: true };
    }

    return { created: false, updated: false };
  }

  private static async ensureMinimumBalances(): Promise<{
    count: number;
    totalAmount: number;
  }> {
    // Get all actor states with their balances
    const allActorStates = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState);

    let toppedUpCount = 0;
    let totalTopUp = 0;

    for (const state of allActorStates) {
      // Get static actor data for tier info
      const staticActor = StaticDataRegistry.getActor(state.id);
      const tier = staticActor?.tier || 'C_TIER';
      const minimumBalance =
        MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;

      // Cheap pre-filter on the snapshot; the deficit itself is recomputed
      // from the row-locked balance so concurrent bootstraps cannot both
      // top up the same actor.
      if ((Number(state.tradingBalance) || 0) >= minimumBalance) continue;

      const topUp = await withTransaction(async (tx) => {
        const [locked] = await tx
          .select({ tradingBalance: actorState.tradingBalance })
          .from(actorState)
          .where(eq(actorState.id, state.id))
          .for('update');
        const currentBalance = Number(locked?.tradingBalance);
        if (!locked || !(currentBalance < minimumBalance)) return null;

        const topUpAmount = Math.min(
          minimumBalance - currentBalance,
          MAX_TOP_UP_AMOUNT
        );
        await tx
          .update(actorState)
          .set({
            tradingBalance: sql`${actorState.tradingBalance} + ${topUpAmount}`,
            updatedAt: new Date(),
          })
          .where(eq(actorState.id, state.id));
        return { currentBalance, topUpAmount };
      });

      if (topUp) {
        toppedUpCount++;
        totalTopUp += topUp.topUpAmount;

        logger.debug(
          `Topped up ${staticActor?.name ?? state.id}: $${topUp.currentBalance} → +$${topUp.topUpAmount}`,
          { actorId: state.id, topUpAmount: topUp.topUpAmount },
          'GameBootstrapService'
        );
      }
    }

    return { count: toppedUpCount, totalAmount: totalTopUp };
  }

  private static async ensureActorPools(): Promise<number> {
    // Get actor states that don't have pools
    const actorStatesWithoutPools = await db
      .select({
        id: actorState.id,
        tradingBalance: actorState.tradingBalance,
      })
      .from(actorState)
      .where(eq(actorState.hasPool, false));

    let created = 0;

    for (const state of actorStatesWithoutPools) {
      const poolId = state.id;
      const balance = Number(state.tradingBalance) || 10000;
      const staticActor = StaticDataRegistry.getActor(state.id);

      const existingPool = await db
        .select({ id: pools.id })
        .from(pools)
        .where(eq(pools.id, poolId))
        .limit(1);

      if (existingPool.length === 0) {
        const inserted = await db
          .insert(pools)
          .values({
            id: poolId,
            name: `${staticActor?.name ?? state.id}'s Pool`,
            npcActorId: state.id,
            totalValue: balance.toString(),
            totalDeposits: balance.toString(),
            availableBalance: balance.toString(),
            lifetimePnL: '0',
            performanceFeeRate: 0.05,
            totalFeesCollected: '0',
            isActive: true,
            status: 'ACTIVE',
            updatedAt: new Date(),
          })
          .onConflictDoNothing({ target: pools.id })
          .returning({ id: pools.id });
        if (inserted.length > 0) created++;
      }

      // The pool exists now (created here, concurrently, or earlier with the
      // flag left false), so reconcile the flag either way.
      await db
        .update(actorState)
        .set({ hasPool: true, updatedAt: new Date() })
        .where(eq(actorState.id, state.id));
    }

    return created;
  }

  /**
   * Ensure User records exist for NPC actors
   * This allows NPCs to receive wallet credits during payouts
   */
  private static async ensureNpcUsers(
    staticActors: Array<{ id: string; name: string }>
  ): Promise<number> {
    if (staticActors.length === 0) {
      return 0;
    }

    const actorIds = staticActors.map((a) => a.id);

    // Get existing NPC users
    const existingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, actorIds));

    const existingUserIds = new Set(existingUsers.map((u) => u.id));

    // Create User records for NPCs that don't have them
    let created = 0;
    const now = new Date();

    for (const actor of staticActors) {
      if (existingUserIds.has(actor.id)) {
        continue;
      }

      await db.insert(users).values({
        id: actor.id,
        displayName: actor.name,
        username: actor.id, // Use actor ID as username
        isActor: true,
        virtualBalance: '10000', // NPCs get starting balance
        totalDeposited: '10000',
        totalWithdrawn: '0',
        lifetimePnL: '0',
        createdAt: now,
        updatedAt: now,
      });

      created++;
    }

    if (created > 0) {
      logger.info(
        `Created ${created} NPC User records`,
        { created },
        'GameBootstrapService'
      );
    }

    return created;
  }

  private static async ensureGameState(): Promise<boolean> {
    const existingGame = await db
      .select()
      .from(games)
      .where(eq(games.isContinuous, true))
      .limit(1);

    if (existingGame.length === 0) {
      const now = new Date();
      const gameId = await generateSnowflakeId();

      await db.insert(games).values({
        id: gameId,
        isContinuous: true,
        isRunning: true,
        currentDate: now,
        currentDay: 1,
        speed: 60000,
        startedAt: now,
        updatedAt: now,
      });

      logger.info('Game state initialized', undefined, 'GameBootstrapService');
      return true;
    }

    // Ensure game is running
    const game = existingGame[0];
    if (game && !game.isRunning) {
      await db
        .update(games)
        .set({
          isRunning: true,
          startedAt: game.startedAt || new Date(),
          pausedAt: null,
        })
        .where(eq(games.id, game.id));
      return true;
    }

    return false;
  }

  /** Seeds rssFeedSources from DEFAULT_RSS_SOURCES (config). WHY config: single place to add/edit feed URLs; runtime enable/disable remains in DB. */
  private static async ensureRSSFeeds(): Promise<number> {
    let created = 0;

    for (const feed of DEFAULT_RSS_SOURCES) {
      const existing = await db
        .select({ id: rssFeedSources.id })
        .from(rssFeedSources)
        .where(eq(rssFeedSources.feedUrl, feed.feedUrl))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(rssFeedSources).values({
          id: await generateSnowflakeId(),
          name: feed.name,
          feedUrl: feed.feedUrl,
          category: feed.category,
          updatedAt: new Date(),
        });
        created++;
      }
    }

    return created;
  }

  /**
   * Ensure perp market snapshots exist for all organizations with tickers.
   * This is required for the perpetual markets to be tradeable.
   */
  private static async ensurePerpMarketSnapshots(): Promise<number> {
    let created = 0;
    let repaired = 0;

    // Get all organizations with tickers (these are tradeable as perps)
    const staticOrgs = StaticDataRegistry.getAllOrganizations();
    const tradeableOrgs = staticOrgs.filter((o) => o.ticker);

    // Get existing perp market snapshots
    const existingSnapshots = await db
      .select({
        ticker: perpMarketSnapshots.ticker,
        currentPrice: perpMarketSnapshots.currentPrice,
        price24hAgo: perpMarketSnapshots.price24hAgo,
        high24h: perpMarketSnapshots.high24h,
        low24h: perpMarketSnapshots.low24h,
        bidPrice: perpMarketSnapshots.bidPrice,
        askPrice: perpMarketSnapshots.askPrice,
        spreadBps: perpMarketSnapshots.spreadBps,
        bidDepth: perpMarketSnapshots.bidDepth,
        askDepth: perpMarketSnapshots.askDepth,
        markPrice: perpMarketSnapshots.markPrice,
        indexPrice: perpMarketSnapshots.indexPrice,
      })
      .from(perpMarketSnapshots);
    const existingByTicker = new Map(
      existingSnapshots.map((snapshot) => [snapshot.ticker, snapshot])
    );

    // Get organization states for current prices
    const orgStates = await db
      .select({
        id: organizationState.id,
        currentPrice: organizationState.currentPrice,
        basePrice: organizationState.basePrice,
      })
      .from(organizationState);
    const stateByOrgId = new Map(orgStates.map((state) => [state.id, state]));

    const now = new Date();
    const nextFundingTime = new Date(
      now.getTime() + FUNDING_INTERVAL_MS
    ).toISOString();

    for (const org of tradeableOrgs) {
      if (!org.ticker) {
        continue;
      }

      const state = stateByOrgId.get(org.id);
      const currentPrice =
        this.getFirstPositivePrice(
          state?.currentPrice,
          state?.basePrice,
          org.initialPrice
        ) ?? (await this.resolveCanonicalOrganizationSeedPrice(org));
      const existingSnapshot = existingByTicker.get(org.ticker);
      const initialQuote = getSyntheticPerpQuoteState({
        ticker: org.ticker,
        organizationId: org.id,
        name: org.name,
        currentPrice,
        price24hAgo: currentPrice,
        change24h: 0,
        changePercent24h: 0,
        high24h: currentPrice,
        low24h: currentPrice,
        volume24h: 0,
        openInterest: 0,
        fundingRate: {
          ticker: org.ticker,
          rate: 0.01,
          nextFundingTime,
          predictedRate: 0.01,
        },
        maxLeverage: 20,
        minOrderSize: 10,
        markPrice: currentPrice,
        indexPrice: currentPrice,
      });

      if (!existingSnapshot) {
        await db.insert(perpMarketSnapshots).values({
          ticker: org.ticker,
          organizationId: org.id,
          name: org.name,
          currentPrice,
          price24hAgo: currentPrice,
          price24hAgoUpdatedAt: now,
          metrics24hResetAt: now,
          change24h: 0,
          changePercent24h: 0,
          high24h: currentPrice,
          low24h: currentPrice,
          volume24h: 0,
          openInterest: 0,
          fundingRate: {
            ticker: org.ticker,
            rate: 0.01, // 1% APR base
            nextFundingTime,
            predictedRate: 0.01,
          },
          maxLeverage: 20,
          minOrderSize: 10,
          bidPrice: initialQuote.bidPrice,
          askPrice: initialQuote.askPrice,
          spreadBps: initialQuote.spreadBps,
          bidDepth: initialQuote.bidDepth,
          askDepth: initialQuote.askDepth,
          liquidityRegime: initialQuote.liquidityRegime,
          quoteUpdatedAt: now,
          markPrice: currentPrice,
          indexPrice: currentPrice,
          createdAt: now,
          updatedAt: now,
        });

        created++;
        logger.debug(
          `Created perp market snapshot for ${org.ticker} (${org.name})`,
          { ticker: org.ticker, price: currentPrice },
          'GameBootstrapService'
        );
        continue;
      }

      const hasInvalidSnapshotPrice =
        !Number.isFinite(Number(existingSnapshot.currentPrice)) ||
        Number(existingSnapshot.currentPrice) <= 0;
      const hasInvalidQuoteState =
        !Number.isFinite(Number(existingSnapshot.bidPrice)) ||
        !Number.isFinite(Number(existingSnapshot.askPrice)) ||
        !Number.isFinite(Number(existingSnapshot.spreadBps)) ||
        !Number.isFinite(Number(existingSnapshot.bidDepth)) ||
        !Number.isFinite(Number(existingSnapshot.askDepth)) ||
        Number(existingSnapshot.bidPrice) <= 0 ||
        Number(existingSnapshot.askPrice) < Number(existingSnapshot.bidPrice) ||
        Number(existingSnapshot.bidDepth) <= 0 ||
        Number(existingSnapshot.askDepth) <= 0;
      const hasInvalidReferenceFields =
        !Number.isFinite(Number(existingSnapshot.price24hAgo)) ||
        Number(existingSnapshot.price24hAgo) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.high24h)) ||
        Number(existingSnapshot.high24h) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.low24h)) ||
        Number(existingSnapshot.low24h) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.markPrice)) ||
        Number(existingSnapshot.markPrice) <= 0 ||
        !Number.isFinite(Number(existingSnapshot.indexPrice)) ||
        Number(existingSnapshot.indexPrice) <= 0;

      if (
        hasInvalidSnapshotPrice ||
        hasInvalidQuoteState ||
        hasInvalidReferenceFields
      ) {
        await db
          .update(perpMarketSnapshots)
          .set({
            currentPrice,
            price24hAgo: currentPrice,
            price24hAgoUpdatedAt: now,
            high24h: currentPrice,
            low24h: currentPrice,
            bidPrice: initialQuote.bidPrice,
            askPrice: initialQuote.askPrice,
            spreadBps: initialQuote.spreadBps,
            bidDepth: initialQuote.bidDepth,
            askDepth: initialQuote.askDepth,
            liquidityRegime: initialQuote.liquidityRegime,
            quoteUpdatedAt: now,
            markPrice: currentPrice,
            indexPrice: currentPrice,
            updatedAt: now,
          })
          .where(eq(perpMarketSnapshots.ticker, org.ticker));

        repaired++;
        logger.warn(
          `Repaired invalid perp market snapshot for ${org.ticker}`,
          { ticker: org.ticker, organizationId: org.id, currentPrice },
          'GameBootstrapService'
        );
      }
    }

    if (created > 0) {
      logger.info(
        `Created ${created} perp market snapshots`,
        { created },
        'GameBootstrapService'
      );
    }

    if (repaired > 0) {
      logger.info(
        `Repaired ${repaired} invalid perp market snapshots`,
        { repaired },
        'GameBootstrapService'
      );
    }

    return created;
  }

  static getMinimumBalance(tier: string): number {
    return MINIMUM_BALANCE_BY_TIER[tier] || DEFAULT_MINIMUM_BALANCE;
  }

  static async getStats(): Promise<{
    actors: number;
    organizations: number;
    pools: number;
    characterMappings: number;
    organizationMappings: number;
    rssFeedSources: number;
    perpMarkets: number;
  }> {
    const [actorCount, orgCount, poolCount, feedCount, perpMarketCount] =
      await Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(actorState),
        db.select({ count: sql<number>`count(*)` }).from(organizationState),
        db.select({ count: sql<number>`count(*)` }).from(pools),
        db.select({ count: sql<number>`count(*)` }).from(rssFeedSources),
        db.select({ count: sql<number>`count(*)` }).from(perpMarketSnapshots),
      ]);

    return {
      actors: Number(actorCount[0]?.count ?? 0),
      organizations: Number(orgCount[0]?.count ?? 0),
      pools: Number(poolCount[0]?.count ?? 0),
      characterMappings: StaticDataRegistry.getAllCharacterMappings().length,
      organizationMappings:
        StaticDataRegistry.getAllOrganizationMappings().length,
      rssFeedSources: Number(feedCount[0]?.count ?? 0),
      perpMarkets: Number(perpMarketCount[0]?.count ?? 0),
    };
  }
}

// Export convenience function for game tick
export async function bootstrapGameIfNeeded(): Promise<GameBootstrapResult | null> {
  return GameBootstrapService.bootstrapIfNeeded();
}
