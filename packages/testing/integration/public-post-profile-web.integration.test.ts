/** Real HTTP parity/visibility tests, run with the standard integration server harness. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  dbWrite as db,
  eq,
  inArray,
  posts,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';

let base: string;
let viewer: string;
let author: string;
let quoteAuthor: string;
let postId: string;
let quoteId: string;
let jwt: string;
const ids: string[] = [];
async function clearModeration() {
  if (!ids.length) return;
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, ids));
  await db.delete(userMutes).where(inArray(userMutes.muterId, ids));
}
async function get(path: string, authenticated = true) {
  return fetch(`${base}${path}`, {
    headers: authenticated ? { Authorization: `Bearer ${jwt}` } : {},
  });
}

describe('public web post/profile viewer moderation', () => {
  beforeAll(async () => {
    base = process.env.TEST_BASE_URL ?? '';
    if (!base)
      throw new Error(
        'Run through bun run test:integration to start the real Next server'
      );
    for (let i = 0; i < 3; i++) ids.push(await generateSnowflakeId());
    [viewer, author, quoteAuthor] = ids as [string, string, string];
    await db.insert(users).values(
      ids.map((id) => ({
        id,
        stewardId: id,
        username: `public_${id}`,
        displayName: 'Public read test',
        bio: 'A public biography',
        updatedAt: new Date(),
      }))
    );
    postId = await generateSnowflakeId();
    quoteId = await generateSnowflakeId();
    await db.insert(posts).values([
      {
        id: postId,
        authorId: author,
        content: 'Original public fixture content',
        timestamp: new Date(Date.now() - 60_000),
      },
      {
        id: quoteId,
        authorId: quoteAuthor,
        content: 'Visible quote commentary',
        originalPostId: postId,
        timestamp: new Date(Date.now() - 30_000),
      },
    ]);
    jwt = await new SignJWT({ userId: viewer })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('steward')
      .setExpirationTime('10m')
      .sign(
        new TextEncoder().encode(
          process.env.STEWARD_JWT_SECRET || 'dev-jwt-secret-change-in-prod'
        )
      );
  });
  afterAll(async () => {
    await clearModeration();
    if (!ids.length) return;
    await db.delete(posts).where(inArray(posts.authorId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });
  test('blocked viewer cannot retrieve excluded author post or profile', async () => {
    await clearModeration();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: viewer,
      blockedId: author,
    });
    const post = await get(`/api/posts/${postId}`);
    expect(post.status).toBe(404);
    expect((await get(`/api/posts/${postId}`, false)).status).toBe(200);
    await clearModeration();
  });
  test('blocked viewer profile read hides the public biography', async () => {
    await clearModeration();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: viewer,
      blockedId: author,
    });
    const profile = await get(`/api/users/${author}/profile`);
    expect(profile.status).toBe(200);
    expect(JSON.stringify(await profile.json())).not.toContain(
      'A public biography'
    );
    await clearModeration();
  });
  test('both block directions and mute affect verified reads, not anonymous browsing', async () => {
    for (const kind of ['blocked-by', 'muted'] as const) {
      await clearModeration();
      if (kind === 'blocked-by')
        await db.insert(userBlocks).values({
          id: await generateSnowflakeId(),
          blockerId: author,
          blockedId: viewer,
        });
      else
        await db.insert(userMutes).values({
          id: await generateSnowflakeId(),
          muterId: viewer,
          mutedId: author,
        });
      expect((await get(`/api/posts/${postId}?userId=${author}`)).status).toBe(
        404
      );
      const profile = await get(
        `/api/users/${author}/profile?viewerId=${author}`
      );
      expect(JSON.stringify(await profile.json())).not.toContain(
        'A public biography'
      );
      expect((await get(`/api/posts/${postId}`, false)).status).toBe(200);
    }
    await clearModeration();
  });
  test('nested original content is omitted for blocked, deleted, or future authors/posts', async () => {
    await clearModeration();
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId: viewer,
      blockedId: author,
    });
    const blocked = await get(`/api/posts/${quoteId}`);
    const blockedBody = JSON.stringify(await blocked.json());
    expect(blocked.status).toBe(200);
    expect(blockedBody).toContain('Visible quote commentary');
    expect(blockedBody).not.toContain('Original public fixture content');
    expect(blockedBody).not.toContain('originalPostId');
    await clearModeration();
    for (const state of ['deleted', 'future'] as const) {
      await db
        .update(posts)
        .set({
          deletedAt: state === 'deleted' ? new Date() : null,
          timestamp: new Date(Date.now() + 60_000),
        })
        .where(eq(posts.id, postId));
      const response = await get(`/api/posts/${quoteId}`);
      expect(JSON.stringify(await response.json())).not.toContain(
        'Original public fixture content'
      );
    }
    await db
      .update(posts)
      .set({ deletedAt: null, timestamp: new Date(Date.now() - 60_000) })
      .where(eq(posts.id, postId));
  });
  test('web success DTO and private viewer caching remain compatible', async () => {
    await clearModeration();
    const response = await get(`/api/posts/${postId}`);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain('"data":');
    expect(body).toContain('"isLiked":false');
    expect(body).toContain('"shareCount":0');
    expect(response.headers.get('cache-control')).toContain('private');
    const profile = await get(`/api/users/${author}/profile`);
    expect(profile.headers.get('cache-control')).toContain('private');
    expect(JSON.stringify(await profile.json())).toContain('"stats":');
    expect((await get('/api/posts/nonexistent-fixture')).status).toBe(404);
  });
});
