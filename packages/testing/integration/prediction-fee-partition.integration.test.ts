/**
 * Integration Tests: prediction fee partition invariance (PRD §9.1)
 *
 * Runs against a real Postgres database (DATABASE_URL) through the real
 * MCP trade path (PredictionMarketService + FeeService + WalletService),
 * because the invariant under test — "splitting a trade or settlement
 * must never increase the total points credited" — spans pricing, the
 * wallet and the fee ledger and cannot be proven with mocks.
 *
 * Fee policy (PRD §9.1, canonicalTradingFee): a trade's proceeds settle
 * to cents (floored) and the fee is charged on that settled amount,
 * rounded UP to whole cents. Execution, previews and the fee ledger all
 * use that one fee. Under the previous nearest-cent fee, small split
 * legs rounded down to a zero fee: a split sell credited MORE than the
 * whole sale and a split buy received MORE shares. These tests pin the
 * partition invariant, the charged == recorded reconciliation, and the
 * small-trade consequences of the ceiling rule (a 1 pt trade at the
 * 0.1% rate pays 0.01 — an effective 1% — and a sell whose settled
 * proceeds are one cent nets zero after its one-cent fee).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  questions,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import {
  executeBuyShares,
  executeSellShares,
} from '../../mcp/src/handlers/tool-handlers';

const ids: string[] = [];
const marketIds: string[] = [];

async function fixture(
  pool: { yes: number; no: number } = { yes: 5000, no: 5000 }
) {
  const id = await generateSnowflakeId();
  const marketId = await generateSnowflakeId();
  ids.push(id);
  marketIds.push(marketId);
  await dbWrite.insert(users).values({
    id,
    username: `fee-partition-${id}`,
    virtualBalance: '10000',
    totalDeposited: '10000',
    profileComplete: true,
    updatedAt: new Date(),
  });
  await dbWrite.insert(markets).values({
    id: marketId,
    question: 'Fee partition invariance verification',
    yesShares: String(pool.yes),
    noShares: String(pool.no),
    liquidity: '10000',
    endDate: new Date(Date.now() + 86400000),
    updatedAt: new Date(),
  });
  return { id, marketId, agent: { userId: id, agentId: id } };
}

async function balance(userId: string): Promise<number> {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  return Number(user?.virtualBalance);
}

async function totalFeesPaid(userId: string): Promise<number> {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  return Number(user?.totalFeesPaid ?? 0);
}

async function feeRows(userId: string) {
  return dbWrite
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, userId));
}

async function positionOf(userId: string, marketId: string) {
  const [position] = await dbWrite
    .select()
    .from(positions)
    .where(eq(positions.userId, userId));
  if (!position || position.marketId !== marketId) {
    throw new Error('position fixture missing');
  }
  return position;
}

const cents = (v: number) => Math.round(v * 100) / 100;

/** Charged fees (trade results) must equal recorded fees (ledger rows)
 * and the trader's totalFeesPaid, to the cent. */
async function expectReconciled(
  userId: string,
  chargedFees: number[]
): Promise<void> {
  const rows = await feeRows(userId);
  const recorded = cents(rows.reduce((s, r) => s + Number(r.feeAmount), 0));
  const charged = cents(chargedFees.reduce((s, f) => s + f, 0));
  expect(recorded).toBe(charged);
  expect(await totalFeesPaid(userId)).toBe(charged);
  // Every recorded fee splits exactly into platform + referrer shares.
  for (const row of rows) {
    expect(Number(row.platformFee) + Number(row.referrerFee)).toBe(
      Number(row.feeAmount)
    );
  }
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

describe('prediction fee partition invariance (real DB)', () => {
  it('a split sell never credits more than the whole sell, and fees reconcile', async () => {
    // Both users buy 100 on identical pools, then sell 11 shares —
    // small enough that each split leg's gross (≈1.12) sat in the old
    // zero-fee rounding zone. Under the previous nearest-cent fee the
    // 5-leg split credited 5.60 against the whole sale's 5.59 (measured
    // on the pre-fix head); the ceiling rule must not let it win.
    const whole = await fixture();
    const wholeBuy = await executeBuyShares(whole.agent, {
      marketId: whole.marketId,
      outcome: 'YES',
      amount: 100,
    });
    const wholePos = await positionOf(whole.id, whole.marketId);
    const wholeSell = await executeSellShares(whole.agent, {
      positionId: wholePos.id,
      shares: 11,
    });

    const split = await fixture();
    const splitBuy = await executeBuyShares(split.agent, {
      marketId: split.marketId,
      outcome: 'YES',
      amount: 100,
    });
    const splitPos = await positionOf(split.id, split.marketId);
    const splitSells = [];
    for (let i = 0; i < 5; i++) {
      splitSells.push(
        await executeSellShares(split.agent, {
          positionId: splitPos.id,
          shares: 11 / 5,
        })
      );
    }

    const wholeBalance = await balance(whole.id);
    const splitBalance = await balance(split.id);
    // The invariant: splitting must never increase the points credited.
    expect(splitBalance).toBeLessThanOrEqual(wholeBalance);
    // The split pays at least as much total sell fee as the whole sale.
    const wholeSellFee = wholeSell.fee.amount;
    const splitSellFees = splitSells.reduce((s, r) => s + r.fee.amount, 0);
    expect(cents(splitSellFees)).toBeGreaterThanOrEqual(wholeSellFee);
    // Both users sold exactly 11 of their ≈197.84 shares.
    expect(
      Number((await positionOf(split.id, split.marketId)).shares)
    ).toBeCloseTo(
      Number((await positionOf(whole.id, whole.marketId)).shares),
      9
    );

    await expectReconciled(whole.id, [wholeBuy.fee.amount, wholeSellFee]);
    await expectReconciled(split.id, [
      splitBuy.fee.amount,
      ...splitSells.map((r) => r.fee.amount),
    ]);
    // Wallet reconciliation: balance moved by exactly buys and net sells.
    expect(wholeBalance).toBe(cents(10000 - 100 + wholeSell.netProceeds));
    expect(splitBalance).toBe(
      cents(10000 - 100 + splitSells.reduce((s, r) => s + r.netProceeds, 0))
    );
  });

  it('a split buy never receives more shares than the whole buy', async () => {
    const whole = await fixture();
    const wholeBuy = await executeBuyShares(whole.agent, {
      marketId: whole.marketId,
      outcome: 'YES',
      amount: 98,
    });
    expect(wholeBuy.fee.amount).toBe(0.1);

    // 7 legs of 14: under the previous nearest-cent fee each leg paid
    // 0.01 (1.4 cents rounds down), 0.07 total against the whole buy's
    // 0.10, so the split kept more net spend and received MORE shares.
    // Under the ceiling rule each leg pays 0.02 — 0.14 total — so the
    // split must receive strictly fewer shares.
    const split = await fixture();
    let splitShares = 0;
    const splitFees: number[] = [];
    for (let i = 0; i < 7; i++) {
      const leg = await executeBuyShares(split.agent, {
        marketId: split.marketId,
        outcome: 'YES',
        amount: 14,
      });
      splitShares += leg.position.shares;
      splitFees.push(leg.fee.amount);
    }
    expect(cents(splitFees.reduce((s, f) => s + f, 0))).toBe(0.14);
    expect(splitShares).toBeLessThan(wholeBuy.position.shares);
    await expectReconciled(split.id, splitFees);
    await expectReconciled(whole.id, [wholeBuy.fee.amount]);
  });

  it('small sell legs at the rounding threshold each pay and record one cent', async () => {
    // Legs whose gross is ≈4 pt sat in the old zero-fee zone: the
    // nearest-cent fee rounded 0.4 cents down to 0, so none of these
    // legs recorded a fee. Under the ceiling rule each pays exactly
    // one cent and the ledger records it.
    const f = await fixture();
    const buy = await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 100,
    });
    const pos = await positionOf(f.id, f.marketId);
    const sells = [];
    for (let i = 0; i < 6; i++) {
      sells.push(
        await executeSellShares(f.agent, {
          positionId: pos.id,
          shares: 8,
        })
      );
    }
    for (const sell of sells) {
      expect(sell.grossProceeds).toBeGreaterThan(2);
      expect(sell.grossProceeds).toBeLessThan(5);
      expect(sell.fee.amount).toBe(0.01);
    }
    const rows = (await feeRows(f.id)).filter(
      (r) => r.tradeType === 'pred_sell'
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(Number(row.feeAmount)).toBe(0.01);
    await expectReconciled(f.id, [
      buy.fee.amount,
      ...sells.map((r) => r.fee.amount),
    ]);
  });

  it('repeated split round-trips stay reconciled and never beat whole execution', async () => {
    async function run(splitLegs: number) {
      const f = await fixture();
      const charged: number[] = [];
      for (let round = 0; round < 3; round++) {
        const buy = await executeBuyShares(f.agent, {
          marketId: f.marketId,
          outcome: 'YES',
          amount: 25,
        });
        charged.push(buy.fee.amount);
        const pos = await positionOf(f.id, f.marketId);
        const sharesNow = Number(pos.shares);
        if (splitLegs === 1) {
          const sell = await executeSellShares(f.agent, {
            positionId: pos.id,
            shares: sharesNow,
          });
          charged.push(sell.fee.amount);
        } else {
          const per = sharesNow / splitLegs;
          let remaining = sharesNow;
          for (let i = 0; i < splitLegs; i++) {
            const shares = i < splitLegs - 1 ? per : remaining;
            const sell = await executeSellShares(f.agent, {
              positionId: pos.id,
              shares,
            });
            charged.push(sell.fee.amount);
            remaining -= shares;
          }
        }
      }
      return { f, charged };
    }

    const whole = await run(1);
    const split = await run(2);
    expect(await balance(split.f.id)).toBeLessThanOrEqual(
      await balance(whole.f.id)
    );
    await expectReconciled(whole.f.id, whole.charged);
    await expectReconciled(split.f.id, split.charged);
  });

  it('dust proceeds settle to zero with no fee; a one-cent settled sell nets zero after its fee', async () => {
    // Cheap-YES pool: 1 pt buys ≈9.89 shares at ≈0.10 each.
    const f = await fixture({ yes: 9000, no: 1000 });
    const buy = await executeBuyShares(f.agent, {
      marketId: f.marketId,
      outcome: 'YES',
      amount: 1,
    });
    // The minimum 1 pt trade at the 0.1% rate pays a one-cent fee —
    // an effective 1% at this size — and the ledger records it.
    expect(buy.fee.amount).toBe(0.01);
    const pos = await positionOf(f.id, f.marketId);
    const balanceAfterBuy = await balance(f.id);

    // Selling 0.05 shares has gross ≈0.005: it settles to 0.00, so the
    // seller is credited nothing, no fee is charged and no fee row is
    // recorded (processTradingFee skips a zero canonical fee).
    const dust = await executeSellShares(f.agent, {
      positionId: pos.id,
      shares: 0.05,
    });
    expect(dust.fee.amount).toBe(0);
    expect(dust.netProceeds).toBe(0);
    expect(await balance(f.id)).toBe(balanceAfterBuy);
    expect(
      (await feeRows(f.id)).filter((r) => r.tradeType === 'pred_sell')
    ).toHaveLength(0);

    // Selling 0.1 shares has gross ≈0.0100: it settles to exactly one
    // cent, the one-cent ceiling fee consumes it, and the seller nets
    // zero — the documented small-sell consequence of the ceiling rule.
    const tiny = await executeSellShares(f.agent, {
      positionId: pos.id,
      shares: 0.1,
    });
    expect(tiny.fee.amount).toBe(0.01);
    expect(tiny.netProceeds).toBe(0);
    expect(await balance(f.id)).toBe(balanceAfterBuy);
    const sellRows = (await feeRows(f.id)).filter(
      (r) => r.tradeType === 'pred_sell'
    );
    expect(sellRows).toHaveLength(1);
    expect(Number(sellRows[0]?.feeAmount)).toBe(0.01);
    await expectReconciled(f.id, [
      buy.fee.amount,
      dust.fee.amount,
      tiny.fee.amount,
    ]);
  });
});
