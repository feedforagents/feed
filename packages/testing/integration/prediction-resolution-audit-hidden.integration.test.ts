/**
 * PRD §9.2: a prediction market's outcome stays hidden until it resolves, and
 * the proof is shown at resolution. markets-tick stores the resolution text,
 * proof link and confidence on the Question before payout, and keeps them
 * there while a low-confidence resolution waits in the admin review queue
 * (requiresManualReview + resolutionReviewStatus 'pending'). The market still
 * trades in that window, so the public routes must not return them yet.
 *
 * Real database, real route handlers. Only the server-only marker is stubbed.
 * The suite owns one Market + Question pair and deletes exactly those rows.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { db, eq, markets, questions, sql } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const STORED = {
  description: 'Held resolution text: the outcome was YES because ...',
  proofUrl: 'https://example.invalid/proof/held-resolution',
  confidence: 0.42,
};

const auditSchema = z.object({
  resolution: z.boolean().nullable(),
  reviewStatus: z.string().nullable(),
  confidence: z.number().nullable(),
  description: z.string().nullable(),
  proofUrl: z.string().nullable(),
});
const resolutionBodySchema = z.object({
  marketId: z.string(),
  resolutionAudit: auditSchema,
});
const detailBodySchema = z.object({
  market: z.object({
    id: z.string(),
    resolved: z.boolean(),
    resolutionAudit: auditSchema,
  }),
});

let GET_RESOLUTION: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/resolution/route').GET;
let GET_DETAIL: typeof import('../../../apps/web/src/app/api/markets/predictions/[id]/route').GET;
let marketId: string | undefined;
let questionInserted = false;
let marketInserted = false;
// Own rate-limit bucket so CI's shared anonymous public-read bucket can't 429 us.
let clientIp = '';

// Short response bodies printed for the PR evidence (EVIDENCE_LOG=1).
function evidence(label: string, body: unknown) {
  if (process.env.EVIDENCE_LOG === '1')
    console.log(`[evidence] ${label} ${JSON.stringify(body)}`);
}

async function readResolutionRoute() {
  if (!marketId) throw new Error('Owned market required');
  const id = marketId;
  const response = await GET_RESOLUTION(
    new NextRequest(
      `http://localhost/api/markets/predictions/${id}/resolution`,
      { headers: { 'x-forwarded-for': clientIp } }
    ),
    { params: Promise.resolve({ id }) }
  );
  expect(response.status).toBe(200);
  return resolutionBodySchema.parse(await response.json()).resolutionAudit;
}

async function readDetailRoute() {
  if (!marketId) throw new Error('Owned market required');
  const id = marketId;
  const response = await GET_DETAIL(
    new NextRequest(`http://localhost/api/markets/predictions/${id}`, {
      headers: { 'x-forwarded-for': clientIp },
    }),
    { params: Promise.resolve({ id }) }
  );
  expect(response.status).toBe(200);
  return detailBodySchema.parse(await response.json()).market;
}

beforeAll(async () => {
  ({ GET: GET_RESOLUTION } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/resolution/route'
  ));
  ({ GET: GET_DETAIL } = await import(
    '../../../apps/web/src/app/api/markets/predictions/[id]/route'
  ));

  const id = await generateSnowflakeId();
  const groups = BigInt(id).toString(16).padStart(16, '0').match(/.{4}/g);
  if (!groups) throw new Error('Resolution audit fixture IP allocation failed');
  clientIp = `2001:db8:1945:0:${groups.join(':')}`;
  marketId = id;
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  // Question ids share the market id (getPublicResolutionAudit joins on it).
  const [numberRow] = await db.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX("questionNumber"), 0) + 100000 AS next FROM "Question"`
  );
  if (!numberRow) throw new Error('Question number lookup returned no row');

  const insertedMarkets = await db
    .insert(markets)
    .values({
      id,
      question: 'Held-resolution evidence market',
      yesShares: '5000',
      noShares: '5000',
      liquidity: '10000',
      resolved: false,
      resolution: null,
      endDate: later,
      updatedAt: now,
    })
    .returning({ id: markets.id });
  marketInserted = insertedMarkets.length === 1;

  // The state markets-tick leaves behind for a low-confidence resolution:
  // proof stored, manual review pending, market not resolved, still trading.
  const insertedQuestions = await db
    .insert(questions)
    .values({
      id,
      questionNumber: Number(numberRow.next),
      marketId: id,
      text: 'Held-resolution evidence market',
      scenarioId: 1,
      outcome: true,
      rank: 1,
      resolutionDate: now,
      status: 'active',
      updatedAt: now,
      resolutionDescription: STORED.description,
      resolutionProofUrl: STORED.proofUrl,
      resolutionConfidence: STORED.confidence,
      requiresManualReview: true,
      resolutionReviewStatus: 'pending',
    })
    .returning({ id: questions.id });
  questionInserted = insertedQuestions.length === 1;
  expect(marketInserted && questionInserted).toBe(true);
});

afterAll(async () => {
  if (!marketId) return;
  if (questionInserted)
    await db.delete(questions).where(eq(questions.id, marketId));
  if (marketInserted) await db.delete(markets).where(eq(markets.id, marketId));
});

describe('prediction resolution audit stays hidden until resolution', () => {
  it('GET /api/markets/predictions/[id]/resolution hides held proof', async () => {
    const audit = await readResolutionRoute();
    evidence('unresolved /resolution resolutionAudit', audit);
    expect(audit.reviewStatus).toBe('pending');
    expect(audit.description).toBeNull();
    expect(audit.proofUrl).toBeNull();
    expect(audit.confidence).toBeNull();
    expect(audit.resolution).toBeNull();
  });

  it('GET /api/markets/predictions/[id] hides held proof in resolutionAudit', async () => {
    const market = await readDetailRoute();
    evidence('unresolved /[id] market.resolutionAudit', market.resolutionAudit);
    expect(market.resolved).toBe(false);
    expect(market.resolutionAudit.description).toBeNull();
    expect(market.resolutionAudit.proofUrl).toBeNull();
    expect(market.resolutionAudit.confidence).toBeNull();
    expect(market.resolutionAudit.resolution).toBeNull();
  });

  it('both routes return the stored proof once the market resolves', async () => {
    if (!marketId) throw new Error('Owned market required');
    const now = new Date();
    await db
      .update(questions)
      .set({
        requiresManualReview: false,
        resolutionReviewStatus: 'approved',
        resolutionReviewedBy: 'system',
        resolutionReviewedAt: now,
        resolvedOutcome: true,
        status: 'resolved',
        updatedAt: now,
      })
      .where(eq(questions.id, marketId));
    await db
      .update(markets)
      .set({ resolved: true, resolution: true, updatedAt: now })
      .where(eq(markets.id, marketId));

    const audit = await readResolutionRoute();
    evidence('resolved /resolution resolutionAudit', audit);
    expect(audit.resolution).toBe(true);
    expect(audit.description).toBe(STORED.description);
    expect(audit.proofUrl).toBe(STORED.proofUrl);
    expect(audit.confidence).toBe(STORED.confidence);

    const market = await readDetailRoute();
    expect(market.resolved).toBe(true);
    expect(market.resolutionAudit.description).toBe(STORED.description);
    expect(market.resolutionAudit.proofUrl).toBe(STORED.proofUrl);
    expect(market.resolutionAudit.confidence).toBe(STORED.confidence);
  });
});
