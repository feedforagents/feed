/** Real database and SDK public read parity. No inference output is mocked. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { cachedDb, getPublicProfile } from '@feed/api';
import {
  dbWrite as db,
  eq,
  inArray,
  mcpOAuthClients,
  mcpOAuthRequests,
  posts,
  reactions,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { FeedOAuthService, hash, opaque, serveFeedMcp } from '@feed/mcp';
import {
  FEED_ABOUT,
  FEED_HOW_TO_PLAY,
  generateSnowflakeId,
} from '@feed/shared';
import { z } from 'zod';

const origin = 'https://feed-public-read.example';
const service = new FeedOAuthService(origin);
const ids: string[] = [];
const clientIds: string[] = [];
let viewer: string;
let author: string;
let postId: string;
const resultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
  }),
});
async function call(name: string, args: object, token?: string) {
  const response = await serveFeedMcp(
    new Request(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    service,
    { about: FEED_ABOUT, howToPlay: FEED_HOW_TO_PLAY }
  );
  expect(response.status).toBe(200);
  return resultSchema.parse(await response.json()).result;
}
async function token(scopes: ('read' | 'social:write')[] = ['read']) {
  const client = await service.register({
    client_name: 'Public read test',
    redirect_uris: ['http://127.0.0.1/callback'],
  });
  clientIds.push(client.client_id);
  const verifier = 'p'.repeat(64);
  const browser = opaque('fmcpcb');
  const location = await service.authorize(
    {
      client_id: client.client_id,
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1/callback',
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      scope: scopes.join(' '),
    },
    browser
  );
  const request = new URL(location).searchParams.get('request');
  if (!request) throw new Error('Missing request');
  await service.approvalInfo(request, browser, viewer);
  const approval = await service.approve(
    request,
    browser,
    viewer,
    'approve',
    scopes
  );
  const code = new URL(approval.redirectUrl).searchParams.get('code');
  if (!code) throw new Error('Missing code');
  return (
    await service.exchange({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      code,
      code_verifier: verifier,
    })
  ).access_token;
}

describe('public post and profile MCP tools', () => {
  beforeAll(async () => {
    viewer = await generateSnowflakeId();
    author = await generateSnowflakeId();
    ids.push(viewer, author);
    await db.insert(users).values(
      ids.map((id) => ({
        id,
        stewardId: id,
        username: `read_${id}`,
        displayName: 'Readable profile',
        bio: 'Public biography only',
        email: `private-${id}@example.invalid`,
        walletAddress: `private-wallet-${id}`,
        showWalletPublic: false,
        profileComplete: true,
        tosAcceptedAt: new Date(),
        virtualBalance: '1234.56',
        updatedAt: new Date(),
      }))
    );
    postId = await generateSnowflakeId();
    await db.insert(posts).values({
      id: postId,
      authorId: author,
      content: 'Published public post',
      timestamp: new Date(Date.now() - 60_000),
    });
  });
  afterAll(async () => {
    if (clientIds.length)
      await db
        .delete(mcpOAuthRequests)
        .where(inArray(mcpOAuthRequests.clientId, clientIds));
    await db.delete(userBlocks).where(inArray(userBlocks.blockerId, ids));
    await db.delete(userMutes).where(inArray(userMutes.muterId, ids));
    await db.delete(reactions).where(inArray(reactions.userId, ids));
    await db.delete(posts).where(inArray(posts.authorId, ids));
    await db.delete(users).where(inArray(users.id, ids));
    if (clientIds.length)
      await db
        .delete(mcpOAuthClients)
        .where(inArray(mcpOAuthClients.id, clientIds));
  });
  test('anonymous callers read public content and whitelisted profiles without credentials', async () => {
    const post = await call('get_post', { postId });
    expect(post.isError).not.toBe(true);
    expect(post.content[0]?.text).toContain('Published public post');
    expect(post.content[0]?.text).not.toContain('isLiked');
    const profile = await call('get_profile', { identifier: author });
    const text = profile.content[0]?.text ?? '';
    expect(profile.isError).not.toBe(true);
    expect(text).toContain('Public biography only');
    for (const forbidden of [
      '@example.invalid',
      'private-wallet',
      'stewardId',
      'reputationPoints',
      'referralCode',
      'managedBy',
      'email',
    ])
      expect(text).not.toContain(forbidden);
  });
  test('MCP profile projection skips unused legacy web stats', async () => {
    const stats = spyOn(cachedDb, 'getUserProfileStats');
    try {
      expect(await getPublicProfile(author)).not.toBeNull();
      expect(stats).not.toHaveBeenCalled();
    } finally {
      stats.mockRestore();
    }
  });
  test('verified viewer flags require read scope; caller cannot substitute another viewer', async () => {
    await db.insert(reactions).values({
      id: await generateSnowflakeId(),
      userId: viewer,
      postId,
      type: 'like',
    });
    const read = await call('get_post', { postId }, await token());
    expect(read.content[0]?.text).toContain('"isLiked":true');
    const writeOnly = await call(
      'get_post',
      { postId },
      await token(['social:write'])
    );
    expect(writeOnly.content[0]?.text).not.toContain('isLiked');
    expect((await call('get_post', { postId, viewerId: author })).isError).toBe(
      true
    );
    expect(
      (await call('get_profile', { identifier: author, userId: viewer }))
        .isError
    ).toBe(true);
  });
  test('Social mode omits public profile game values', async () => {
    await db
      .update(users)
      .set({ uiMode: 'social' })
      .where(eq(users.id, viewer));
    const profile = await call(
      'get_profile',
      { identifier: author },
      await token()
    );
    expect(profile.isError).not.toBe(true);
    for (const field of ['points', 'lifetimePnL', '1234.56', 'currency'])
      expect(profile.content[0]?.text).not.toContain(field);
    await db.update(users).set({ uiMode: 'game' }).where(eq(users.id, viewer));
  });
  test('verified moderation applies in both block directions and mute', async () => {
    const access = await token();
    for (const direction of ['block', 'blocked-by', 'mute'] as const) {
      const id = await generateSnowflakeId();
      if (direction === 'mute')
        await db
          .insert(userMutes)
          .values({ id, muterId: viewer, mutedId: author });
      else
        await db.insert(userBlocks).values({
          id,
          blockerId: direction === 'block' ? viewer : author,
          blockedId: direction === 'block' ? author : viewer,
        });
      expect((await call('get_post', { postId }, access)).isError).toBe(true);
      expect(
        (await call('get_profile', { identifier: author }, access)).isError
      ).toBe(true);
      await db.delete(userBlocks).where(eq(userBlocks.id, id));
      await db.delete(userMutes).where(eq(userMutes.id, id));
    }
  });
  test('unknown, deleted and future posts never become successful content', async () => {
    expect(
      (await call('get_post', { postId: 'missing-public-read' })).isError
    ).toBe(true);
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, postId));
    expect((await call('get_post', { postId })).isError).toBe(true);
    await db
      .update(posts)
      .set({ deletedAt: null, timestamp: new Date(Date.now() + 60_000) })
      .where(eq(posts.id, postId));
    expect((await call('get_post', { postId })).isError).toBe(true);
    await db
      .update(posts)
      .set({ timestamp: new Date(Date.now() - 60_000) })
      .where(eq(posts.id, postId));
  });
  test('actual character handle emitted by a post resolves with optional @', async () => {
    const actor = StaticDataRegistry.getAllActors().find(
      (candidate) => !candidate.isTest
    );
    if (!actor) throw new Error('No real character pack loaded');
    const id = await generateSnowflakeId();
    await db.insert(posts).values({
      id,
      authorId: actor.id,
      content: 'Character public post',
      timestamp: new Date(Date.now() - 60_000),
    });
    try {
      const post = await call('get_post', { postId: id });
      const dto = z
        .object({ author: z.object({ handle: z.string() }) })
        .parse(JSON.parse(post.content[0]?.text ?? ''));
      const profile = await call('get_profile', {
        identifier: `@${dto.author.handle}`,
      });
      expect(profile.isError).not.toBe(true);
      expect(profile.content[0]?.text).toContain(actor.name);
      expect(profile.content[0]?.text).not.toContain('personality');
    } finally {
      await db.delete(posts).where(eq(posts.id, id));
    }
  });
  test('a visible quote never embeds a blocked original author content', async () => {
    const id = await generateSnowflakeId();
    await db.insert(posts).values({
      id,
      authorId: viewer,
      content: 'Visible own commentary',
      originalPostId: postId,
      timestamp: new Date(Date.now() - 30_000),
    });
    const blockId = await generateSnowflakeId();
    await db
      .insert(userBlocks)
      .values({ id: blockId, blockerId: viewer, blockedId: author });
    try {
      const quote = await call('get_post', { postId: id }, await token());
      expect(quote.isError).not.toBe(true);
      expect(quote.content[0]?.text).toContain('Visible own commentary');
      expect(quote.content[0]?.text).not.toContain('Published public post');
      expect(quote.content[0]?.text).not.toContain('originalPost');
    } finally {
      await db.delete(userBlocks).where(eq(userBlocks.id, blockId));
    }
  });
  test('real organization profiles resolve without exposing hidden configuration', async () => {
    const organization = StaticDataRegistry.getAllOrganizations()[0];
    if (!organization) throw new Error('No real organization pack loaded');
    const profile = await call('get_profile', { identifier: organization.id });
    expect(profile.isError).not.toBe(true);
    expect(profile.content[0]?.text).toContain(organization.name);
    expect(profile.content[0]?.text).not.toContain('postStyle');
  });
});
