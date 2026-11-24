/**
 * World Context — Active Markets Integration Test
 *
 * Evidence for the generateCurrentMarkets fix (feedforagents/feed):
 * `generateCurrentMarkets()` must exclude expired-but-unresolved markets
 * from the "Active Markets" string it builds for agent prompts.
 *
 * Same defect class as PR #2102 (admin trading stats), the
 * metrics-snapshot fix, and the game-service fix: the query counted
 * every unresolved market as active. This one is agent-facing in the
 * prompt itself: `generateWorldContext()` embeds this string in the
 * world context NPC agents read (via npc-group-dynamics-service), so an
 * expired market was presented as a market agents could still trade on
 * — even though buys on it are refused (PRD §8.1/§9.2: active means
 * open for trading).
 *
 * This test calls the function directly against a real Postgres
 * database:
 *
 * - With the fix: seeding one live market and one expired-but-unresolved
 *   market (both with very high yesShares so they rank in the top 5 the
 *   function returns) shows only the live market's question in the
 *   output string.
 * - Without the fix: the same seed shows both, because the expired
 *   market is still listed.
 *
 * The before/after pair is selected with WORLD_CONTEXT_EXPECT_BUGGY=1
 * for the pre-fix run; the default run asserts the fixed behavior. Each
 * run logs one `[evidence]` line with its correlation ID and the
 * resulting flags.
 *
 * Run with: bun run test:integration -- packages/testing/integration/world-context-active-markets.integration.test.ts
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db, generateSnowflakeId } from '@feed/db';
import { generateCurrentMarkets } from '../../engine/src/prompts/world-context';

const seededMarketIds: string[] = [];

afterAll(async () => {
  for (const id of seededMarketIds) {
    await db.market.delete({ where: { id } }).catch(() => {});
  }
});

describe('World Context — active markets exclude expired markets', () => {
  test('expired-but-unresolved markets are excluded from agent world context', async () => {
    const expectBuggy = process.env.WORLD_CONTEXT_EXPECT_BUGGY === '1';
    const correlationId = randomUUID();
    const tag = randomUUID().slice(0, 8);
    const now = Date.now();
    const liveText = `slop-world-context live market ${tag}`;
    const expiredText = `slop-world-context expired market ${tag}`;

    // Very high yesShares so both seeds rank in the top 5 the function
    // returns (it orders by yesShares desc, limit 5).
    const liveMarketId = await generateSnowflakeId();
    const expiredMarketId = await generateSnowflakeId();
    await db.market.create({
      data: {
        id: liveMarketId,
        question: liveText,
        yesShares: '10000000000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate: new Date(now + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await db.market.create({
      data: {
        id: expiredMarketId,
        question: expiredText,
        yesShares: '10000000000',
        noShares: '5000',
        liquidity: '10000',
        resolved: false,
        endDate: new Date(now - 60 * 60 * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    seededMarketIds.push(liveMarketId, expiredMarketId);

    const output = await generateCurrentMarkets();
    const foundLive = output.includes(liveText);
    const foundExpired = output.includes(expiredText);
    console.log(
      `[evidence] correlationId=${correlationId} foundLive=${foundLive} foundExpired=${foundExpired} output=${output.slice(0, 400)}`
    );

    expect(foundLive).toBe(true);
    // With the fix the expired market is excluded; without it, it is listed.
    expect(foundExpired).toBe(expectBuggy);
  });
});
