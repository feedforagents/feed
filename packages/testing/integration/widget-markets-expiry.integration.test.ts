/**
 * Integration Test: Markets Widget Expiry
 *
 * Tests GET /api/feed/widgets/markets (the home sidebar "Markets" panel).
 * The panel presents itself as a list of active markets ("No active markets
 * at the moment." when empty) and has no ended/expired state: every entry is
 * rendered with live Yes/No prices and links to the market detail page,
 * where the buy gate rejects expired markets with 'Market expired'.
 *
 * The widget must therefore only return questions that can still be traded:
 * status 'active' AND resolutionDate in the future. A question whose
 * resolutionDate has passed but that has not been resolved yet (settlement
 * pending, e.g. manual review) must not appear. Resolved questions are
 * already excluded by the status filter and are asserted as a control.
 *
 * The route handler runs in-process against the real database. Nothing is
 * module-mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db, inArray, questions, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { GET as getWidgetMarkets } from '@/app/api/feed/widgets/markets/route';

const prefix = `widget-expiry-${crypto.randomUUID()}`;
const questionIds: string[] = [];
let questionNumber = 1_800_000_000 + Math.floor(Math.random() * 100_000_000);

async function createQuestion(
  suffix: string,
  status: string,
  resolutionDate: Date
): Promise<string> {
  const id = `${prefix}-${suffix}`;
  questionIds.push(id);
  await db.insert(questions).values({
    id,
    questionNumber: questionNumber++,
    text: `Widget expiry fixture ${suffix}`,
    scenarioId: 1,
    outcome: false,
    rank: 1,
    status,
    resolutionDate,
    updatedAt: new Date(),
  });
  return id;
}

afterAll(async () => {
  if (questionIds.length)
    await db.delete(questions).where(inArray(questions.id, questionIds));
});

let liveId = '';
let expiredId = '';
let resolvedId = '';
let viewerId = '';

beforeAll(async () => {
  const now = Date.now();
  liveId = await createQuestion(
    'live',
    'active',
    new Date(now + 24 * 60 * 60 * 1000)
  );
  expiredId = await createQuestion(
    'expired',
    'active',
    new Date(now - 60 * 60 * 1000)
  );
  resolvedId = await createQuestion(
    'resolved',
    'resolved',
    new Date(now - 24 * 60 * 60 * 1000)
  );

  viewerId = await generateSnowflakeId();
  await db.insert(users).values({
    id: viewerId,
    username: `widget-expiry-viewer-${viewerId}`,
    displayName: 'Widget Expiry Viewer',
    isTest: true,
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [viewerId]));
});

function expectOnlyLive(returnedIds: string[]) {
  // A live, still-tradeable market is listed.
  expect(returnedIds).toContain(liveId);
  // An expired but not-yet-resolved market must not be presented as an
  // active, tradeable market: the widget has no ended state and the buy
  // gate on the detail page rejects it as 'Market expired'.
  expect(returnedIds).not.toContain(expiredId);
  // Control: resolved markets are already excluded by the status filter.
  expect(returnedIds).not.toContain(resolvedId);
}

describe('markets widget expiry', () => {
  test('public (cached) widget lists only markets that can still be traded', async () => {
    const response = await getWidgetMarkets(
      new NextRequest('http://localhost/api/feed/widgets/markets')
    );
    const body = (await response.json()) as {
      success: boolean;
      markets: { id: string }[];
    };

    expect(body.success).toBe(true);
    expectOnlyLive(body.markets.map((m) => m.id));
  });

  test('authenticated widget lists only markets that can still be traded', async () => {
    const response = await getWidgetMarkets(
      new NextRequest('http://localhost/api/feed/widgets/markets', {
        headers: new Headers({ 'x-dev-user-id': viewerId }),
      })
    );
    const body = (await response.json()) as {
      success: boolean;
      markets: { id: string }[];
    };

    expect(body.success).toBe(true);
    expectOnlyLive(body.markets.map((m) => m.id));
  });
});
