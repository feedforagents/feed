/** PRD §§9.1/9.3 / MVP Phase 6: liquidate against the owning wallet. */
import { expect, test } from 'bun:test';
import { PerpDbAdapter, PerpMarketService } from '@feed/core/markets/perps';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const mixedWalletCase =
  'settles cent-precision funding in the owning wallet and retries a rolled-back NPC liquidation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs perp liquidation funding in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'perp-liquidation-funding',
      file: 'packages/testing/integration/perp-liquidation-funding-settlement.integration.test.ts',
      cases: [mixedWalletCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const {
    actorState,
    and,
    balanceTransactions,
    db,
    eq,
    organizationState,
    perpMarketSnapshots,
    perpPositions,
    users,
  } = await import('@feed/db');
  const { FEE_CONFIG } = await import('../../engine/src/config/fees');
  const { createNpcWalletAdapter } = await import(
    '../../engine/src/services/npc-wallet-adapter'
  );
  const { createNpcPerpSettlement, createPerpSettlement } = await import(
    '../../engine/src/services/perp-settlement'
  );
  const { PriceUpdateService } = await import(
    '../../engine/src/services/price-update-service'
  );
  const { createUserWalletAdapter } = await import(
    '../../engine/src/services/user-wallet-adapter'
  );
  const { generateSnowflakeId } = await import('@feed/shared');

  test(mixedWalletCase, async () => {
    const playerId = await generateSnowflakeId();
    const payerId = await generateSnowflakeId();
    const npcId = await generateSnowflakeId();
    const ticker = `LIQFUND${playerId}`;
    const updatedAt = new Date();
    await db.insert(users).values(
      [playerId, payerId, npcId].map((id) => ({
        id,
        username: `liq-fund-${id}`,
        isActor: id === npcId,
        virtualBalance: '10000',
        totalDeposited: '10000',
        updatedAt,
      }))
    );
    await db.insert(actorState).values({
      id: npcId,
      tradingBalance: '20000',
      updatedAt,
    });
    await db.insert(organizationState).values({
      id: ticker,
      currentPrice: 100,
      basePrice: 100,
      updatedAt,
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
        predictedRate: 0,
        nextFundingTime: updatedAt.toISOString(),
      },
    });

    const dbAdapter = new PerpDbAdapter();
    const fees = {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    };
    const playerService = new PerpMarketService({
      db: dbAdapter,
      wallet: createUserWalletAdapter(),
      settlement: createPerpSettlement(),
      fees,
    });
    const npcService = new PerpMarketService({
      db: dbAdapter,
      wallet: createNpcWalletAdapter(npcId),
      settlement: createNpcPerpSettlement(),
      fees,
    });
    const order = { ticker, side: 'long' as const, size: 100, leverage: 10 };
    const player = await playerService.openPosition({
      ...order,
      userId: playerId,
    });
    const payer = await playerService.openPosition({
      ...order,
      userId: payerId,
    });
    const npc = await npcService.openPosition({ ...order, userId: npcId });

    const rebate = -5.781;
    for (const { positionId, values } of [
      // Give the player an exact-cent settlement at the 89.10 mark.
      {
        positionId: player.positionId,
        values: { fundingPaid: -5.28, entryPrice: 100, liquidationPrice: 90 },
      },
      { positionId: payer.positionId, values: { fundingPaid: 5 } },
      { positionId: npc.positionId, values: { fundingPaid: rebate } },
    ]) {
      await db
        .update(perpPositions)
        .set(values)
        .where(eq(perpPositions.id, positionId));
    }

    async function readUser(id: string) {
      const [owner] = await db.select().from(users).where(eq(users.id, id));
      if (!owner) throw new Error(`Fixture user missing: ${id}`);
      return owner;
    }

    const playerBefore = await readUser(playerId);
    const payerBefore = await readUser(payerId);
    const mark = 89.1;
    const sweep = () =>
      PriceUpdateService.applyUpdates([
        { organizationId: ticker, newPrice: mark, source: 'system' },
      ]);
    const readMarket = async () =>
      (await dbAdapter.listMarkets()).find(
        (market) => market.ticker === ticker
      );
    // A bootstrapped NPC's shadow user remains while its actual wallet is
    // unavailable. Removing only this fixture row makes the live credit fail.
    const [npcWallet] = await db
      .delete(actorState)
      .where(eq(actorState.id, npcId))
      .returning();
    if (!npcWallet) throw new Error('Fixture NPC wallet missing');

    function expectedCredit(entryPrice: number) {
      const margin = order.size / order.leverage;
      const equity =
        margin + ((mark - entryPrice) / entryPrice) * order.size - rebate;
      return Math.floor(equity * 100) / 100;
    }

    await sweep();
    const playerClosed = await dbAdapter.getPositionById(player.positionId);
    const payerClosed = await dbAdapter.getPositionById(payer.positionId);
    const npcOpen = await dbAdapter.getPositionById(npc.positionId);
    const market = await readMarket();
    expect(playerClosed?.closedAt).toBeInstanceOf(Date);
    expect(payerClosed?.closedAt).toBeInstanceOf(Date);
    expect((await readUser(npcId)).virtualBalance).toBe('10000.00');
    expect(npcOpen?.closedAt).toBeUndefined();
    expect(npcOpen?.realizedPnL ?? 0).toBe(0);
    expect(npcOpen?.fundingPaid).toBe(rebate);
    expect(market?.openInterest).toBe(order.size);

    const margin = order.size / order.leverage;
    const playerCredit = 4.38;
    expect(playerClosed?.realizedPnL).toBeCloseTo(playerCredit - margin, 10);
    const playerAfter = await readUser(playerId);
    expect(Number(playerAfter.virtualBalance)).toBeCloseTo(
      Number(playerBefore.virtualBalance) + playerCredit,
      10
    );
    expect(Number(playerAfter.lifetimePnL)).toBeCloseTo(
      Number(playerBefore.lifetimePnL) + playerCredit - margin,
      10
    );

    const payerAfter = await readUser(payerId);
    expect(payerClosed?.realizedPnL).toBe(-margin);
    expect(payerAfter.virtualBalance).toBe(payerBefore.virtualBalance);
    expect(Number(payerAfter.lifetimePnL)).toBe(
      Number(payerBefore.lifetimePnL) - margin
    );

    await db.insert(actorState).values(npcWallet);
    await sweep();
    await sweep();
    const npcClosed = await dbAdapter.getPositionById(npc.positionId);
    const [npcWalletAfter] = await db
      .select()
      .from(actorState)
      .where(eq(actorState.id, npcId));
    const npcCredit = expectedCredit(npc.entryPrice);
    expect(npcCredit).toBeGreaterThan(0);
    expect(npcClosed?.closedAt).toBeInstanceOf(Date);
    expect(npcClosed?.realizedPnL).toBeCloseTo(npcCredit - margin, 10);
    expect(npcClosed?.fundingPaid).toBe(rebate);
    expect(Number(npcWalletAfter?.tradingBalance)).toBeCloseTo(
      Number(npcWallet.tradingBalance) + npcCredit,
      10
    );
    const npcShadowAfter = await readUser(npcId);
    expect(npcShadowAfter.virtualBalance).toBe('10000.00');
    expect(Number(npcShadowAfter.lifetimePnL)).toBe(0);
    expect((await readMarket())?.openInterest).toBe(0);
    expect(await readUser(playerId)).toEqual(playerAfter);
    expect(await readUser(payerId)).toEqual(payerAfter);
    const credits = await db
      .select()
      .from(balanceTransactions)
      .where(
        and(
          eq(balanceTransactions.userId, playerId),
          eq(balanceTransactions.type, 'perp_liquidation')
        )
      );
    expect(credits).toHaveLength(1);
    expect(Number(credits[0]?.amount)).toBe(playerCredit);
  });
}
