import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { db, initializeMemoryMode, resetToPostgresMode } from '@feed/db';
import { buildPositionsPromptContextByActorId } from '../services/npc-positions-context-service';

describe('buildPositionsPromptContextByActorId', () => {
  beforeEach(async () => {
    await initializeMemoryMode();
  });

  afterAll(() => {
    resetToPostgresMode();
  });

  test('resolves marketId-linked prediction positions written with null questionId via Question.marketId, Question.id, and Market fallback', async () => {
    const now = new Date('2026-11-23T00:00:00.000Z');
    const endDate = new Date('2026-12-01T00:00:00.000Z');

    // Case 1: production shape written by PredictionDbAdapter — questionId is null,
    // Position.marketId matches Question.marketId (with a distinct Question.id) and Market row also exists.
    await db.market.create({
      data: {
        id: 'mkt-linked',
        question: 'Market row text that should not shadow Question number',
        yesShares: '5000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate,
        updatedAt: now,
      },
    });
    await db.question.create({
      data: {
        id: 'q-row-12',
        questionNumber: 12,
        marketId: 'mkt-linked',
        text: 'Will NVAIDAI ship its next-gen chip before Q4?',
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: endDate,
        status: 'active',
        updatedAt: now,
      },
    });
    await db.position.create({
      data: {
        id: 'pos-1',
        userId: 'actor-1',
        marketId: 'mkt-linked',
        side: true,
        shares: '100',
        avgPrice: '0.5',
        amount: '200',
        pnl: '50',
        questionId: null,
        status: 'active',
        updatedAt: now,
      },
    });

    // Case 2: Question linked by shared id === marketId with Question.marketId unset.
    await db.question.create({
      data: {
        id: 'mkt-shared-id',
        questionNumber: 45,
        marketId: null,
        text: 'Will TSLAI deliver 500k units?',
        scenarioId: 1,
        outcome: false,
        rank: 2,
        resolutionDate: endDate,
        status: 'active',
        updatedAt: now,
      },
    });
    await db.position.create({
      data: {
        id: 'pos-2',
        userId: 'actor-1',
        marketId: 'mkt-shared-id',
        side: false,
        shares: '80',
        avgPrice: '0.5',
        amount: '150',
        pnl: '-20',
        questionId: null,
        status: 'active',
        updatedAt: now,
      },
    });

    // Case 3: standalone Market with no Question row falls back to Market.question.
    await db.market.create({
      data: {
        id: 'mkt-standalone',
        question: 'Will open interest exceed 1M points this week?',
        yesShares: '5000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate,
        updatedAt: now,
      },
    });
    await db.position.create({
      data: {
        id: 'pos-3',
        userId: 'actor-2',
        marketId: 'mkt-standalone',
        side: true,
        shares: '40',
        avgPrice: '0.5',
        amount: '100',
        pnl: '10',
        questionId: null,
        status: 'active',
        updatedAt: now,
      },
    });

    const contexts = await buildPositionsPromptContextByActorId([
      'actor-1',
      'actor-2',
    ]);

    expect(contexts['actor-1']).toContain(
      '- Q12: "Will NVAIDAI ship its next-gen chip before Q4?" → YES ($+50)'
    );
    expect(contexts['actor-1']).toContain(
      '- Q45: "Will TSLAI deliver 500k units?" → NO ($-20)'
    );
    expect(contexts['actor-1']).not.toContain('Unknown question');

    expect(contexts['actor-2']).toContain(
      '- "Will open interest exceed 1M points this week?" → YES ($+10)'
    );
    expect(contexts['actor-2']).not.toContain('Unknown question');
  });

  test('preserves legacy numeric questionId lookup and Unknown question fallback for dangling marketIds', async () => {
    const now = new Date('2026-11-23T00:00:00.000Z');
    const endDate = new Date('2026-12-01T00:00:00.000Z');

    await db.question.create({
      data: {
        id: 'q-legacy-7',
        questionNumber: 7,
        marketId: null,
        text: 'Legacy numbered question text',
        scenarioId: 1,
        outcome: true,
        rank: 1,
        resolutionDate: endDate,
        status: 'active',
        updatedAt: now,
      },
    });
    await db.position.create({
      data: {
        id: 'pos-legacy',
        userId: 'actor-legacy',
        marketId: 'mkt-unmatched',
        side: true,
        shares: '50',
        avgPrice: '0.5',
        amount: '200',
        pnl: '0',
        questionId: 7,
        status: 'active',
        updatedAt: now,
      },
    });
    await db.position.create({
      data: {
        id: 'pos-dangling',
        userId: 'actor-legacy',
        marketId: 'mkt-does-not-exist',
        side: false,
        shares: '50',
        avgPrice: '0.5',
        amount: '100',
        pnl: '-5',
        questionId: null,
        status: 'active',
        updatedAt: now,
      },
    });

    const contexts = await buildPositionsPromptContextByActorId([
      'actor-legacy',
    ]);

    expect(contexts['actor-legacy']).toContain(
      '- Q7: "Legacy numbered question text" → YES ($0)'
    );
    expect(contexts['actor-legacy']).toContain('- Unknown question → NO ($-5)');
  });
});
