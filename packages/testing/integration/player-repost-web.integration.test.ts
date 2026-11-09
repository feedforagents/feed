/** Run through `bun run test:integration <file>` against the runner's real Next server. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  dbWrite as db,
  eq,
  inArray,
  notifications,
  posts,
  shares,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { sharePost } from '../../api/src/services/share-service';

const ids: string[] = [];
let actor: string;
let author: string;
let postId: string;
let quoteId: string;
let jwt: string;
let base: string;

describe('real web unrepost route preserves response and account ownership', () => {
  beforeAll(async () => {
    base = process.env.TEST_BASE_URL ?? process.env.TEST_API_URL ?? '';
    if (!base)
      throw new Error(
        'Run this file through bun run test:integration to start the real Next server'
      );
    actor = await generateSnowflakeId();
    author = await generateSnowflakeId();
    ids.push(actor, author);
    await db.insert(users).values(
      ids.map((id) => ({
        id,
        stewardId: id,
        username: `webshare_${id}`,
        updatedAt: new Date(),
      }))
    );
    postId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: postId,
      authorId: author,
      content: 'Web share integration post',
      timestamp: new Date(Date.now() - 60_000),
    });
    quoteId = (await sharePost(actor, postId, 'An explicitly authored quote'))
      .repostId;
    // Locally signed integration identity, not evidence of live Steward login.
    jwt = await new SignJWT({ userId: actor })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setExpirationTime('5m')
      .sign(
        new TextEncoder().encode(
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
        )
      );
  });
  afterAll(async () => {
    if (!ids.length) return;
    await db.delete(notifications).where(inArray(notifications.userId, ids));
    await db.delete(shares).where(inArray(shares.userId, ids));
    await db.delete(posts).where(inArray(posts.authorId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });
  test('signed-in web account can explicitly remove its quote and gets existing JSON state', async () => {
    const response = await fetch(`${base}/api/posts/${postId}/share`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('"isShared":false');
    expect(
      await db.select().from(posts).where(eq(posts.id, quoteId))
    ).toHaveLength(0);
    expect(
      await db.select().from(posts).where(eq(posts.id, postId))
    ).toHaveLength(1);
  });
  test('repeated removal fails without changing the original post', async () => {
    const response = await fetch(`${base}/api/posts/${postId}/share`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(response.status).toBe(404);
    expect(
      await db.select().from(posts).where(eq(posts.id, postId))
    ).toHaveLength(1);
  });
});
