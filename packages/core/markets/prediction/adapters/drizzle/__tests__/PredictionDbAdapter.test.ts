import { describe, expect, mock, test } from 'bun:test';
import { PredictionDbAdapter } from '../PredictionDbAdapter';

describe('PredictionDbAdapter.getQuestion', () => {
  test('does not reinterpret large snowflake-like ids as question numbers', async () => {
    let limitCalls = 0;
    const client = {
      select: mock(() => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              limitCalls += 1;
              return [];
            },
          }),
        }),
      })),
    };

    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    const result = await adapter.getQuestion('295030178092052480');

    expect(result).toBeNull();
    expect(client.select).toHaveBeenCalledTimes(1);
    expect(limitCalls).toBe(1);
  });

  test('falls back to questionNumber lookup for safe integer ids', async () => {
    let selectCalls = 0;
    const client = {
      select: mock(() => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls += 1;
              if (selectCalls === 1) {
                return [];
              }
              return [
                {
                  id: 'question-123',
                  questionNumber: 123,
                  text: 'Will NVDAI hold above $3,500?',
                  status: 'active',
                  resolutionDate: null,
                  resolvedOutcome: null,
                  createdDate: new Date('2026-03-01T00:00:00.000Z'),
                },
              ];
            },
          }),
        }),
      })),
    };

    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    const result = await adapter.getQuestion('123');

    expect(result).toMatchObject({
      id: 'question-123',
      questionNumber: 123,
      text: 'Will NVDAI hold above $3,500?',
      status: 'active',
    });
    expect(client.select).toHaveBeenCalledTimes(2);
  });
});

describe('PredictionDbAdapter.updateMarketState', () => {
  function makeClient() {
    const setCalls: Array<Record<string, unknown>> = [];
    const row = {
      id: 'm1',
      question: 'q',
      description: null,
      yesShares: '1',
      noShares: '1',
      liquidity: '2',
      endDate: new Date('2030-01-01T00:00:00.000Z'),
      resolved: false,
      resolution: null,
      resolutionProofUrl: null,
      resolutionDescription: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const client = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          setCalls.push(values);
          return { where: () => ({ returning: async () => [row] }) };
        },
      }),
    };
    return { client, setCalls };
  }

  test('passes explicit null through to clear nullable resolution fields', async () => {
    const { client, setCalls } = makeClient();
    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    await adapter.updateMarketState('m1', {
      resolved: false,
      resolution: null,
      resolutionProofUrl: null,
      resolutionDescription: null,
    });
    expect(setCalls[0]).toMatchObject({
      resolution: null,
      resolutionProofUrl: null,
      resolutionDescription: null,
    });
  });

  test('leaves omitted nullable fields unchanged (undefined)', async () => {
    const { client, setCalls } = makeClient();
    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    await adapter.updateMarketState('m1', { yesShares: 3 });
    expect(setCalls[0]!.resolution).toBeUndefined();
    expect(setCalls[0]!.resolutionProofUrl).toBeUndefined();
    expect(setCalls[0]!.yesShares).toBe('3');
  });
});

describe('PredictionDbAdapter.withMarketLock', () => {
  test('takes the advisory lock before the critical section on a caller transaction', async () => {
    const events: string[] = [];
    const client = {
      execute: async (query: { queryChunks?: ReadonlyArray<unknown> }) => {
        const text = JSON.stringify(query);
        events.push(text.includes('pg_advisory_xact_lock') ? 'lock' : text);
      },
    };
    // biome-ignore lint: mock client shape doesn't match full DrizzleClient
    const adapter = new PredictionDbAdapter(client as any);
    await adapter.withMarketLock('market-1', async () => {
      events.push('work');
    });
    expect(events).toEqual(['lock', 'work']);
  });
});
