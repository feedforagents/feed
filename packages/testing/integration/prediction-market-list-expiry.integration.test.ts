import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import { db, inArray, markets } from '@feed/db';

/**
 * The prediction market list (GET /api/markets/predictions) is the trading
 * list: it must contain exactly the markets a buy can still succeed on.
 * The buy path rejects a market whose endDate has passed with
 * 'Market expired', and resolved markets are already excluded. An
 * expired-but-unresolved market must not be listed or counted either —
 * otherwise the list, its total, and every status-based consumer
 * (dashboard active filter and count) present a closed market as live.
 */

const prefix = `list-expiry-${crypto.randomUUID()}`;
const ids = {
  live: `${prefix}-live`,
  expired: `${prefix}-expired`,
  resolved: `${prefix}-resolved`,
};
const marketIds = Object.values(ids);

function makeService() {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 0 }),
    },
    fees: {
      tradingFeeRate: 0,
      platformShare: 0,
      referrerShare: 0,
      minFeeAmount: 0,
    },
  });
}

async function insertMarket(
  id: string,
  opts: { endDate: Date; resolved: boolean }
) {
  await db.insert(markets).values({
    id,
    question: `Fixture market ${id}`,
    liquidity: '1000',
    yesShares: '100',
    noShares: '100',
    resolved: opts.resolved,
    resolution: opts.resolved ? true : null,
    endDate: opts.endDate,
    updatedAt: new Date(),
  });
}

let baseCount = 0;

beforeAll(async () => {
  const service = makeService();
  baseCount = await service.countUnresolvedMarkets();
  const now = Date.now();
  await insertMarket(ids.live, {
    endDate: new Date(now + 24 * 60 * 60 * 1000),
    resolved: false,
  });
  await insertMarket(ids.expired, {
    endDate: new Date(now - 60 * 60 * 1000),
    resolved: false,
  });
  await insertMarket(ids.resolved, {
    endDate: new Date(now - 24 * 60 * 60 * 1000),
    resolved: true,
  });
});

afterAll(async () => {
  await db.delete(markets).where(inArray(markets.id, marketIds));
});

describe('prediction market trading list expiry', () => {
  test('full list contains the live market but not the expired or resolved one', async () => {
    const service = makeService();
    const listed = (await service.listMarkets()).map((m) => m.id);
    expect(listed).toContain(ids.live);
    expect(listed).not.toContain(ids.expired);
    expect(listed).not.toContain(ids.resolved);
  });

  test('no page of the paginated list returns the expired market', async () => {
    const service = makeService();
    const seen: string[] = [];
    for (let offset = 0; offset < 50; offset += 5) {
      const page = await service.listMarkets({ limit: 5, offset });
      if (page.length === 0) break;
      seen.push(...page.map((m) => m.id));
    }
    expect(seen).toContain(ids.live);
    expect(seen).not.toContain(ids.expired);
    expect(seen).not.toContain(ids.resolved);
  });

  test('total counts only markets the list can return', async () => {
    const service = makeService();
    const total = await service.countUnresolvedMarkets();
    // Only the live fixture is unresolved and still open; the expired
    // fixture is unresolved but closed to buys, the resolved one is done.
    expect(total).toBe(baseCount + 1);
  });
});
