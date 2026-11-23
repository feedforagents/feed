import { afterAll, describe, expect, test } from 'bun:test';
import {
  dbWrite,
  getScheduledInferenceThrottle,
  scheduledInferenceFetch,
  scheduledInferenceReservations,
  sql,
  withScheduledInferenceBudget,
} from '@feed/db';

const enabled = process.env.FEED_TEST_SCHEDULED_INFERENCE_BUDGET === '1';

describe.skipIf(!enabled)('scheduled inference budget', () => {
  let provider: ReturnType<typeof Bun.serve> | undefined;

  afterAll(() => {
    provider?.stop(true);
  });

  test('reserves concurrent attempts, holds uncertain charges, and stops on overrun', async () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    const database = new URL(databaseUrl);
    if (
      database.hostname !== '127.0.0.1' ||
      database.pathname !== '/feed_budget_test' ||
      process.env.DIRECT_DATABASE_URL !== databaseUrl ||
      process.env.DEPLOYMENT_ENV !== 'localnet'
    ) {
      throw new Error('Use an isolated local feed_budget_test database');
    }
    expect(await dbWrite.select().from(scheduledInferenceReservations)).toEqual(
      []
    );

    let requests = 0;
    let cost: string | undefined;
    let afterDispatch: (() => Promise<void>) | undefined;
    provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch() {
        requests++;
        await afterDispatch?.();
        return new Response('{}', {
          headers: cost ? { 'x-si-buyer-cost-micro': cost } : {},
        });
      },
    });
    const base = `${provider.url}v1`;
    process.env.SURPLUS_BASE_URL = base;
    process.env.SURPLUS_API_KEY = 'local-test-only';
    process.env.NPC_LLM_DAILY_BUDGET_USD = '0.000100';
    delete process.env.SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD;
    await expect(withScheduledInferenceBudget(async () => {})).rejects.toThrow(
      'verified per-request charge bound'
    );

    process.env.SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD = '35';
    const request = () =>
      scheduledInferenceFetch(`${base}/chat/completions`, { method: 'POST' });
    const outcomes = await withScheduledInferenceBudget(() =>
      Promise.allSettled([request(), request(), request()])
    );
    expect(
      outcomes
        .map((outcome) =>
          outcome.status === 'fulfilled' ? 'accepted' : String(outcome.reason)
        )
        .sort()
    ).toEqual([
      'Error: Scheduled inference budget exhausted or suspended',
      'accepted',
      'accepted',
    ]);
    expect(requests).toBe(2);
    await dbWrite
      .update(scheduledInferenceReservations)
      .set({ createdAt: sql`clock_timestamp() - interval '2 days'` });
    await expect(withScheduledInferenceBudget(request)).rejects.toThrow(
      'budget exhausted'
    );
    expect(requests).toBe(2);

    process.env.SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD = '20';
    cost = '10';
    await withScheduledInferenceBudget(async () => {
      await request();
      expect(await getScheduledInferenceThrottle()).toEqual({
        exhausted: false,
        reduceBatch: true,
        maxSteps: 4,
      });
      await request();
      expect(await getScheduledInferenceThrottle()).toEqual({
        exhausted: true,
        reduceBatch: true,
        maxSteps: 2,
      });
    });

    process.env.SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD = '10';
    cost = '1';
    afterDispatch = async () => {
      await dbWrite.execute(sql`update "ScheduledInferenceReservation"
        set "createdAt" = clock_timestamp() - interval '2 days'
        where "settledAt" is null and "boundMicroUsd" = 10`);
    };
    await withScheduledInferenceBudget(request);
    await expect(withScheduledInferenceBudget(request)).rejects.toThrow(
      'budget exhausted'
    );
    expect(requests).toBe(5);

    afterDispatch = undefined;
    process.env.NPC_LLM_DAILY_BUDGET_USD = '0.000200';
    cost = '11';
    await expect(withScheduledInferenceBudget(request)).rejects.toThrow(
      'provider exceeded the verified charge bound'
    );
    await expect(withScheduledInferenceBudget(request)).rejects.toThrow(
      'budget exhausted or suspended'
    );
    expect(requests).toBe(6);
  });
});
