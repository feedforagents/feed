/**
 * PRD §§9.1–9.2 / MVP Phase 6: no extra trader credit from partitioning,
 * and actual charged prediction fees reconcile with the persisted ledger.
 * Real MCP handler/service calls use an exclusively owned local child database;
 * this is component accounting evidence, not MCP wire/auth or LLM evidence.
 */
import { afterAll, describe, expect, it, test } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  runIsolatedPredictionFeeCases,
  verifyPredictionFeeChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_PREDICTION_FEE_CHILD) {
  test('runs all seven prediction fee cases in a leased fresh database', async () => {
    await runIsolatedPredictionFeeCases();
  }, 300_000);
} else {
  await verifyPredictionFeeChildLease();
  const leaseFile = process.env.FEED_PREDICTION_FEE_LEASE_FILE;
  if (!leaseFile) throw new Error('Positive child lease file required');
  const receiptPath = join(dirname(leaseFile), 'fixture-receipts.jsonl');
  writeFileSync(receiptPath, '', { flag: 'wx', mode: 0o600 });
  // Import application clients only after the actual database lease is verified.
  const {
    closeDatabase,
    dbWrite,
    eq,
    markets,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    tradingFeeOutbox,
    positions,
    sql,
    tradingFees,
    users,
  } = await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const {
    executeBuyShares: buySharesHandler,
    executeSellShares: sellSharesHandler,
  } = await import('../../mcp/src/handlers/tool-handlers');
  const { z } = await import('zod');
  const buyResult = z.object({
    fee: z.object({ amount: z.number() }),
    position: z.object({ shares: z.number() }),
  });
  const sellResult = z.object({
    fee: z.object({ amount: z.number() }),
    grossProceeds: z.number(),
    netProceeds: z.number(),
  });
  // The public MCP result is a generic JSON record. Validate the real return
  // fields consumed below instead of casting arbitrary JSON to a trade result.
  async function executeBuyShares(
    ...args: Parameters<typeof buySharesHandler>
  ) {
    return buyResult.parse(await buySharesHandler(...args));
  }
  async function executeSellShares(
    ...args: Parameters<typeof sellSharesHandler>
  ) {
    return sellResult.parse(await sellSharesHandler(...args));
  }
  const { PerpDbAdapter, PerpMarketService } = await import(
    '@feed/core/markets/perps'
  );
  const {
    createPerpSettlement,
    createUserWalletAdapter,
    createTradingFeeProcessor,
    createTradingFeeOutboxAdapter,
    createPerpPriceImpactPort,
    FEE_CONFIG,
    FeeService,
  } = await import('@feed/engine');
  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  type FixtureRows = { userRows: string[]; marketRows: string[] };
  async function fixture(
    pool: { yes: number; no: number } = { yes: 5000, no: 5000 },
    requested: { userId?: string; marketId?: string } = {}
  ) {
    const id = requested.userId ?? (await generateSnowflakeId());
    const marketId = requested.marketId ?? (await generateSnowflakeId());
    const username = `fee-partition-${await generateSnowflakeId()}`;
    const endDate = new Date(Date.now() + 86400000).toISOString();
    // One SQL statement: either both successful RETURNING rows commit or neither
    // does. A Market collision must not leave a partially acquired User behind.
    const rows = await dbWrite.execute<FixtureRows>(sql`
      WITH acquired_user AS (
        INSERT INTO public."User" (id, username, "virtualBalance", "totalDeposited", "profileComplete", "updatedAt")
        VALUES (${id}, ${username}, 10000, 10000, true, now())
        RETURNING id, to_jsonb("User")::text AS canonical
      ), acquired_market AS (
        INSERT INTO public."Market" (id, question, "yesShares", "noShares", liquidity, "endDate", "updatedAt")
        SELECT ${marketId}, 'Fee partition invariance verification', ${String(pool.yes)}::numeric,
          ${String(pool.no)}::numeric, 10000, ${endDate}::timestamp, now()
        FROM acquired_user
        RETURNING id, to_jsonb("Market")::text AS canonical
      )
      SELECT ARRAY(SELECT canonical FROM acquired_user) AS "userRows",
        ARRAY(SELECT canonical FROM acquired_market) AS "marketRows"
    `);
    // Persist actual complete physical SQL RETURNING tuples immediately, before
    // count/identity assertions; no generated ID is adopted for row deletion.
    appendFileSync(
      receiptPath,
      JSON.stringify({ status: 'COMMITTED_ATOMIC_RETURNING', rows }) + '\n'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userRows).toHaveLength(1);
    expect(rows[0]?.marketRows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.userRows[0] ?? '{}').id).toBe(id);
    expect(JSON.parse(rows[0]?.marketRows[0] ?? '{}').id).toBe(marketId);
    return { id, marketId, agent: { userId: id, agentId: id } };
  }
  async function canonical(table: 'User' | 'Market', id: string) {
    if (table === 'User') {
      const [row] = await dbWrite
        .select({ value: sql<string>`to_jsonb(${users})::text` })
        .from(users)
        .where(eq(users.id, id));
      return row?.value;
    }
    const [row] = await dbWrite
      .select({ value: sql<string>`to_jsonb(${markets})::text` })
      .from(markets)
      .where(eq(markets.id, id));
    return row?.value;
  }
  async function expectCollision(
    operation: () => Promise<object>,
    constraint: string
  ) {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const cause = error.cause;
      const pgError = cause instanceof Error ? cause : error;
      if (
        !('code' in pgError) ||
        pgError.code !== '23505' ||
        !('constraint_name' in pgError) ||
        pgError.constraint_name !== constraint
      )
        throw error;
      return;
    }
    throw new Error('Expected the actual PostgreSQL unique violation');
  }

  async function balance(userId: string): Promise<number> {
    const [user] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, userId));
    return Number(user?.virtualBalance);
  }

  async function totalFeesPaid(userId: string): Promise<number> {
    const [user] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, userId));
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

  describe('prediction fee partition invariance (real DB)', () => {
    it('seeded legacy subcent perp full close reconciles quote charge ledger and cash', async () => {
      // Explicit persisted legacy state, not evidence that a new sub-minimum
      // order is allowed. All rows belong to this positively leased child.
      const f = await fixture();
      const ticker = `DUST${(await generateSnowflakeId()).slice(-10)}`;
      const positionId = await generateSnowflakeId();
      const now = new Date();
      const remember = (table: string, rows: object[]) =>
        appendFileSync(
          receiptPath,
          JSON.stringify({ status: 'LEGACY_SETUP_RETURNING', table, rows }) +
            '\n'
        );
      const org = await dbWrite
        .insert(organizationState)
        .values({
          id: ticker,
          currentPrice: 100,
          basePrice: 100,
          updatedAt: now,
        })
        .returning({
          canonical: sql<string>`to_jsonb(${organizationState})::text`,
        });
      remember('OrganizationState', org);
      expect(org).toHaveLength(1);
      const market = await dbWrite
        .insert(perpMarketSnapshots)
        .values({
          ticker,
          organizationId: ticker,
          currentPrice: 100,
          high24h: 100,
          low24h: 100,
          minOrderSize: 10,
          openInterest: 0.009,
          volume24h: 0,
          fundingRate: {
            ticker,
            rate: 0,
            predictedRate: 0,
            nextFundingTime: now.toISOString(),
          },
        })
        .returning({
          canonical: sql<string>`to_jsonb(${perpMarketSnapshots})::text`,
        });
      remember('PerpMarketSnapshot', market);
      expect(market).toHaveLength(1);
      const legacy = await dbWrite
        .insert(perpPositions)
        .values({
          id: positionId,
          userId: f.id,
          ticker,
          organizationId: ticker,
          side: 'long',
          entryPrice: 100,
          currentPrice: 100,
          size: 0.009,
          leverage: 1,
          liquidationPrice: 10,
          unrealizedPnL: 0,
          unrealizedPnLPercent: 0,
          fundingPaid: 0,
          lastUpdated: now,
        })
        .returning({
          canonical: sql<string>`to_jsonb(${perpPositions})::text`,
        });
      remember('PerpPosition', legacy);
      expect(legacy).toHaveLength(1);
      const service = new PerpMarketService({
        db: new PerpDbAdapter(),
        settlement: createPerpSettlement(),
        wallet: createUserWalletAdapter(),
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
        priceImpact: createPerpPriceImpactPort(),
        feeProcessor: createTradingFeeProcessor(),
        tradingFeeOutbox: createTradingFeeOutboxAdapter(),
      });
      const quote = await service.previewOrder({
        userId: f.id,
        ticker,
        side: 'short',
        size: 0.009,
        leverage: 1,
      });
      const closed = await service.closePosition({ userId: f.id, positionId });
      const recorded = await feeRows(f.id);
      const intents = await dbWrite
        .select()
        .from(tradingFeeOutbox)
        .where(eq(tradingFeeOutbox.userId, f.id));
      const [persisted] = await dbWrite
        .select()
        .from(perpPositions)
        .where(eq(perpPositions.id, positionId));
      const cashAfter = await balance(f.id);
      const marginPaid = closed.marginPaid;
      const pnlProof =
        typeof marginPaid === 'number'
          ? await dbWrite.execute<{
              stored: string;
              expected: string;
              matches: boolean;
              userCanonical: string;
            }>(sql`
            SELECT u."lifetimePnL"::text AS stored,
              ${String(-marginPaid)}::numeric(18,2)::text AS expected,
              u."lifetimePnL" = ${String(-marginPaid)}::numeric(18,2) AS matches,
              to_jsonb(u)::text AS "userCanonical"
            FROM public."User" u WHERE u.id=${f.id}
          `)
          : [];
      appendFileSync(
        receiptPath,
        JSON.stringify({
          status: 'OBSERVED_LEGACY_CLOSE_BEFORE_ASSERTIONS',
          quote,
          closed,
          recorded,
          intents,
          persisted,
          cashAfter,
          pnlProof,
        }) + '\n'
      );
      expect(quote.estimatedFee).toBe(0);
      expect(quote.estimatedCloseSettlement).toBe(0);
      expect(closed.feePaid).toBe(0);
      expect(FeeService.calculateFee(0.009).feeAmount).toBe(0);
      expect(recorded).toHaveLength(0);
      expect(intents).toHaveLength(0);
      expect(await totalFeesPaid(f.id)).toBe(0);
      expect(persisted).toBeDefined();
      expect(persisted?.closedAt).not.toBeNull();
      // Wallet PnL uses the floored net credit minus margin. The SQL cast is
      // the existing user-ledger cent precision, not gross position/API PnL.
      expect(pnlProof[0]?.matches).toBe(true);
      // The fee waiver cannot permit the wallet's cent-scale column to round
      // a subcent cash credit upward. Record any failure before a cash fix.
      expect(cashAfter).toBe(10000);
    });

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
      const splitSells: Awaited<ReturnType<typeof executeSellShares>>[] = [];
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
      const sells: Awaited<ReturnType<typeof executeSellShares>>[] = [];
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
    it('atomic fixture collisions preserve existing rows and leave no partial setup', async () => {
      const original = await fixture();
      const userBefore = await canonical('User', original.id);
      const marketBefore = await canonical('Market', original.marketId);
      const partialUserId = await generateSnowflakeId();
      const partialMarketId = await generateSnowflakeId();
      expect(await canonical('User', partialUserId)).toBeUndefined();
      expect(await canonical('Market', partialMarketId)).toBeUndefined();

      await expectCollision(
        () =>
          fixture(undefined, {
            userId: partialUserId,
            marketId: original.marketId,
          }),
        'Market_pkey'
      );
      expect(await canonical('User', partialUserId)).toBeUndefined();
      expect(await canonical('Market', original.marketId)).toBe(marketBefore);

      await expectCollision(
        () =>
          fixture(undefined, {
            userId: original.id,
            marketId: partialMarketId,
          }),
        'User_pkey'
      );
      expect(await canonical('Market', partialMarketId)).toBeUndefined();
      expect(await canonical('User', original.id)).toBe(userBefore);
    });
  });
}
