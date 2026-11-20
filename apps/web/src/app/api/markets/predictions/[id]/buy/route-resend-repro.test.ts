/**
 * F-W8-B repro: prediction buy/sell resend executes the trade twice.
 *
 * A client resend (timeout retry / double-click) sends the identical
 * POST a second time. The buy/sell routes accept no idempotency key
 * (PredictionMarketTradeSchema is { side, amount }; SellSchema is
 * { shares, positionId? }) and withPredictionSettlement performs no
 * dedup, so the second request is a second full trade: balance debited
 * again, position shares doubled, market odds moved again.
 *
 * All amounts are simulation balances on a disposable local test DB
 * (users.virtualBalance points); no real money is involved.
 *
 * Only the PostHog telemetry module is mocked (external analytics);
 * authenticate, the settlement, the wallet and the fee path are all real.
 */
import { afterAll, describe, expect, it, mock } from 'bun:test';
import {
  balanceTransactions,
  dbWrite,
  eq,
  inArray,
  markets,
  positions,
  predictionPriceHistories,
  predictionTradeIdempotency,
  tradingFees,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

mock.module('@/lib/posthog/server', () => ({
  trackServerEvent: mock(async () => undefined),
}));

const { POST: buyPOST } = await import('./route');
const { POST: sellPOST } = await import('../sell/route');

const userIds: string[] = [];
const marketIds: string[] = [];

async function fixture() {
  const userId = await generateSnowflakeId();
  const marketId = await generateSnowflakeId();
  await dbWrite.insert(users).values({
    id: userId,
    username: `w8b-resend-${userId}`,
    profileComplete: true,
    virtualBalance: '1000',
    totalDeposited: '1000',
    updatedAt: new Date(),
  });
  userIds.push(userId);
  await dbWrite.insert(markets).values({
    id: marketId,
    question: 'F-W8-B resend repro market',
    yesShares: '500',
    noShares: '500',
    liquidity: '1000',
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  marketIds.push(marketId);
  return { userId, marketId };
}

async function state(userId: string, marketId: string) {
  const [user] = await dbWrite.select().from(users).where(eq(users.id, userId));
  const [market] = await dbWrite
    .select()
    .from(markets)
    .where(eq(markets.id, marketId));
  const holdings = await dbWrite
    .select()
    .from(positions)
    .where(eq(positions.marketId, marketId));
  const ledger = await dbWrite
    .select()
    .from(balanceTransactions)
    .where(eq(balanceTransactions.userId, userId));
  const fees = await dbWrite
    .select()
    .from(tradingFees)
    .where(eq(tradingFees.userId, userId));
  return {
    balance: Number(user?.virtualBalance),
    market,
    holdings,
    ledger,
    fees,
  };
}

function buyRequest(
  userId: string,
  marketId: string,
  body: object,
  idempotencyKey?: string
) {
  return new NextRequest(
    `http://localhost/api/markets/predictions/${marketId}/buy`,
    {
      method: 'POST',
      headers: {
        'x-dev-user-id': userId,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

function sellRequest(
  userId: string,
  marketId: string,
  body: object,
  idempotencyKey?: string
) {
  return new NextRequest(
    `http://localhost/api/markets/predictions/${marketId}/sell`,
    {
      method: 'POST',
      headers: {
        'x-dev-user-id': userId,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }
  );
}

async function postBuy(
  userId: string,
  marketId: string,
  body: object,
  idempotencyKey?: string
) {
  const res = await buyPOST(
    buyRequest(userId, marketId, body, idempotencyKey),
    {
      params: Promise.resolve({ id: marketId }),
    }
  );
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: test response parsing
    body: (await res.json()) as Record<string, any>,
  };
}

async function postSell(
  userId: string,
  marketId: string,
  body: object,
  idempotencyKey?: string
) {
  const res = await sellPOST(
    sellRequest(userId, marketId, body, idempotencyKey),
    {
      params: Promise.resolve({ id: marketId }),
    }
  );
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: test response parsing
    body: (await res.json()) as Record<string, any>,
  };
}

afterAll(async () => {
  if (userIds.length) {
    await dbWrite
      .delete(predictionTradeIdempotency)
      .where(inArray(predictionTradeIdempotency.userId, userIds));
  }
  if (marketIds.length) {
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.relatedId, marketIds));
    await dbWrite
      .delete(predictionPriceHistories)
      .where(inArray(predictionPriceHistories.marketId, marketIds));
    await dbWrite
      .delete(positions)
      .where(inArray(positions.marketId, marketIds));
    await dbWrite.delete(markets).where(inArray(markets.id, marketIds));
  }
  if (userIds.length) {
    await dbWrite
      .delete(tradingFees)
      .where(inArray(tradingFees.userId, userIds));
    await dbWrite
      .delete(balanceTransactions)
      .where(inArray(balanceTransactions.userId, userIds));
    await dbWrite.delete(users).where(inArray(users.id, userIds));
  }
});

describe('F-W8-B prediction trade resend (real route, real DB)', () => {
  it('executes the identical buy twice: balance -200, shares doubled', async () => {
    const { userId, marketId } = await fixture();
    const body = { side: 'yes', amount: 100 };
    const key = `w8b-buy-${marketId}`;

    const first = await postBuy(userId, marketId, body, key);
    expect(first.status).toBe(201);
    const firstShares = Number(first.body.position.shares);
    expect(firstShares).toBeGreaterThan(0);
    expect((await state(userId, marketId)).balance).toBe(900);

    // Identical resend: same user, market, side, amount AND same
    // Idempotency-Key — a retry after a lost response. A deduped server
    // replays the first result and leaves the balance at 900.
    const second = await postBuy(userId, marketId, body, key);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);

    const after = await state(userId, marketId);
    expect(after.balance).toBe(900);
    expect(after.holdings).toHaveLength(1);
    expect(Number(after.holdings[0]!.shares)).toBeCloseTo(firstShares, 6);
    expect(after.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      1
    );
  });

  it('executes an identical partial sell twice: proceeds credited twice', async () => {
    const { userId, marketId } = await fixture();
    const bought = await postBuy(userId, marketId, {
      side: 'yes',
      amount: 100,
    });
    expect(bought.status).toBe(201);
    const positionId = String(bought.body.position.id);
    const totalShares = Number(bought.body.position.shares);
    const half = Math.floor(totalShares * 100) / 200;
    expect(half).toBeGreaterThanOrEqual(0.01);
    const key = `w8b-sell-${marketId}`;

    const first = await postSell(
      userId,
      marketId,
      {
        shares: half,
        positionId,
      },
      key
    );
    expect(first.status).toBe(200);
    const balanceAfterFirstSell = Number(first.body.newBalance);

    const second = await postSell(
      userId,
      marketId,
      {
        shares: half,
        positionId,
      },
      key
    );
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);

    const after = await state(userId, marketId);
    // The replayed sell did not execute, so the half sold once remains.
    // `half` is rounded down to 2 decimals when requested; the stored
    // remainder keeps full precision, so compare to 2 decimals.
    expect(Number(after.holdings[0]!.shares)).toBeCloseTo(half, 2);
    expect(after.balance).toBe(balanceAfterFirstSell);
    expect(after.ledger.filter((row) => row.type === 'pred_sell')).toHaveLength(
      1
    );
  });

  it('control: two buys with different keys both execute', async () => {
    const { userId, marketId } = await fixture();
    const body = { side: 'yes', amount: 100 };

    const first = await postBuy(userId, marketId, body, `w8b-a-${marketId}`);
    expect(first.status).toBe(201);
    const firstShares = Number(first.body.position.shares);

    // A legitimate repeat purchase carries a fresh key and must still trade.
    const second = await postBuy(userId, marketId, body, `w8b-b-${marketId}`);
    expect(second.status).toBe(201);

    const after = await state(userId, marketId);
    expect(after.balance).toBe(800);
    expect(after.holdings).toHaveLength(1);
    expect(Number(after.holdings[0]!.shares)).toBeGreaterThan(firstShares);
    expect(after.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      2
    );
  });

  it('control: same key with a different amount returns 409', async () => {
    const { userId, marketId } = await fixture();
    const key = `w8b-diff-${marketId}`;

    const first = await postBuy(
      userId,
      marketId,
      { side: 'yes', amount: 100 },
      key
    );
    expect(first.status).toBe(201);

    // The key binds the request: a resend that (wrongly) changes the
    // amount is a key-reuse conflict, not a replay of the first result.
    const second = await postBuy(
      userId,
      marketId,
      { side: 'yes', amount: 50 },
      key
    );
    expect(second.status).toBe(409);
    const after = await state(userId, marketId);
    expect(after.balance).toBe(900);
    expect(after.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      1
    );
  });

  it('same key on a different market returns 409 and does not trade', async () => {
    const { userId, marketId } = await fixture();
    const other = await fixture();
    const key = `w8b-xmarket-${marketId}`;
    const body = { side: 'yes', amount: 100 };

    const first = await postBuy(userId, marketId, body, key);
    expect(first.status).toBe(201);
    expect((await state(userId, marketId)).balance).toBe(900);

    // Same user, same key, same body — but a different market. The key
    // is bound to the first market, so this is a conflict, not a replay.
    const second = await postBuy(userId, other.marketId, body, key);
    expect(second.status).toBe(409);

    expect((await state(userId, other.marketId)).balance).toBe(900);
    expect((await state(userId, other.marketId)).holdings).toHaveLength(0);
    expect(
      (await state(userId, marketId)).ledger.filter(
        (row) => row.type === 'pred_buy'
      )
    ).toHaveLength(1);
  });

  it('sell reusing a buy key returns 409 and does not sell', async () => {
    const { userId, marketId } = await fixture();
    const key = `w8b-buysell-${marketId}`;

    const bought = await postBuy(
      userId,
      marketId,
      { side: 'yes', amount: 100 },
      key
    );
    expect(bought.status).toBe(201);
    const positionId = String(bought.body.position.id);
    const totalShares = Number(bought.body.position.shares);

    // Same key, but a sell is a different operation than the buy that
    // stored the key — replaying the buy result as a sell would report
    // a sale that never happened.
    const sold = await postSell(
      userId,
      marketId,
      { shares: totalShares, positionId },
      key
    );
    expect(sold.status).toBe(409);

    const after = await state(userId, marketId);
    expect(after.balance).toBe(900);
    expect(Number(after.holdings[0]!.shares)).toBeCloseTo(totalShares, 6);
    expect(after.ledger.filter((row) => row.type === 'pred_sell')).toHaveLength(
      0
    );
  });

  it('concurrent same-key buys on different markets: one 201, one 409', async () => {
    const { userId, marketId } = await fixture();
    const other = await fixture();
    const key = `w8b-race-${marketId}`;
    const body = { side: 'yes', amount: 100 };

    // The per-market advisory locks do not serialize this pair, so both
    // trades execute and the loser hits the (userId, key) unique index.
    // Its trade rolls back with the transaction and it must see a 409,
    // not a raw 500 — and exactly one trade may survive in total.
    const [first, second] = await Promise.all([
      postBuy(userId, marketId, body, key),
      postBuy(userId, other.marketId, body, key),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);

    const afterA = await state(userId, marketId);
    const afterB = await state(userId, other.marketId);
    // state() returns the user's ledger in both calls (the ledger is
    // per-user, not per-market), so count the pred_buy rows once.
    expect(afterA.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      1
    );
    expect(afterA.balance).toBe(900);
    expect(afterA.holdings.length + afterB.holdings.length).toBe(1);
  });

  it('two users with the same key both execute (key is per-user)', async () => {
    const first = await fixture();
    const second = await fixture();
    const key = 'w8b-shared-key';
    const body = { side: 'yes', amount: 100 };

    const buyA = await postBuy(first.userId, first.marketId, body, key);
    expect(buyA.status).toBe(201);
    const buyB = await postBuy(second.userId, second.marketId, body, key);
    expect(buyB.status).toBe(201);

    const afterA = await state(first.userId, first.marketId);
    expect(afterA.balance).toBe(900);
    expect(afterA.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      1
    );
    const afterB = await state(second.userId, second.marketId);
    expect(afterB.balance).toBe(900);
    expect(afterB.ledger.filter((row) => row.type === 'pred_buy')).toHaveLength(
      1
    );
  });

  it('boundary: an identical full-position sell resend is refused', async () => {
    const { userId, marketId } = await fixture();
    const bought = await postBuy(userId, marketId, {
      side: 'yes',
      amount: 100,
    });
    expect(bought.status).toBe(201);
    const positionId = String(bought.body.position.id);
    const totalShares = Number(bought.body.position.shares);

    const first = await postSell(userId, marketId, {
      shares: totalShares,
      positionId,
    });
    expect(first.status).toBe(200);

    const second = await postSell(userId, marketId, {
      shares: totalShares,
      positionId,
    });
    expect(second.status).not.toBe(200);
  });
});
