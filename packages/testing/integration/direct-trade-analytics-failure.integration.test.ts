/** PRD §§8.1, 13 / MVP Phase 3: report committed agent actions truthfully. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  agentLogs,
  agentTrades,
  balanceTransactions,
  db,
  eq,
  markets,
  organizationState,
  perpMarketSnapshots,
  perpPositions,
  pointsTransactions,
  positions,
  predictionPriceHistories,
  stockPrices,
  tradingFeeOutbox,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeDirectTrade } from '../../agents/src/autonomous/DirectExecutors';
import { agentPnLService } from '../../agents/src/services/AgentPnLService';

const original = agentPnLService.recordTrade;
for (const scenario of [
  'prediction_buy',
  'prediction_sell',
  'perp_open',
  'perp_add',
  'perp_reduce',
  'perp_opposite_close',
  'perp_flip',
  'perp_close',
] as const) {
  test(`returns the committed ${scenario} outcome when analytics fails`, async () => {
    const uid = await generateSnowflakeId(),
      ticker = 'DOTANA' + crypto.randomUUID().slice(0, 8).toUpperCase(),
      mid = 'dot-analytics-market-' + crypto.randomUUID();
    try {
      await db.insert(users).values({
        id: uid,
        username: 'dot-analytics-' + uid,
        virtualBalance: '10000',
        totalDeposited: '10000',
        lifetimePnL: '0',
        updatedAt: new Date(),
      });
      await db.insert(organizationState).values({
        id: ticker,
        currentPrice: 100,
        basePrice: 100,
        updatedAt: new Date(),
      });
      await db.insert(perpMarketSnapshots).values({
        ticker,
        organizationId: ticker,
        currentPrice: 100,
        high24h: 100,
        low24h: 100,
        openInterest: 0,
        volume24h: 0,
        fundingRate: {
          ticker,
          rate: 0,
          nextFundingTime: new Date().toISOString(),
          predictedRate: 0,
        },
      });
      await db.insert(markets).values({
        id: mid,
        question: 'Synthetic analytics failure acceptance',
        yesShares: '500',
        noShares: '500',
        liquidity: '1000',
        endDate: new Date(Date.now() + 86400000),
        updatedAt: new Date(),
      });
      const prediction = scenario.startsWith('prediction');
      const call = (
        side: Parameters<typeof executeDirectTrade>[0]['side'],
        amount: number
      ) =>
        executeDirectTrade({
          agentUserId: uid,
          marketType: prediction ? 'prediction' : 'perp',
          marketId: prediction ? mid : ticker,
          side,
          amount,
          skipPerpResolution: true,
        });
      if (scenario === 'prediction_sell')
        assert.equal((await call('buy_yes', 100)).success, true);
      if (!prediction && scenario !== 'perp_open')
        assert.equal((await call('open_long', 100)).success, true);
      const beforeLedger = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, uid));
      const beforeTrades = await db
        .select()
        .from(agentTrades)
        .where(eq(agentTrades.agentUserId, uid));
      let attempts = 0;
      agentPnLService.recordTrade = async () => {
        attempts++;
        throw Error('injected analytics failure');
      };
      const side =
        scenario === 'prediction_buy'
          ? 'buy_yes'
          : scenario === 'prediction_sell'
            ? 'sell_yes'
            : scenario === 'perp_close'
              ? 'close_position'
              : ['perp_reduce', 'perp_opposite_close', 'perp_flip'].includes(
                    scenario
                  )
                ? 'open_short'
                : 'open_long';
      const amount = ['prediction_sell', 'perp_close'].includes(scenario)
        ? 0
        : scenario === 'perp_reduce'
          ? 50
          : scenario === 'perp_flip'
            ? 300
            : 100;
      let result: Awaited<ReturnType<typeof executeDirectTrade>> | undefined;
      let error: string | undefined;
      try {
        result = await call(side, amount);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const [user] = await db.select().from(users).where(eq(users.id, uid));
      const perps = await db
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.userId, uid));
      const predictions = await db
        .select()
        .from(positions)
        .where(eq(positions.userId, uid));
      const ledger = await db
        .select()
        .from(balanceTransactions)
        .where(eq(balanceTransactions.userId, uid));
      const trades = await db
        .select()
        .from(agentTrades)
        .where(eq(agentTrades.agentUserId, uid));
      const open = perps.filter((p) => p.closedAt === null);
      console.log(
        'REVIEW_ANALYTICS_DIAGNOSTIC ' +
          JSON.stringify({
            scenario,
            error,
            result,
            attempts,
            ledgerBefore: beforeLedger.length,
            ledgerAfter: ledger.length,
          })
      );
      assert.ok(user);
      assert.equal(ledger.length, beforeLedger.length + 1);
      assert.equal(trades.length, beforeTrades.length);
      if (scenario === 'prediction_buy') {
        assert.ok(Number(predictions[0]?.shares) > 0);
        assert.equal(Number(user.virtualBalance), 9900);
      } else if (scenario === 'prediction_sell') {
        assert.equal(Number(predictions[0]?.shares), 0);
        assert.equal(predictions[0]?.status, 'closed');
      } else if (['perp_close', 'perp_opposite_close'].includes(scenario))
        assert.equal(open.length, 0);
      else {
        assert.equal(open.length, 1);
        assert.ok(open[0]);
        assert.equal(
          open[0].size,
          scenario === 'perp_open' ? 100 : scenario === 'perp_reduce' ? 50 : 200
        );
        assert.equal(open[0].side, scenario === 'perp_flip' ? 'short' : 'long');
      }
      assert.equal(error, undefined);
      assert.equal(result?.success, true);
      assert.equal(attempts, scenario === 'perp_flip' ? 2 : 1);
      console.log(
        'REVIEW_ANALYTICS ' +
          JSON.stringify({
            scenario,
            result,
            error,
            attempts,
            balance: user.virtualBalance,
            ledgerDelta: ledger.length - beforeLedger.length,
            analyticsDelta: trades.length - beforeTrades.length,
            perps: perps.map((p) => ({
              size: p.size,
              side: p.side,
              closed: p.closedAt !== null,
            })),
            predictions: predictions.map((p) => ({
              shares: p.shares,
              status: p.status,
            })),
          })
      );
    } finally {
      agentPnLService.recordTrade = original;
      for (const table of [agentTrades, agentLogs])
        await db.delete(table).where(eq(table.agentUserId, uid));
      for (const table of [
        tradingFeeOutbox,
        tradingFees,
        pointsTransactions,
        balanceTransactions,
        positions,
        perpPositions,
      ])
        await db.delete(table).where(eq(table.userId, uid));
      await db
        .delete(predictionPriceHistories)
        .where(eq(predictionPriceHistories.marketId, mid));
      await db.delete(markets).where(eq(markets.id, mid));
      await db
        .delete(stockPrices)
        .where(eq(stockPrices.organizationId, ticker));
      await db
        .delete(perpMarketSnapshots)
        .where(eq(perpMarketSnapshots.ticker, ticker));
      await db
        .delete(organizationState)
        .where(eq(organizationState.id, ticker));
      await db.delete(users).where(eq(users.id, uid));
    }
  });
}
