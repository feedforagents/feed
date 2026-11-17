/**
 * Integration test: autonomous perp trades record what actually executed
 *
 * executeDirectTrade is the retained NPC execution path of the autonomous
 * loop (MultiStepExecutor -> executeDirectTrade). The AgentTrade rows it
 * writes are the agent's trade history, read by the world context prompt, so
 * every row must carry the price the leg executed at and the action that
 * happened: a fresh open, an add, a reduce, a close, or both legs of a flip.
 *
 * Runs the real core service against a real database with a static NPC and
 * its ActorState wallet. Nothing is mocked: a pass-through wrapper on
 * PerpMarketService.openPosition only captures the unmodified result the
 * executor received, so each history row can be compared with it and with
 * the persisted position rows.
 *
 * Run with:
 *   DATABASE_URL="postgresql://feed:feed_dev_password@localhost:5453/feed" \
 *     bun test packages/testing/integration/autonomous-perp-trade-record.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { executeDirectTrade } from '@feed/agents';
import {
  PerpMarketService,
  type PerpTradeResult,
} from '@feed/core/markets/perps';
import {
  actorState,
  agentLogs,
  agentTrades,
  and,
  db,
  eq,
  gte,
  isNull,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  tradingFees,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { calculateUnrealizedPnL } from '@feed/shared';

const TICKER = 'TSLAI';
const NPC_ID = 'ailon-musk';

const org = StaticDataRegistry.getAllOrganizations().find(
  (o) => o.ticker === TICKER
);
if (!org) throw new Error(`Static organization ${TICKER} is missing`);
if (!StaticDataRegistry.getActor(NPC_ID)) {
  throw new Error(`Static NPC ${NPC_ID} is missing`);
}
const seedPrice = org.initialPrice ?? 100;
// A live price far from the static seed price, as after any market tick.
const livePrice = Math.round(seedPrice * 1.5 * 100) / 100;

const testStart = new Date();
let originalSnapshot: typeof perpMarketSnapshots.$inferSelect | undefined;
let originalOrgState: typeof organizationState.$inferSelect | undefined;
let originalActorState: typeof actorState.$inferSelect | undefined;

type HistoryRow = typeof agentTrades.$inferSelect;

const captured: PerpTradeResult[] = [];
const originalOpenPosition = PerpMarketService.prototype.openPosition;

/**
 * Move the live market. The production price impact port anchors fills on
 * the organization's base price, so a market move sets that anchor as well as
 * the snapshot, as the engine's market tick does.
 */
async function setMarketPrice(price: number) {
  await db
    .update(perpMarketSnapshots)
    .set({ currentPrice: price, markPrice: price, indexPrice: price })
    .where(eq(perpMarketSnapshots.ticker, TICKER));
  await db
    .update(organizationState)
    .set({ currentPrice: price, basePrice: price })
    .where(eq(organizationState.id, org!.id));
}

async function openNpcPosition() {
  const [position] = await db
    .select()
    .from(perpPositions)
    .where(
      and(
        eq(perpPositions.userId, NPC_ID),
        eq(perpPositions.ticker, TICKER),
        isNull(perpPositions.closedAt)
      )
    );
  return position;
}

async function positionById(id: string) {
  const [position] = await db
    .select()
    .from(perpPositions)
    .where(eq(perpPositions.id, id));
  return position;
}

/** History rows written by this test, oldest first. */
async function history(): Promise<HistoryRow[]> {
  return db
    .select()
    .from(agentTrades)
    .where(
      and(
        eq(agentTrades.agentUserId, NPC_ID),
        eq(agentTrades.marketType, 'perp'),
        gte(agentTrades.executedAt, testStart)
      )
    )
    .orderBy(agentTrades.executedAt, agentTrades.id);
}

/** Run one autonomous trade and return the real service result it acted on. */
async function trade(
  side: 'open_long' | 'open_short',
  amount: number
): Promise<PerpTradeResult> {
  const before = captured.length;
  const result = await executeDirectTrade({
    agentUserId: NPC_ID,
    marketType: 'perp',
    marketId: TICKER,
    side,
    amount,
    reasoning: 'integration test',
    skipPerpResolution: true,
  });
  expect(result.success).toBe(true);
  expect(captured.length).toBe(before + 1);
  return captured[before]!;
}

describe('autonomous perp trade record (static NPC)', () => {
  beforeAll(async () => {
    PerpMarketService.prototype.openPosition = async function (
      this: PerpMarketService,
      input
    ) {
      const result = await originalOpenPosition.call(this, input);
      captured.push(result);
      return result;
    };

    if (await openNpcPosition()) {
      throw new Error(
        `${NPC_ID} already has an open ${TICKER} position; use a disposable database`
      );
    }

    [originalActorState] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, NPC_ID));
    await db
      .insert(actorState)
      .values({ id: NPC_ID, tradingBalance: '10000', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: actorState.id,
        set: { tradingBalance: '10000', updatedAt: new Date() },
      });

    [originalSnapshot] = await db
      .select()
      .from(perpMarketSnapshots)
      .where(eq(perpMarketSnapshots.ticker, TICKER));
    const now = new Date();
    const fixture = {
      currentPrice: livePrice,
      markPrice: livePrice,
      indexPrice: livePrice,
      high24h: livePrice,
      low24h: livePrice,
      openInterest: 0,
      metrics24hResetAt: now,
      price24hAgoUpdatedAt: now,
    };
    await db
      .insert(perpMarketSnapshots)
      .values({
        ticker: TICKER,
        organizationId: org!.id,
        fundingRate: {
          ticker: TICKER,
          rate: 0,
          nextFundingTime: now.toISOString(),
          predictedRate: 0,
        },
        ...fixture,
      })
      .onConflictDoUpdate({ target: perpMarketSnapshots.ticker, set: fixture });

    [originalOrgState] = await db
      .select()
      .from(organizationState)
      .where(eq(organizationState.id, org!.id));
    const orgFixture = {
      currentPrice: livePrice,
      basePrice: livePrice,
      updatedAt: now,
    };
    await db
      .insert(organizationState)
      .values({ id: org!.id, ...orgFixture })
      .onConflictDoUpdate({ target: organizationState.id, set: orgFixture });
  });

  afterAll(async () => {
    PerpMarketService.prototype.openPosition = originalOpenPosition;
    await db
      .delete(agentTrades)
      .where(
        and(
          eq(agentTrades.agentUserId, NPC_ID),
          gte(agentTrades.executedAt, testStart)
        )
      );
    await db
      .delete(agentLogs)
      .where(
        and(
          eq(agentLogs.agentUserId, NPC_ID),
          gte(agentLogs.createdAt, testStart)
        )
      );
    await db
      .delete(tradingFees)
      .where(
        and(
          eq(tradingFees.userId, NPC_ID),
          gte(tradingFees.createdAt, testStart)
        )
      );
    await db
      .delete(perpPositions)
      .where(
        and(
          eq(perpPositions.userId, NPC_ID),
          eq(perpPositions.ticker, TICKER),
          gte(perpPositions.openedAt, testStart)
        )
      );
    if (originalActorState) {
      await db
        .update(actorState)
        .set(originalActorState)
        .where(eq(actorState.id, NPC_ID));
    } else {
      await db.delete(actorState).where(eq(actorState.id, NPC_ID));
    }
    if (originalSnapshot) {
      await db
        .update(perpMarketSnapshots)
        .set(originalSnapshot)
        .where(eq(perpMarketSnapshots.ticker, TICKER));
    } else {
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, TICKER));
    }
    if (originalOrgState) {
      await db
        .update(organizationState)
        .set(originalOrgState)
        .where(eq(organizationState.id, org!.id));
    } else {
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, org!.id));
    }
  });

  it('records each leg of fresh open, add, reduce, close and flip at its executed price', async () => {
    // 1. Fresh open: LONG 100 at the live market, not the static seed price.
    const open = await trade('open_long', 100);
    expect(open.rebalanceType).toBeUndefined();
    const opened = await openNpcPosition();
    expect(opened).toBeDefined();
    const openEntry = opened!.entryPrice;

    let rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'open',
      side: 'long',
      amount: 100,
    });
    expect(rows[0]!.price).toBeCloseTo(opened!.entryPrice, 8);
    expect(rows[0]!.price).not.toBeCloseTo(seedPrice, 2);

    // 2. Add: LONG 50 after the market moved. The row carries the fill of
    //    the added 50, not the blended position entry.
    await setMarketPrice(livePrice * 1.1);
    const add = await trade('open_long', 50);
    expect(add.rebalanceType).toBe('add');
    const added = await openNpcPosition();
    expect(added!.id).toBe(opened!.id);
    expect(added!.size).toBeCloseTo(150, 6);
    const blendedEntry = added!.entryPrice;
    expect(add.entryPrice).toBeCloseTo(blendedEntry, 8);
    // blendedEntry * 150 = openEntry * 100 + addFill * 50, so the fill of the
    // added 50 is recoverable from the persisted rows alone.
    const addFill = (blendedEntry * 150 - openEntry * 100) / 50;
    expect(Math.abs(addFill - blendedEntry)).toBeGreaterThan(1);

    rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ action: 'open', side: 'long', amount: 50 });
    expect(rows[1]!.price).toBeCloseTo(addFill, 6);
    expect(Math.abs(rows[1]!.price - blendedEntry)).toBeGreaterThan(1);
    expect(Math.abs(rows[1]!.price - openEntry)).toBeGreaterThan(1);
    expect(add.fillPrice).toBeCloseTo(addFill, 6);
    expect(rows[1]!.price).toBeCloseTo(add.fillPrice!, 8);

    // 3. Reduce: SHORT 50 against the 150 LONG closes 50 at the exit price.
    await setMarketPrice(livePrice * 1.2);
    const reduce = await trade('open_short', 50);
    expect(reduce.rebalanceType).toBe('reduce');
    const reduced = await openNpcPosition();
    expect(reduced!.id).toBe(opened!.id);
    expect(reduced!.size).toBeCloseTo(100, 6);
    expect(reduce.size).toBeCloseTo(150 - reduced!.size, 6);
    expect(Math.abs(reduce.exitPrice! - blendedEntry)).toBeGreaterThan(1);
    // The exit price explains the realized PnL on the closed 50.
    expect(reduce.realizedPnL).toBeCloseTo(
      calculateUnrealizedPnL(
        blendedEntry,
        reduce.exitPrice!,
        'long',
        reduce.size
      ).pnl -
        added!.fundingPaid * (reduce.size / 150),
      6
    );

    rows = await history();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ action: 'close', side: 'long' });
    expect(rows[2]!.amount).toBeCloseTo(reduce.size, 8);
    expect(rows[2]!.price).toBeCloseTo(reduce.exitPrice!, 8);
    expect(rows[2]!.pnl).toBeCloseTo(reduce.realizedPnL!, 8);
    expect(Math.abs(rows[2]!.price - blendedEntry)).toBeGreaterThan(1);

    // 4. Close: SHORT 100 against the remaining 100 LONG closes it in full.
    await setMarketPrice(livePrice * 1.3);
    const close = await trade('open_short', 100);
    expect(close.rebalanceType).toBe('close');
    expect(await openNpcPosition()).toBeUndefined();
    const closed = await positionById(opened!.id);
    expect(closed!.closedAt).not.toBeNull();
    expect(close.size).toBeCloseTo(reduced!.size, 6);

    rows = await history();
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ action: 'close', side: 'long' });
    expect(rows[3]!.amount).toBeCloseTo(close.size, 8);
    expect(rows[3]!.price).toBeCloseTo(close.exitPrice!, 8);
    expect(rows[3]!.pnl).toBeCloseTo(close.realizedPnL!, 8);
    expect(Math.abs(rows[3]!.price - blendedEntry)).toBeGreaterThan(1);

    // 5. Fresh open again: LONG 100.
    const reopen = await trade('open_long', 100);
    expect(reopen.rebalanceType).toBeUndefined();
    const second = await openNpcPosition();
    expect(second!.id).not.toBe(opened!.id);
    rows = await history();
    expect(rows).toHaveLength(5);
    expect(rows[4]).toMatchObject({
      action: 'open',
      side: 'long',
      amount: 100,
    });
    expect(rows[4]!.price).toBeCloseTo(second!.entryPrice, 8);

    // 6. Flip: SHORT 250 against the 100 LONG closes the long at its exit and
    //    opens a 150 SHORT at the new entry. Two rows, one per leg.
    await setMarketPrice(livePrice * 1.4);
    const flip = await trade('open_short', 250);
    expect(flip.rebalanceType).toBe('flip');
    const flippedOld = await positionById(second!.id);
    expect(flippedOld!.closedAt).not.toBeNull();
    const flipped = await openNpcPosition();
    expect(flipped!.id).not.toBe(second!.id);
    expect(flipped!.side).toBe('short');
    expect(flipped!.size).toBeCloseTo(150, 6);
    expect(flip.previousSize).toBeCloseTo(100, 6);
    expect(flip.size).toBeCloseTo(150, 6);
    expect(flip.fillPrice).toBeCloseTo(flipped!.entryPrice, 8);
    expect(flip.realizedPnL).toBeCloseTo(flippedOld!.realizedPnL!, 8);

    rows = await history();
    expect(rows).toHaveLength(7);
    const flipRows = rows.slice(5);
    const closeLeg = flipRows.find((r) => r.action === 'close');
    const openLeg = flipRows.find((r) => r.action === 'open');
    expect(closeLeg).toMatchObject({ side: 'long' });
    expect(closeLeg!.amount).toBeCloseTo(100, 6);
    expect(closeLeg!.price).toBeCloseTo(flip.exitPrice!, 8);
    expect(closeLeg!.pnl).toBeCloseTo(flippedOld!.realizedPnL!, 8);
    expect(openLeg).toMatchObject({ side: 'short' });
    expect(openLeg!.amount).toBeCloseTo(150, 6);
    expect(openLeg!.price).toBeCloseTo(flipped!.entryPrice, 8);
    // Both legs now use AMM average fills. They can differ by only a cent;
    // each exact execution price is pinned above, so only require distinct fills.
    expect(Math.abs(openLeg!.price - closeLeg!.price)).toBeGreaterThan(1e-6);
  });
});
