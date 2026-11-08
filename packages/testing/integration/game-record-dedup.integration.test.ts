/**
 * Integration Test: Game Record Deduplication → Displayed Game Record
 *
 * The displayed game record (agentPerformanceMetrics.gamesPlayed/gamesWon,
 * surfaced by /api/reputation/[userId], the reputation page, the leaderboard
 * and data export) must count each distinct game once.
 *
 * Two production paths record a completed game:
 * - POST /api/feedback/game-to-agent (direct submission; rejects a second
 *   submission for the same agent+gameId with 409)
 * - POST /api/feedback/auto-generate (generated completion feedback)
 *
 * This test drives both real routes against a real database and checks that
 * a game recorded through the generated path is counted once, is visible to
 * the direct route's duplicate check, and vice versa.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { db } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

// Mock agent0 sync to prevent race conditions in tests
mock.module('@feed/agents/agent0/reputation/agent0-reputation-sync', () => ({
  submitFeedbackToAgent0: async () => {
    return { submitted: true };
  },
  syncAfterAgent0Registration: async () => {
    return { synced: true };
  },
}));

// Dynamic imports to ensure mock is used
const { POST: submitGameFeedback } = await import(
  '@/app/api/feedback/game-to-agent/route'
);
const { POST: autoGenerateFeedback } = await import(
  '@/app/api/feedback/auto-generate/route'
);

function gameToAgentRequest(agentId: string, gameId: string, won: boolean) {
  return new NextRequest('http://localhost/api/feedback/game-to-agent', {
    method: 'POST',
    body: JSON.stringify({ agentId, gameId, score: 80, won }),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

function autoGenerateRequest(agentId: string, gameId: string, won: boolean) {
  return new NextRequest('http://localhost/api/feedback/auto-generate', {
    method: 'POST',
    body: JSON.stringify({
      type: 'game',
      agentId,
      gameId,
      metrics: {
        won,
        pnl: won ? 100 : -50,
        positionsClosed: 3,
        finalBalance: 1100,
        startingBalance: 1000,
        decisionsCorrect: 7,
        decisionsTotal: 10,
      },
    }),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
}

describe('a game counts once toward the displayed game record', () => {
  let agentId: string;
  const suffix = Date.now();
  const directGame = `f49-direct-${suffix}`;
  const generatedGame = `f49-generated-${suffix}`;
  const crossGame = `f49-cross-${suffix}`;

  beforeAll(async () => {
    agentId = await generateSnowflakeId();
    await db.user.create({
      data: {
        id: agentId,
        username: `agent-f49-${suffix}`,
        displayName: 'Game Record Test Agent',
        isAgent: true,
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    await db.feedback.deleteMany({ where: { toUserId: agentId } });
    await db.agentPerformanceMetrics.deleteMany({
      where: { userId: agentId },
    });
    await db.user.delete({ where: { id: agentId } });
  });

  async function counters() {
    const metrics = await db.agentPerformanceMetrics.findUnique({
      where: { userId: agentId },
    });
    return {
      gamesPlayed: metrics?.gamesPlayed ?? 0,
      gamesWon: metrics?.gamesWon ?? 0,
    };
  }

  test('guard: direct submission counts once and its duplicate is rejected', async () => {
    const first = await submitGameFeedback(
      gameToAgentRequest(agentId, directGame, true)
    );
    expect(first.status).toBe(201);

    const duplicate = await submitGameFeedback(
      gameToAgentRequest(agentId, directGame, true)
    );
    expect(duplicate.status).toBe(409);

    expect(await counters()).toEqual({ gamesPlayed: 1, gamesWon: 1 });
  });

  test('generated feedback for one game counts once, even when regenerated', async () => {
    const first = await autoGenerateFeedback(
      autoGenerateRequest(agentId, generatedGame, false)
    );
    expect(first.status).toBe(201);
    expect(await counters()).toEqual({ gamesPlayed: 2, gamesWon: 1 });

    // A retry/regeneration of the same completed game must not count again.
    const regenerated = await autoGenerateFeedback(
      autoGenerateRequest(agentId, generatedGame, false)
    );
    expect(regenerated.status).toBe(201);
    expect(await counters()).toEqual({ gamesPlayed: 2, gamesWon: 1 });

    const rows = await db.feedback.findMany({
      where: { toUserId: agentId, gameId: generatedGame },
    });
    expect(rows.length).toBe(1);
  });

  test('a generated game is visible to the direct route duplicate check', async () => {
    const response = await submitGameFeedback(
      gameToAgentRequest(agentId, generatedGame, false)
    );
    expect(response.status).toBe(409);
    expect(await counters()).toEqual({ gamesPlayed: 2, gamesWon: 1 });
  });

  test('a directly submitted game is not recounted by generation', async () => {
    const direct = await submitGameFeedback(
      gameToAgentRequest(agentId, crossGame, true)
    );
    expect(direct.status).toBe(201);
    expect(await counters()).toEqual({ gamesPlayed: 3, gamesWon: 2 });

    const generated = await autoGenerateFeedback(
      autoGenerateRequest(agentId, crossGame, true)
    );
    expect(generated.status).toBe(201);
    expect(await counters()).toEqual({ gamesPlayed: 3, gamesWon: 2 });

    const rows = await db.feedback.findMany({
      where: { toUserId: agentId, gameId: crossGame },
    });
    expect(rows.length).toBe(1);
  });
});
