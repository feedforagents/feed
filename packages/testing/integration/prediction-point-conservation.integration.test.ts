import { afterAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import { PredictionPricing } from '@feed/core/markets/prediction';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  questions,
  sql,
  tradingFees,
  users,
} from '@feed/db';
import {
  FEE_CONFIG,
  resolveQuestionPayouts,
  withPredictionSettlement,
} from '@feed/engine';
import {
  generateSnowflakeId,
  isPointsAmount,
  PredictionMarketTradeSchema,
} from '@feed/shared';
import {
  executeBuyShares,
  executeSellShares,
} from '../../mcp/src/handlers/tool-handlers';
import {
  validateBuySharesArgs,
  validatePlaceBetArgs,
} from '../../mcp/src/utils/tool-args-validation';

const ids: string[] = [];
const marketIds: string[] = [];
const options = {
  fees: {
    tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
    platformShare: FEE_CONFIG.PLATFORM_SHARE,
    referrerShare: FEE_CONFIG.REFERRER_SHARE,
    minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
  },
};

async function fixture() {
  const id = await generateSnowflakeId(),
    marketId = await generateSnowflakeId();
  ids.push(id);
  marketIds.push(marketId);
  await dbWrite.insert(users).values({
    id,
    username: `precision-${id}`,
    virtualBalance: '1000',
    totalDeposited: '1000',
    profileComplete: true,
    updatedAt: new Date(),
  });
  await dbWrite.insert(markets).values({
    id: marketId,
    question: 'Point conservation verification',
    yesShares: '3000',
    noShares: '7000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    updatedAt: new Date(),
  });
  return { id, marketId, agent: { userId: id, agentId: id } };
}

async function state(f: { id: string; marketId: string }) {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, f.id));
  const [market] = await dbWrite
    .select()
    .from(markets)
    .where(eq(markets.id, f.marketId));
  const [position] = await dbWrite
    .select()
    .from(positions)
    .where(eq(positions.userId, f.id));
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, f.id));
  return {
    balance: Number(user?.virtualBalance),
    pnl: Number(user?.lifetimePnL),
    market,
    position,
    ledger,
  };
}

afterAll(async () => {
  if (marketIds.length) {
    await dbWrite.delete(questions).where(inArray(questions.id, marketIds));
    await dbWrite
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, marketIds));
    await dbWrite
      .delete(positions)
      .where(inArray(positions.marketId, marketIds));
    await dbWrite.delete(markets).where(inArray(markets.id, marketIds));
  }
  if (ids.length) {
    await dbWrite.delete(tradingFees).where(inArray(tradingFees.userId, ids));
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, ids));
    await dbWrite.delete(users).where(inArray(users.id, ids));
  }
});

describe('prediction cash precision with real wallets and ledger', () => {
  it('charges the same prediction fees and settles the same cash through A2A and MCP', async () => {
    const a2a = await fixture();
    const mcp = await fixture();
    const a2aBuy = await FeedAgentExecutor.executeDirectly(
      'markets.buy_shares',
      {
        marketId: a2a.marketId,
        outcome: 'YES',
        amount: 100,
      },
      a2a.id
    );
    await executeBuyShares(mcp.agent, {
      marketId: mcp.marketId,
      outcome: 'YES',
      amount: 100,
    });
    expect(a2aBuy).toMatchObject({
      fee: { amount: 100 * FEE_CONFIG.TRADING_FEE_RATE },
    });
    const a2aOpened = await state(a2a);
    const mcpOpened = await state(mcp);
    expect(a2aOpened.balance).toBe(mcpOpened.balance);
    expect(a2aOpened.position!.shares).toBe(mcpOpened.position!.shares);
    expect(a2aOpened.position!.cashCostBasis).toBe(
      mcpOpened.position!.cashCostBasis
    );
    const sold = await FeedAgentExecutor.executeDirectly(
      'markets.sell_shares',
      {
        positionId: a2aOpened.position!.id,
        shares: Number(a2aOpened.position!.shares),
      },
      a2a.id
    );
    const mcpSold = await executeSellShares(mcp.agent, {
      positionId: mcpOpened.position!.id,
      shares: Number(mcpOpened.position!.shares),
    });
    expect(sold).toMatchObject({
      netProceeds: mcpSold.netProceeds,
      pnl: mcpSold.pnl,
      positionClosed: true,
    });
    const a2aClosed = await state(a2a);
    const mcpClosed = await state(mcp);
    expect(a2aClosed.balance).toBe(mcpClosed.balance);
    expect(a2aClosed.pnl).toBe(mcpClosed.pnl);
    expect(Number(a2aClosed.position!.shares)).toBe(0);
    expect(Number(a2aClosed.position!.cashCostBasis)).toBe(0);
    expect(
      a2aClosed.ledger
        .map((row) => ({ type: row.type, amount: row.amount }))
        .sort((a, b) => a.type.localeCompare(b.type))
    ).toEqual(
      mcpClosed.ledger
        .map((row) => ({ type: row.type, amount: row.amount }))
        .sort((a, b) => a.type.localeCompare(b.type))
    );
  });

  it('rejects the ten-buy rounding exploit at REST, MCP and domain boundaries before spending', async () => {
    const f = await fixture();
    expect(
      PredictionMarketTradeSchema.safeParse({ side: 'yes', amount: 1.0049 })
        .success
    ).toBe(false);
    expect(() =>
      validateBuySharesArgs({
        marketId: f.marketId,
        outcome: 'YES',
        amount: 1.0049,
      })
    ).toThrow();
    expect(() =>
      validatePlaceBetArgs({
        marketId: f.marketId,
        side: 'YES',
        amount: 1.0049,
      })
    ).toThrow();
    for (let index = 0; index < 10; index++) {
      await expect(
        withPredictionSettlement(
          f.marketId,
          { userId: f.id },
          (service) =>
            service.buy({
              userId: f.id,
              marketId: f.marketId,
              side: 'yes',
              amount: 1.0049,
            }),
          options
        )
      ).rejects.toThrow('at most 2 decimal places');
    }
    const after = await state(f);
    expect(after.balance).toBe(1000);
    expect(after.position).toBeUndefined();
    expect(after.ledger).toHaveLength(0);
    expect(Number(after.market?.liquidity)).toBe(10000);
  });

  it('cannot gain points by splitting a sale into ten schema-valid requests', async () => {
    const serial = await fixture(),
      split = await fixture();
    for (const f of [serial, split])
      await executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount: 1,
      });
    const whole = (await state(serial)).position!;
    await executeSellShares(serial.agent, {
      positionId: whole.id,
      shares: Number(whole.shares),
    });
    const opened = (await state(split)).position!;
    for (let index = 0; index < 9; index++)
      await executeSellShares(split.agent, {
        positionId: opened.id,
        shares: 0.01093,
      });
    const remaining = (await state(split)).position!;
    await executeSellShares(split.agent, {
      positionId: remaining.id,
      shares: Number(remaining.shares),
    });
    const a = await state(serial),
      b = await state(split);
    expect(a.balance).toBeLessThanOrEqual(1000);
    expect(b.balance).toBeLessThanOrEqual(a.balance);
    expect(b.position?.status).toBe('closed');
    expect(Number(b.position?.cashCostBasis)).toBe(0);
    expect(b.pnl).toBeCloseTo(b.balance - 1000, 8);
    expect(Number(b.position?.pnl)).toBe(b.pnl);
    expect(a.pnl).toBeCloseTo(a.balance - 1000, 8);
    expect(b.ledger.filter((row) => row.type === 'pred_sell')).toHaveLength(10);
    expect(Number(b.market?.liquidity)).toBeGreaterThanOrEqual(
      Number(a.market?.liquidity)
    );
    for (const row of b.ledger)
      expect(isPointsAmount(Math.abs(Number(row.amount)))).toBe(true);
  });

  it('keeps paid cash and cumulative P&L exact across adds, partial sells and reopening', async () => {
    const f = await fixture();
    for (const amount of [1.29, 2.37])
      await executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount,
      });
    const opened = await state(f);
    expect(Number(opened.position!.cashCostBasis)).toBe(3.66);
    for (let index = 0; index < 2; index++)
      await executeSellShares(f.agent, {
        positionId: opened.position!.id,
        shares: 0.01093,
      });
    const partial = await state(f);
    const spent = 1000 - partial.balance;
    expect(partial.pnl).toBeCloseTo(
      Number(partial.position!.cashCostBasis) - spent,
      8
    );
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 1.11,
    });
    const added = await state(f);
    expect(Number(added.position!.cashCostBasis)).toBeCloseTo(
      Number(partial.position!.cashCostBasis) + 1.11,
      8
    );
    await executeSellShares(f.agent, {
      positionId: added.position!.id,
      shares: Number(added.position!.shares),
    });
    const closed = await state(f);
    expect(closed.pnl).toBeCloseTo(closed.balance - 1000, 8);
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 2.29,
    });
    const reopened = await state(f);
    expect(reopened.position!.id).toBe(opened.position!.id);
    expect(Number(reopened.position!.cashCostBasis)).toBe(2.29);
    await executeSellShares(f.agent, {
      positionId: reopened.position!.id,
      shares: Number(reopened.position!.shares),
    });
    const final = await state(f);
    expect(final.pnl).toBeCloseTo(final.balance - 1000, 8);
    expect(Number(final.position!.pnl)).toBe(final.pnl);
  });

  it('accounts for prior partial sales when resolving either outcome or cancelling', async () => {
    for (const terminal of ['win', 'lose', 'cancel'] as const) {
      const f = await fixture();
      await executeBuyShares(f.agent, {
        marketId: f.marketId,
        outcome: 'YES',
        amount: 1.29,
      });
      const opened = await state(f);
      await executeSellShares(f.agent, {
        positionId: opened.position!.id,
        shares: 0.01093,
      });
      await withPredictionSettlement(
        f.marketId,
        { userId: f.id },
        (service) =>
          terminal === 'cancel'
            ? service.cancel({ marketId: f.marketId }).then(() => undefined)
            : service.resolve({
                marketId: f.marketId,
                winningSide: terminal === 'win' ? 'yes' : 'no',
              }),
        options
      );
      const after = await state(f);
      expect(after.pnl).toBeCloseTo(after.balance - 1000, 8);
      expect(Number(after.position!.pnl)).toBe(after.pnl);
      expect(Number(after.position!.cashCostBasis)).toBe(0);
    }
  });

  it('returns the same rounded proceeds that are credited and leaves the remainder with the house', async () => {
    const f = await fixture();
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 1.29,
    });
    const before = await state(f);
    const quote = PredictionPricing.calculateSellWithFees(
      Number(before.market!.yesShares),
      Number(before.market!.noShares),
      'yes',
      0.01093,
      FEE_CONFIG.TRADING_FEE_RATE
    );
    const sold = await executeSellShares(f.agent, {
      positionId: before.position!.id,
      shares: 0.01093,
    });
    const after = await state(f);
    expect(sold.netProceeds).toBe(quote.netProceeds);
    expect(after.balance - before.balance).toBeCloseTo(quote.netProceeds!, 8);
    expect(Number(after.market!.liquidity)).toBeCloseTo(
      Number(before.market!.liquidity) -
        quote.totalCost +
        (quote.roundingRemainder ?? 0),
      5
    );
    expect(quote.roundingRemainder).toBeGreaterThan(0);
  });

  it('settles cancellation cash and P&L from the actual refund once', async () => {
    const f = await fixture();
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const before = await state(f);
    const cancel = () =>
      withPredictionSettlement(
        f.marketId,
        { userId: f.id },
        (service) =>
          service.cancel({
            marketId: f.marketId,
            reason: 'Precision verification',
          }),
        options
      );
    const result = await cancel();
    const after = await state(f);
    expect(isPointsAmount(result.totalRefunded)).toBe(true);
    expect(after.balance - before.balance).toBeCloseTo(result.totalRefunded, 8);
    expect(after.pnl).toBeCloseTo(after.balance - 1000, 2);
    expect(Number(after.market!.liquidity)).toBeCloseTo(
      Number(before.market!.liquidity) - result.totalRefunded,
      5
    );
    await cancel();
    expect((await state(f)).balance).toBe(after.balance);
  });

  it('records the actual game-tick credit and entry-fee cost without charging a redemption fee', async () => {
    const f = await fixture();
    await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 10,
    });
    const before = await state(f);
    const preview = PredictionPricing.calculateExpectedPayout(
      Number(before.position!.shares),
      Number(before.position!.avgPrice)
    );
    const [maximum] = await dbWrite
      .select({
        value: sql<number>`coalesce(max(${questions.questionNumber}), 0)`,
      })
      .from(questions);
    const questionNumber = Number(maximum?.value ?? 0) + 1;
    await dbWrite.insert(questions).values({
      id: f.marketId,
      marketId: f.marketId,
      questionNumber,
      text: 'Game-tick cash precision',
      scenarioId: 1,
      outcome: true,
      rank: 1,
      resolutionDate: new Date(),
      updatedAt: new Date(),
    });
    await resolveQuestionPayouts(questionNumber);
    const after = await state(f);
    expect(after.balance - before.balance).toBeCloseTo(preview, 8);
    expect(after.pnl).toBeCloseTo(after.balance - 1000, 2);
    expect(
      after.ledger.filter((row) => row.type === 'pred_resolve')
    ).toHaveLength(1);
    expect(after.ledger).toHaveLength(2);
    await resolveQuestionPayouts(questionNumber);
    expect((await state(f)).balance).toBe(after.balance);
  });
});
