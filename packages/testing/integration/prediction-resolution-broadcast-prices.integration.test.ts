/**
 * Regression: the prediction_resolution broadcast must carry the final
 * YES/NO prices (1/0), like the price-history snapshot recorded for the
 * same resolution and like every prediction_trade broadcast.
 *
 * Consumers read them off the event: the chart history hook appends
 * `event.yesPrice`/`event.noPrice` as the final chart point, and the
 * trading terminal builds its resolved live state from the same fields
 * (see PredictionResolutionSSE in usePredictionMarketStream, which
 * declares both fields required). Before this fix the producer omitted
 * them, so live clients kept showing the pre-resolution price and the
 * chart never drew the settlement point until a refetch.
 *
 * Real DB + real PredictionMarketService + real history route handler.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from '@feed/core/markets/prediction';
import { db, eq, markets, predictionPriceHistories, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/markets/predictions/[id]/history/route';

const userIds: string[] = [];
const marketIds: string[] = [];

function makeService(captured: Array<Record<string, unknown>>) {
  return new PredictionMarketService({
    db: new PredictionDbAdapter(),
    wallet: {
      debit: async () => {},
      credit: async () => {},
      recordPnL: async () => {},
      getBalance: async () => ({ balance: 100000 }),
    },
    fees: {
      tradingFeeRate: 0,
      platformShare: 0,
      referrerShare: 0,
      minFeeAmount: 0,
    },
    broadcast: {
      emit: async (_channel: string, payload: Record<string, unknown>) => {
        captured.push(payload);
      },
    },
  });
}

async function makeUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `f120-res-${id}`,
    virtualBalance: '100000',
    totalDeposited: '100000',
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function makeMarket(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(markets).values({
    id,
    question: `F120 resolution broadcast market ${id}`,
    yesShares: '5000',
    noShares: '5000',
    liquidity: '10000',
    endDate: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  });
  marketIds.push(id);
  return id;
}

async function getLastHistoryPoint(marketId: string) {
  const req = new Request(
    `http://localhost/api/markets/predictions/${marketId}/history`
  ) as unknown as NextRequest;
  const res = (await GET(req, {
    params: Promise.resolve({ id: marketId }),
  })) as Response;
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data?: {
      history: Array<{
        yesPrice: number;
        noPrice: number;
        eventType: string;
      }>;
    };
    history?: Array<{ yesPrice: number; noPrice: number; eventType: string }>;
  };
  const history = body.data?.history ?? body.history ?? [];
  return history[history.length - 1];
}

afterAll(async () => {
  for (const id of marketIds) {
    await db
      .delete(predictionPriceHistories)
      .where(eq(predictionPriceHistories.marketId, id))
      .catch(() => {});
    await db
      .delete(markets)
      .where(eq(markets.id, id))
      .catch(() => {});
  }
  for (const id of userIds) {
    await db
      .delete(users)
      .where(eq(users.id, id))
      .catch(() => {});
  }
});

describe('prediction_resolution broadcast prices', () => {
  for (const winningSide of ['yes', 'no'] as const) {
    test(`resolve(${winningSide}) broadcasts the final prices and records the same point`, async () => {
      const userId = await makeUser();
      const marketId = await makeMarket();
      const captured: Array<Record<string, unknown>> = [];
      const service = makeService(captured);

      await service.buy({ userId, marketId, side: 'yes', amount: 1000 });
      await service.resolve({ marketId, winningSide });

      const expectedYes = winningSide === 'yes' ? 1 : 0;
      const expectedNo = winningSide === 'no' ? 1 : 0;

      // Control: trade broadcasts carry numeric prices.
      const tradeEvent = captured.find((b) => b.type === 'prediction_trade');
      expect(typeof tradeEvent?.yesPrice).toBe('number');
      expect(typeof tradeEvent?.noPrice).toBe('number');

      // The resolution broadcast must carry the same final prices the
      // recorded history point has, so live consumers can append/apply
      // the settlement point without a refetch.
      const resolutionEvent = captured.find(
        (b) => b.type === 'prediction_resolution'
      );
      expect(resolutionEvent).toBeDefined();
      expect(resolutionEvent?.winningSide).toBe(winningSide);
      expect(resolutionEvent?.yesPrice).toBe(expectedYes);
      expect(resolutionEvent?.noPrice).toBe(expectedNo);

      // Guard: the recorded history point still carries the same values.
      const last = await getLastHistoryPoint(marketId);
      expect(last?.eventType).toBe('resolution');
      expect(last?.yesPrice).toBe(expectedYes);
      expect(last?.noPrice).toBe(expectedNo);
    });
  }
});
