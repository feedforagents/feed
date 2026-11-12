/**
 * PRD section 12 / MVP Phase 5: Hot applies block/mute policy, including
 * repost originals, before selecting a filled page. Exercise the real HTTP
 * route and configured Steward JWT; do not replace optionalAuth.
 *
 * Run against a disposable local integration server and database. Its Hot
 * cache must start empty and be owned by the same acceptance run. These
 * requests alone do not prove cache hits: inspect the actual shared cache
 * independently for cold/warm acceptance and retire that owned server/cache
 * after fixture cleanup. This suite never clears a global/shared cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  comments,
  db,
  eq,
  gameOnboarding,
  posts,
  reactions,
  shares,
  sql,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { createStewardTestToken } from './helpers/steward-auth';

const baseUrl = new URL(
  process.env.TEST_BASE_URL ||
    process.env.TEST_API_URL ||
    'http://127.0.0.1:3100'
);
if (
  baseUrl.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname) ||
  baseUrl.username ||
  baseUrl.password
) {
  throw new Error('Hot moderation fixtures require an owned local HTTP server');
}

type HotResponse = {
  success: boolean;
  posts: Array<{ id: string; authorId: string }>;
  limit: number;
};
function ownership() {
  return {
    reactions: new Map<string, typeof reactions.$inferSelect>(),
    blocks: new Map<string, typeof userBlocks.$inferSelect>(),
    mutes: new Map<string, typeof userMutes.$inferSelect>(),
    posts: new Map<string, typeof posts.$inferSelect>(),
    onboarding: new Map<string, typeof gameOnboarding.$inferSelect>(),
    pnl: new Map<string, typeof userPnLSnapshots.$inferSelect>(),
    whitelist: new Map<string, typeof whitelist.$inferSelect>(),
    configs: new Map<string, typeof whitelistConfig.$inferSelect>(),
    users: new Map<string, typeof users.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
let viewerId: string;
let secondViewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockerAuthorId: string;
let visibleAuthorId: string;
const postIds = {
  blocked1: '',
  blocked2: '',
  muted: '',
  blocker: '',
  visible1: '',
  visible2: '',
  visible3: '',
  repostOfBlocked: '',
};

async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(users).values(values).returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}
async function insertPosts(
  values: Array<typeof posts.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(posts).values(values).returning();
  for (const row of rows) receipt.posts.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Post RETURNING');
  return rows;
}
async function insertBlocks(
  values: Array<typeof userBlocks.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userBlocks).values(values).returning();
  for (const row of rows) receipt.blocks.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserBlock RETURNING');
  return rows;
}
async function insertMutes(
  values: Array<typeof userMutes.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(userMutes).values(values).returning();
  for (const row of rows) receipt.mutes.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserMute RETURNING');
  return rows;
}
async function insertReactions(
  values: Array<typeof reactions.$inferInsert>,
  receipt = owned
) {
  const rows = await db.insert(reactions).values(values).returning();
  for (const row of rows) receipt.reactions.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Reaction RETURNING');
  return rows;
}

async function insertOnboarding(
  values: Array<typeof gameOnboarding.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(gameOnboarding).values(values).returning();
  for (const row of rows) receipt.onboarding.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete GameOnboarding RETURNING');
  return rows;
}

async function insertPnL(
  values: Array<typeof userPnLSnapshots.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(userPnLSnapshots).values(values).returning();
  for (const row of rows) receipt.pnl.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserPnLSnapshot RETURNING');
  return rows;
}

async function insertWhitelist(
  values: Array<typeof whitelist.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(whitelist).values(values).returning();
  for (const row of rows) receipt.whitelist.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Whitelist RETURNING');
  return rows;
}

async function insertConfigs(
  values: Array<typeof whitelistConfig.$inferInsert>,
  receipt: Ownership
) {
  const rows = await db.insert(whitelistConfig).values(values).returning();
  for (const row of rows) receipt.configs.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete WhitelistConfig RETURNING');
  return rows;
}

async function cleanup(receipt: Ownership) {
  // Acquire ownership only from successful INSERT RETURNING. Never delete a
  // conflicting or changed row; fail visibly and retain parents on a mismatch.
  for (const row of receipt.reactions.values()) {
    await db
      .delete(reactions)
      .where(
        and(
          eq(reactions.id, row.id),
          sql`to_jsonb(${reactions}) = to_jsonb(jsonb_populate_record(NULL::"Reaction", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: reactions.id })
      .from(reactions)
      .where(eq(reactions.id, row.id));
    if (remaining.length) throw new Error(`Owned Reaction remains: ${row.id}`);
    receipt.reactions.delete(row.id);
  }
  for (const row of receipt.blocks.values()) {
    await db
      .delete(userBlocks)
      .where(
        and(
          eq(userBlocks.id, row.id),
          sql`to_jsonb(${userBlocks}) = to_jsonb(jsonb_populate_record(NULL::"UserBlock", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(eq(userBlocks.id, row.id));
    if (remaining.length) throw new Error(`Owned UserBlock remains: ${row.id}`);
    receipt.blocks.delete(row.id);
  }
  for (const row of receipt.mutes.values()) {
    await db
      .delete(userMutes)
      .where(
        and(
          eq(userMutes.id, row.id),
          sql`to_jsonb(${userMutes}) = to_jsonb(jsonb_populate_record(NULL::"UserMute", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: userMutes.id })
      .from(userMutes)
      .where(eq(userMutes.id, row.id));
    if (remaining.length) throw new Error(`Owned UserMute remains: ${row.id}`);
    receipt.mutes.delete(row.id);
  }
  for (const row of [...receipt.posts.values()].reverse()) {
    await db
      .delete(posts)
      .where(
        and(
          eq(posts.id, row.id),
          sql`to_jsonb(${posts}) = to_jsonb(jsonb_populate_record(NULL::"Post", ${JSON.stringify(row)}::jsonb))`,
          sql`NOT EXISTS (SELECT 1 FROM ${reactions} WHERE ${reactions.postId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${comments} WHERE ${comments.postId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.postId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${posts} child WHERE child."id" <> ${row.id} AND (child."originalPostId" = ${row.id} OR child."commentOnPostId" = ${row.id} OR child."parentCommentId" = ${row.id}))`
        )
      );
    const remaining = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, row.id));
    if (remaining.length) throw new Error(`Owned Post remains: ${row.id}`);
    receipt.posts.delete(row.id);
  }
  for (const row of receipt.onboarding.values()) {
    await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, row.id),
          sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: gameOnboarding.id })
      .from(gameOnboarding)
      .where(eq(gameOnboarding.id, row.id));
    if (remaining.length)
      throw new Error(`Owned GameOnboarding remains: ${row.id}`);
    receipt.onboarding.delete(row.id);
  }
  for (const row of receipt.pnl.values()) {
    await db
      .delete(userPnLSnapshots)
      .where(
        and(
          eq(userPnLSnapshots.id, row.id),
          sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: userPnLSnapshots.id })
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.id, row.id));
    if (remaining.length)
      throw new Error(`Owned UserPnLSnapshot remains: ${row.id}`);
    receipt.pnl.delete(row.id);
  }
  for (const row of receipt.whitelist.values()) {
    await db
      .delete(whitelist)
      .where(
        and(
          eq(whitelist.id, row.id),
          sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: whitelist.id })
      .from(whitelist)
      .where(eq(whitelist.id, row.id));
    if (remaining.length) throw new Error(`Owned Whitelist remains: ${row.id}`);
    receipt.whitelist.delete(row.id);
  }
  for (const row of receipt.configs.values()) {
    await db
      .delete(whitelistConfig)
      .where(
        and(
          eq(whitelistConfig.id, row.id),
          sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${JSON.stringify(row)}::jsonb))`
        )
      );
    const remaining = await db
      .select({ id: whitelistConfig.id })
      .from(whitelistConfig)
      .where(eq(whitelistConfig.id, row.id));
    if (remaining.length)
      throw new Error(`Owned WhitelistConfig remains: ${row.id}`);
    receipt.configs.delete(row.id);
  }
  for (const row of receipt.users.values()) {
    await db.delete(users).where(
      and(
        eq(users.id, row.id),
        sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${JSON.stringify(row)}::jsonb))`,
        // Baseline User FKs can otherwise delete or null non-owned children.
        sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.grantedBy} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`,

        sql`NOT EXISTS (SELECT 1 FROM ${posts} WHERE ${posts.authorId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${comments} WHERE ${comments.authorId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${reactions} WHERE ${reactions.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${shares} WHERE ${shares.userId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE ${userBlocks.blockerId} = ${row.id} OR ${userBlocks.blockedId} = ${row.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${userMutes} WHERE ${userMutes.muterId} = ${row.id} OR ${userMutes.mutedId} = ${row.id})`
      )
    );
    const remaining = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, row.id));
    if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
    receipt.users.delete(row.id);
  }
}

beforeAll(async () => {
  // Missing server or configured JWT secret fails, never silently skips.
  // Do not mint/replace a secret or weaken the server's auth/rate-limit flags.
  await createStewardTestToken('hot-moderation-readiness');
  const health = await fetch(new URL('/api/health', baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  expect(health.status).toBe(200);
  [
    viewerId,
    secondViewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockerAuthorId,
    visibleAuthorId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const likerIds = await Promise.all(
    Array.from({ length: 12 }, () => generateSnowflakeId())
  );
  for (const key of Object.keys(postIds) as Array<keyof typeof postIds>) {
    postIds[key] = await generateSnowflakeId();
  }
  const now = new Date();
  await insertUsers(
    [
      viewerId,
      secondViewerId,
      blockedAuthorId,
      mutedAuthorId,
      blockerAuthorId,
      visibleAuthorId,
      ...likerIds,
    ].map((id) => ({
      id,
      username: `g${id}`,
      displayName: 'Hot moderation fixture',
      stewardId: [viewerId, secondViewerId].includes(id)
        ? `hotmod-${id}`
        : null,
      isTest: false,
      isBanned: false,
      createdAt: now,
      updatedAt: now,
    }))
  );
  await insertBlocks([
    {
      id: await generateSnowflakeId(),
      blockerId: viewerId,
      blockedId: blockedAuthorId,
      createdAt: now,
    },
    {
      id: await generateSnowflakeId(),
      blockerId: blockerAuthorId,
      blockedId: viewerId,
      createdAt: now,
    },
  ]);
  await insertMutes([
    {
      id: await generateSnowflakeId(),
      muterId: viewerId,
      mutedId: mutedAuthorId,
      createdAt: now,
    },
  ]);
  const rows = [
    { key: 'blocked1' as const, authorId: blockedAuthorId, likes: 12 },
    { key: 'blocked2' as const, authorId: blockedAuthorId, likes: 12 },
    { key: 'muted' as const, authorId: mutedAuthorId, likes: 11 },
    { key: 'blocker' as const, authorId: blockerAuthorId, likes: 10 },
    { key: 'visible1' as const, authorId: visibleAuthorId, likes: 1 },
    { key: 'visible2' as const, authorId: visibleAuthorId, likes: 1 },
    { key: 'visible3' as const, authorId: visibleAuthorId, likes: 1 },
  ];
  await insertPosts(
    rows.map((row) => ({
      id: postIds[row.key],
      authorId: row.authorId,
      content: `Hot moderation fixture ${row.key}`,
      timestamp: now,
      createdAt: now,
    }))
  );
  await insertPosts([
    {
      id: postIds.repostOfBlocked,
      authorId: visibleAuthorId,
      content: 'Hot moderation fixture repost',
      type: 'repost',
      originalPostId: postIds.blocked1,
      timestamp: now,
      createdAt: now,
    },
  ]);
  const reactionRows: Array<typeof reactions.$inferInsert> = [];
  for (const row of [...rows, { key: 'repostOfBlocked' as const, likes: 12 }]) {
    for (let i = 0; i < row.likes; i++) {
      reactionRows.push({
        id: await generateSnowflakeId(),
        postId: postIds[row.key],
        userId: likerIds[i]!,
        type: 'like',
        createdAt: now,
      });
    }
  }
  await insertReactions(reactionRows);
}, 120_000);

afterAll(async () => {
  await cleanup(owned);
}, 120_000);

async function fetchHot(
  limit: number,
  viewer: string | null,
  malformedToken = false
) {
  const headers: Record<string, string> = {};
  if (viewer)
    headers.authorization = `Bearer ${await createStewardTestToken(`hotmod-${viewer}`)}`;
  if (malformedToken)
    headers.authorization = 'Bearer malformed-opaque-hot-token';
  const response = await fetch(
    new URL(`/api/feed/hot?limit=${limit}`, baseUrl),
    {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    }
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as HotResponse;
  expect(body.success).toBe(true);
  expect(body.limit).toBe(limit);
  expect(Array.isArray(body.posts)).toBe(true);
  for (const post of body.posts) expect('originalAuthorId' in post).toBe(false);
  return body.posts;
}
const visibleIds = () =>
  [postIds.visible1, postIds.visible2, postIds.visible3].sort();
const allIds = () => Object.values(postIds).sort();

describe('GET /api/feed/hot viewer moderation over HTTP', () => {
  it('hides both block directions, mute and repost originals before filling a visible page', async () => {
    const page = await fetchHot(3, viewerId);
    expect(page.map((post) => post.id).sort()).toEqual(visibleIds());
    expect(
      page.some((post) =>
        [blockedAuthorId, mutedAuthorId, blockerAuthorId].includes(
          post.authorId
        )
      )
    ).toBe(false);
  });

  it('preserves the public feed for missing or malformed credentials', async () => {
    for (const malformed of [false, true]) {
      const top = await fetchHot(3, null, malformed);
      expect(top).toHaveLength(3);
      expect(top.some((post) => post.authorId === blockedAuthorId)).toBe(true);
      const all = await fetchHot(100, null, malformed);
      expect(all.map((post) => post.id).sort()).toEqual(allIds());
    }
  });

  it('keeps two viewers independent and observes a new mute on the next request', async () => {
    expect(
      (await fetchHot(100, secondViewerId)).map((post) => post.id).sort()
    ).toEqual(allIds());
    await insertMutes([
      {
        id: await generateSnowflakeId(),
        muterId: secondViewerId,
        mutedId: blockedAuthorId,
        createdAt: new Date(),
      },
    ]);
    const secondExpected = [
      postIds.muted,
      postIds.blocker,
      ...visibleIds(),
    ].sort();
    expect(
      (await fetchHot(100, secondViewerId)).map((post) => post.id).sort()
    ).toEqual(secondExpected);
    expect((await fetchHot(3, viewerId)).map((post) => post.id).sort()).toEqual(
      visibleIds()
    );
    expect((await fetchHot(100, null)).map((post) => post.id).sort()).toEqual(
      allIds()
    );
  });
});

describe('Hot fixture ownership', () => {
  it('cleans partial setup and preserves every colliding control tuple', async () => {
    const existing = ownership();
    const partial = ownership();
    const now = new Date();
    const acquire = async (receipt: Ownership, label: string) => {
      const userId = await generateSnowflakeId();
      const peerId = await generateSnowflakeId();
      const [user, peer] = await insertUsers(
        [userId, peerId].map((id) => ({
          id,
          username: `ghot-${id}`,
          displayName: label,
          createdAt: now,
          updatedAt: now,
        })),
        receipt
      );
      const [post] = await insertPosts(
        [
          {
            id: await generateSnowflakeId(),
            authorId: userId,
            content: label,
            timestamp: now,
            createdAt: now,
          },
        ],
        receipt
      );
      const [block] = await insertBlocks(
        [
          {
            id: await generateSnowflakeId(),
            blockerId: userId,
            blockedId: peerId,
            createdAt: now,
          },
        ],
        receipt
      );
      const [mute] = await insertMutes(
        [
          {
            id: await generateSnowflakeId(),
            muterId: userId,
            mutedId: peerId,
            createdAt: now,
          },
        ],
        receipt
      );
      if (!user || !peer || !post || !block || !mute)
        throw new Error('Missing acquired Hot collision fixture');
      const [reaction] = await insertReactions(
        [
          {
            id: await generateSnowflakeId(),
            postId: post.id,
            userId: peerId,
            type: 'like',
            createdAt: now,
          },
        ],
        receipt
      );
      if (!reaction) throw new Error('Missing acquired Hot collision reaction');
      return { user, peer, post, block, mute, reaction };
    };
    try {
      const sentinel = await acquire(existing, 'Hot existing control');
      const acquired = await acquire(partial, 'Hot partial setup');
      // Only the proposed primary IDs collide; alternate relation/unique fields
      // point to already-acquired partial rows and cannot hide that failure.
      await expect(
        insertUsers(
          [
            {
              ...sentinel.user,
              username: `ghot-${await generateSnowflakeId()}`,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertPosts(
          [
            {
              ...sentinel.post,
              authorId: acquired.user.id,
              content: 'rejected Hot post',
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertBlocks(
          [
            {
              ...sentinel.block,
              blockerId: acquired.peer.id,
              blockedId: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertMutes(
          [
            {
              ...sentinel.mute,
              muterId: acquired.peer.id,
              mutedId: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      await expect(
        insertReactions(
          [
            {
              ...sentinel.reaction,
              postId: acquired.post.id,
              userId: acquired.user.id,
            },
          ],
          partial
        )
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(partial.users.has(sentinel.user.id)).toBe(false);
      expect(partial.posts.has(sentinel.post.id)).toBe(false);
      expect(partial.blocks.has(sentinel.block.id)).toBe(false);
      expect(partial.mutes.has(sentinel.mute.id)).toBe(false);
      expect(partial.reactions.has(sentinel.reaction.id)).toBe(false);
      await cleanup(partial);
      for (const row of [acquired.user, acquired.peer]) {
        expect(
          await db.select().from(users).where(eq(users.id, row.id))
        ).toEqual([]);
      }
      expect(
        await db.select().from(posts).where(eq(posts.id, acquired.post.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(userBlocks)
          .where(eq(userBlocks.id, acquired.block.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(userMutes)
          .where(eq(userMutes.id, acquired.mute.id))
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(reactions)
          .where(eq(reactions.id, acquired.reaction.id))
      ).toEqual([]);
      for (const row of [sentinel.user, sentinel.peer]) {
        expect(
          await db.select().from(users).where(eq(users.id, row.id))
        ).toEqual([row]);
      }
      expect(
        await db.select().from(posts).where(eq(posts.id, sentinel.post.id))
      ).toEqual([sentinel.post]);
      expect(
        await db
          .select()
          .from(userBlocks)
          .where(eq(userBlocks.id, sentinel.block.id))
      ).toEqual([sentinel.block]);
      expect(
        await db
          .select()
          .from(userMutes)
          .where(eq(userMutes.id, sentinel.mute.id))
      ).toEqual([sentinel.mute]);
      expect(
        await db
          .select()
          .from(reactions)
          .where(eq(reactions.id, sentinel.reaction.id))
      ).toEqual([sentinel.reaction]);
    } finally {
      await cleanup(partial);
      await cleanup(existing);
    }
  });
});

describe('User cleanup preserves non-owned FK references', () => {
  it('refuses all five destructive User FK paths and leaves each complete control tuple unchanged', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    const subjectRows: Array<typeof users.$inferSelect> = [];
    const now = new Date();
    try {
      // Each User belongs to a different cleanup receipt. The referencing
      // controls belong to another receipt, so none authorizes their deletion.
      for (const subject of subjects) {
        const id = await generateSnowflakeId();
        const [row] = await insertUsers(
          [
            {
              id,
              username: `gfk-${id}`,
              displayName: 'User FK refusal control',
              createdAt: now,
              updatedAt: now,
            },
          ],
          subject
        );
        if (!row) throw new Error('Missing User refusal control');
        subjectRows.push(row);
      }
      await insertOnboarding(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[0]!.id,
            createdAt: now,
            updatedAt: now,
          },
        ],
        foreign
      );
      await insertPnL(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[1]!.id,
            snapshotAt: now,
            createdAt: now,
          },
        ],
        foreign
      );
      await insertWhitelist(
        [
          {
            id: await generateSnowflakeId(),
            userId: subjectRows[2]!.id,
            grantedBy: subjectRows[3]!.id,
            source: 'admin_manual',
            reason: 'User FK refusal control',
            grantedAt: now,
          },
        ],
        foreign
      );
      // A generated isolated row exercises the real FK without changing the
      // application singleton (id='default') or inventing a product setting.
      await insertConfigs(
        [
          {
            id: await generateSnowflakeId(),
            updatedBy: subjectRows[4]!.id,
            updatedAt: now,
          },
        ],
        foreign
      );

      for (const [index, subject] of subjects.entries()) {
        await expect(cleanup(subject)).rejects.toThrow('Owned User remains');
        const user = subjectRows[index]!;
        expect(subject.users.size).toBe(1);
        expect(
          await db.select().from(users).where(eq(users.id, user.id))
        ).toEqual([user]);
        for (const row of foreign.onboarding.values()) {
          expect(
            await db
              .select()
              .from(gameOnboarding)
              .where(eq(gameOnboarding.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.pnl.values()) {
          expect(
            await db
              .select()
              .from(userPnLSnapshots)
              .where(eq(userPnLSnapshots.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.whitelist.values()) {
          expect(
            await db.select().from(whitelist).where(eq(whitelist.id, row.id))
          ).toEqual([row]);
        }
        for (const row of foreign.configs.values()) {
          expect(
            await db
              .select()
              .from(whitelistConfig)
              .where(eq(whitelistConfig.id, row.id))
          ).toEqual([row]);
        }
      }
    } finally {
      // Only their independent successful RETURNING receipts authorize these
      // exact child deletes. Refusal never broadens cleanup or nulls a field.
      await cleanup(foreign);
      for (const subject of subjects) await cleanup(subject);
    }
  });
});
