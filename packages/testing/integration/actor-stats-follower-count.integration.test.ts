/**
 * PRD §§9.5/12, MVP Phase5: actor profile follower counts and the public
 * follower list must use the same eligible human membership. Existing NPC
 * relationships are read as a baseline and are never inserted or deleted.
 * Only the server-only environment marker is stubbed; routes, auth, registry
 * lookup, SQL and fixture constraints execute their actual implementation.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  actorFollows,
  and,
  db,
  desc,
  eq,
  gameOnboarding,
  inArray,
  sql,
  userActorFollows,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';
import { z } from 'zod';

const statsSchema = z.object({
  stats: z.object({
    followers: z.number(),
    following: z.number(),
    posts: z.number(),
    actorFollowers: z.number(),
    userFollowers: z.number(),
  }),
});
const listSchema = z.object({
  followers: z.array(
    z.object({
      id: z.string(),
      isActor: z.boolean(),
      viewerFollows: z.boolean().optional(),
    })
  ),
  count: z.number(),
  hasMore: z.boolean(),
});
let GET_STATS: typeof import('../../../apps/web/src/app/api/actors/[actorId]/stats/route').GET;
let GET_FOLLOWERS: typeof import('../../../apps/web/src/app/api/users/[userId]/followers/route').GET;
let actorId: string;
let peerActorId: string;
let normalAId: string;
let normalBId: string;
let hiddenIds: string[];
let baselineRawUserFollowers: number;
let baselineVisibleUserFollowers: number;
let baselineListCount: number;
let baselineActorRows: Array<typeof actorFollows.$inferSelect>;

function ownership() {
  return {
    follows: new Map<string, typeof userActorFollows.$inferSelect>(),
    onboarding: new Map<string, typeof gameOnboarding.$inferSelect>(),
    pnl: new Map<string, typeof userPnLSnapshots.$inferSelect>(),
    whitelist: new Map<string, typeof whitelist.$inferSelect>(),
    configs: new Map<string, typeof whitelistConfig.$inferSelect>(),
    users: new Map<string, typeof users.$inferSelect>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

async function insertFollows(
  values: Array<typeof userActorFollows.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(userActorFollows).values(values).returning();
  for (const row of rows) receipt.follows.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserActorFollow RETURNING');
  return rows;
}

async function insertOnboarding(
  values: Array<typeof gameOnboarding.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(gameOnboarding).values(values).returning();
  for (const row of rows) receipt.onboarding.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete GameOnboarding RETURNING');
  return rows;
}

async function insertPnL(
  values: Array<typeof userPnLSnapshots.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(userPnLSnapshots).values(values).returning();
  for (const row of rows) receipt.pnl.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserPnLSnapshot RETURNING');
  return rows;
}

async function insertWhitelist(
  values: Array<typeof whitelist.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(whitelist).values(values).returning();
  for (const row of rows) receipt.whitelist.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Whitelist RETURNING');
  return rows;
}

async function insertConfigs(
  values: Array<typeof whitelistConfig.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(whitelistConfig).values(values).returning();
  for (const row of rows) receipt.configs.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete WhitelistConfig RETURNING');
  return rows;
}

async function insertUsers(
  values: Array<typeof users.$inferInsert>,
  receipt: Ownership = owned
) {
  const rows = await db.insert(users).values(values).returning();
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}

async function removeRows<Row extends { id: string }>(
  rows: Map<string, Row>,
  erase: (row: Row) => Promise<void>,
  read: (id: string) => Promise<Array<{ id: string }>>
) {
  return Promise.allSettled(
    [...rows.values()].map(async (row) => {
      await erase(row);
      if ((await read(row.id)).length)
        throw new Error(`Owned fixture row remains: ${row.id}`);
      rows.delete(row.id);
    })
  );
}
function assertCleanupSucceeded(results: PromiseSettledResult<void>[]) {
  const failures = results.flatMap((result) =>
    result.status === 'rejected'
      ? [
          result.reason instanceof Error
            ? result.reason
            : new Error('Unexpected cleanup failure'),
        ]
      : []
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      'Owned actor follower fixture cleanup incomplete'
    );
}
async function cleanup(receipt: Ownership) {
  const results = [
    ...(await removeRows(
      receipt.follows,
      async (row) => {
        await db
          .delete(userActorFollows)
          .where(
            and(
              eq(userActorFollows.id, row.id),
              sql`to_jsonb(${userActorFollows}) = to_jsonb(jsonb_populate_record(NULL::"UserActorFollow", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: userActorFollows.id })
          .from(userActorFollows)
          .where(eq(userActorFollows.id, id))
    )),
    ...(await removeRows(
      receipt.onboarding,
      async (row) => {
        await db
          .delete(gameOnboarding)
          .where(
            and(
              eq(gameOnboarding.id, row.id),
              sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: gameOnboarding.id })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.id, id))
    )),
    ...(await removeRows(
      receipt.pnl,
      async (row) => {
        await db
          .delete(userPnLSnapshots)
          .where(
            and(
              eq(userPnLSnapshots.id, row.id),
              sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: userPnLSnapshots.id })
          .from(userPnLSnapshots)
          .where(eq(userPnLSnapshots.id, id))
    )),
    ...(await removeRows(
      receipt.whitelist,
      async (row) => {
        await db
          .delete(whitelist)
          .where(
            and(
              eq(whitelist.id, row.id),
              sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: whitelist.id })
          .from(whitelist)
          .where(eq(whitelist.id, id))
    )),
    ...(await removeRows(
      receipt.configs,
      async (row) => {
        await db
          .delete(whitelistConfig)
          .where(
            and(
              eq(whitelistConfig.id, row.id),
              sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${JSON.stringify(row)}::jsonb))`
            )
          );
      },
      async (id) =>
        db
          .select({ id: whitelistConfig.id })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.id, id))
    )),
    ...(await removeRows(
      receipt.users,
      async (row) => {
        await db
          .delete(users)
          .where(
            and(
              eq(users.id, row.id),
              sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${JSON.stringify(row)}::jsonb))`,
              sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.grantedBy} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`,
              sql`NOT EXISTS (SELECT 1 FROM ${userActorFollows} WHERE ${userActorFollows.userId} = ${row.id})`
            )
          );
      },
      async (id) =>
        db.select({ id: users.id }).from(users).where(eq(users.id, id))
    )),
  ];
  assertCleanupSucceeded(results);
}

async function duplicateKey(operation: () => Promise<Array<{ id: string }>>) {
  try {
    await operation();
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      typeof cause !== 'object' ||
      cause === null ||
      !('code' in cause) ||
      cause.code !== '23505'
    )
      throw error;
    return;
  }
  throw new Error('Expected a real duplicate-key rejection');
}
async function readStats() {
  const response = await GET_STATS(
    new NextRequest(`http://localhost/api/actors/${actorId}/stats`),
    {
      params: Promise.resolve({ actorId }),
    }
  );
  expect(response.status).toBe(200);
  return statsSchema.parse(await response.json()).stats;
}
async function readFollowers(limit = 1, page = 1) {
  const response = await GET_FOLLOWERS(
    new NextRequest(
      `http://localhost/api/users/${actorId}/followers?page=${page}&limit=${limit}`
    ),
    { params: Promise.resolve({ userId: actorId }) }
  );
  expect(response.status).toBe(200);
  return listSchema.parse(await response.json());
}
const fixtureUser = (id: string, label: string, now: Date) => ({
  id,
  username: `f7-${label}-${id}`,
  displayName: `F7 ${label}`,
  isTest: false,
  isBanned: false,
  createdAt: now,
  updatedAt: now,
});

beforeAll(async () => {
  ({ GET: GET_STATS } = await import(
    '../../../apps/web/src/app/api/actors/[actorId]/stats/route'
  ));
  ({ GET: GET_FOLLOWERS } = await import(
    '../../../apps/web/src/app/api/users/[userId]/followers/route'
  ));
  const actors = StaticDataRegistry.getAllActors();
  const knownIds = new Set(actors.map((actor) => actor.id));
  const knownNames = new Set(
    actors
      .map((actor) => actor.username?.toLowerCase())
      .filter((name): name is string => !!name)
  );
  // A canonical target with eligible existing NPC edges makes human count/list
  // parity meaningful without changing any registry data or NPC relationship.
  for (const actor of actors) {
    const rows = await db
      .select()
      .from(actorFollows)
      .where(eq(actorFollows.followingId, actor.id))
      .orderBy(actorFollows.id);
    if (
      rows.every(
        (row) =>
          knownIds.has(row.followerId) ||
          knownNames.has(row.followerId.toLowerCase())
      )
    ) {
      actorId = actor.id;
      baselineActorRows = rows;
      break;
    }
  }
  const peer = actors.find((actor) => actor.id !== actorId);
  if (!actorId || !peer)
    throw new Error('Two canonical registry actors are required');
  peerActorId = peer.id;
  baselineRawUserFollowers = await db.userActorFollow.count({
    where: { actorId },
  });
  baselineListCount = (await readFollowers()).count;
  baselineVisibleUserFollowers = baselineListCount - baselineActorRows.length;
  expect(baselineVisibleUserFollowers).toBeGreaterThanOrEqual(0);
  const latest = await db
    .select({ createdAt: userActorFollows.createdAt })
    .from(userActorFollows)
    .where(eq(userActorFollows.actorId, actorId))
    .orderBy(desc(userActorFollows.createdAt))
    .limit(1);
  const timestamp =
    Math.max(
      Date.now(),
      latest[0]?.createdAt.getTime() ?? 0,
      ...baselineActorRows.map((row) => row.createdAt.getTime())
    ) + 1_000;
  const now = new Date();
  normalAId = await generateSnowflakeId();
  normalBId = await generateSnowflakeId();
  const flagged = await generateSnowflakeId();
  const prefix = `test-f7-${await generateSnowflakeId()}`;
  const banned = await generateSnowflakeId();
  hiddenIds = [flagged, prefix, banned];
  await insertUsers([
    fixtureUser(normalAId, 'normal-a', now),
    fixtureUser(normalBId, 'normal-b', now),
    { ...fixtureUser(flagged, 'flagged', now), isTest: true },
    fixtureUser(prefix, 'prefix', now),
    { ...fixtureUser(banned, 'banned', now), isBanned: true },
  ]);
  for (const [index, userId] of [
    normalAId,
    normalBId,
    ...hiddenIds,
  ].entries()) {
    await insertFollows([
      {
        id: await generateSnowflakeId(),
        userId,
        actorId,
        createdAt: new Date(timestamp + index),
      },
    ]);
  }
});
afterAll(async () => {
  await cleanup(owned);
  if (actorId && baselineActorRows) {
    expect(
      await db
        .select()
        .from(actorFollows)
        .where(eq(actorFollows.followingId, actorId))
        .orderBy(actorFollows.id)
    ).toEqual(baselineActorRows);
  }
});

describe('actor stats follower counts count only visible members', () => {
  it('fixture sanity: adds five raw user follows without changing NPC follows', async () => {
    expect(await db.userActorFollow.count({ where: { actorId } })).toBe(
      baselineRawUserFollowers + 5
    );
    expect(
      await db
        .select()
        .from(actorFollows)
        .where(eq(actorFollows.followingId, actorId))
        .orderBy(actorFollows.id)
    ).toEqual(baselineActorRows);
  });
  it('stats report the visible user-follower membership (2 of 5 added)', async () => {
    const stats = await readStats();
    expect(stats.userFollowers).toBe(baselineVisibleUserFollowers + 2);
    expect(stats.actorFollowers).toBe(baselineActorRows.length);
    expect(stats.followers).toBe(
      baselineActorRows.length + baselineVisibleUserFollowers + 2
    );
  });
  it('the real stats and follower-list pages agree on visible membership', async () => {
    const stats = await readStats();
    const first = await readFollowers(1, 1);
    const second = await readFollowers(1, 2);
    expect(first.count).toBe(baselineListCount + 2);
    expect(second.count).toBe(first.count);
    expect(stats.followers).toBe(first.count);
    expect(first.followers.map((row) => row.id)).toEqual([normalBId]);
    expect(second.followers.map((row) => row.id)).toEqual([normalAId]);
    expect(first.hasMore).toBe(true);
    for (const row of [...first.followers, ...second.followers]) {
      expect(hiddenIds).not.toContain(row.id);
      expect(row.viewerFollows).toBeUndefined();
    }
  });
});

describe('actor follower fixture ownership', () => {
  it('cleans partial acquisition and preserves every conflicting foreign tuple', async () => {
    const foreign = ownership();
    const partial = ownership();
    const now = new Date();
    let original: typeof users.$inferSelect | undefined;
    try {
      const [control] = await insertUsers(
        [fixtureUser(await generateSnowflakeId(), 'foreign', now)],
        foreign
      );
      const [subject] = await insertUsers(
        [fixtureUser(await generateSnowflakeId(), 'partial', now)],
        partial
      );
      if (!control || !subject)
        throw new Error('Missing acquired ownership controls');
      original = subject;
      const [controlFollow] = await insertFollows(
        [
          {
            id: await generateSnowflakeId(),
            userId: control.id,
            actorId,
            createdAt: now,
          },
        ],
        foreign
      );
      const [foreignChild] = await insertFollows(
        [
          {
            id: await generateSnowflakeId(),
            userId: subject.id,
            actorId: peerActorId,
            createdAt: now,
          },
        ],
        foreign
      );
      const [ownedChild] = await insertFollows(
        [
          {
            id: await generateSnowflakeId(),
            userId: subject.id,
            actorId,
            createdAt: now,
          },
        ],
        partial
      );
      if (!controlFollow || !foreignChild || !ownedChild)
        throw new Error('Missing acquired follow controls');
      const unacquiredId = await generateSnowflakeId();
      await duplicateKey(() =>
        insertUsers(
          [
            fixtureUser(unacquiredId, 'unacquired', now),
            { ...control, username: `f7-conflict-${crypto.randomUUID()}` },
          ],
          partial
        )
      );
      await duplicateKey(() =>
        insertFollows(
          [{ ...controlFollow, userId: unacquiredId, actorId: peerActorId }],
          partial
        )
      );
      expect(partial.users.size).toBe(1);
      expect(partial.follows.size).toBe(1);
      expect(
        await db.select().from(users).where(eq(users.id, unacquiredId))
      ).toEqual([]);
      await expect(cleanup(partial)).rejects.toThrow(
        'Owned actor follower fixture cleanup incomplete'
      );
      expect(
        await db
          .select()
          .from(userActorFollows)
          .where(eq(userActorFollows.id, ownedChild.id))
      ).toEqual([]);
      expect(
        await db.select().from(users).where(eq(users.id, subject.id))
      ).toEqual([subject]);
      expect(
        await db.select().from(users).where(eq(users.id, control.id))
      ).toEqual([control]);
      expect(
        await db
          .select()
          .from(userActorFollows)
          .where(eq(userActorFollows.id, controlFollow.id))
      ).toEqual([controlFollow]);
      expect(
        await db
          .select()
          .from(userActorFollows)
          .where(eq(userActorFollows.id, foreignChild.id))
      ).toEqual([foreignChild]);
    } finally {
      assertCleanupSucceeded([
        ...(await Promise.allSettled([cleanup(foreign)])),
        ...(await Promise.allSettled([cleanup(partial)])),
      ]);
    }
    if (!original) throw new Error('Missing partial acquisition control');
    expect(
      await db.select().from(users).where(eq(users.id, original.id))
    ).toEqual([]);
  });
  it('refuses all five destructive User FK paths and preserves complete foreign tuples', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    const rows: Array<typeof users.$inferSelect> = [];
    const now = new Date();
    try {
      for (const subject of subjects) {
        const [row] = await insertUsers(
          [fixtureUser(await generateSnowflakeId(), 'fk-subject', now)],
          subject
        );
        if (!row) throw new Error('Missing acquired FK subject');
        rows.push(row);
      }
      await insertOnboarding(
        [
          {
            id: await generateSnowflakeId(),
            userId: rows[0]!.id,
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
            userId: rows[1]!.id,
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
            userId: rows[2]!.id,
            grantedBy: rows[3]!.id,
            source: 'admin_manual',
            reason: 'Actor follower fixture FK refusal',
            grantedAt: now,
          },
        ],
        foreign
      );
      await insertConfigs(
        [
          {
            id: await generateSnowflakeId(),
            updatedBy: rows[4]!.id,
            updatedAt: now,
          },
        ],
        foreign
      );
      for (const [index, subject] of subjects.entries()) {
        await expect(cleanup(subject)).rejects.toThrow(
          'Owned actor follower fixture cleanup incomplete'
        );
        expect(subject.users.size).toBe(1);
        expect(
          await db.select().from(users).where(eq(users.id, rows[index]!.id))
        ).toEqual([rows[index]!]);
        for (const row of foreign.onboarding.values())
          expect(
            await db
              .select()
              .from(gameOnboarding)
              .where(eq(gameOnboarding.id, row.id))
          ).toEqual([row]);
        for (const row of foreign.pnl.values())
          expect(
            await db
              .select()
              .from(userPnLSnapshots)
              .where(eq(userPnLSnapshots.id, row.id))
          ).toEqual([row]);
        for (const row of foreign.whitelist.values())
          expect(
            await db.select().from(whitelist).where(eq(whitelist.id, row.id))
          ).toEqual([row]);
        for (const row of foreign.configs.values())
          expect(
            await db
              .select()
              .from(whitelistConfig)
              .where(eq(whitelistConfig.id, row.id))
          ).toEqual([row]);
      }
    } finally {
      assertCleanupSucceeded([
        ...(await Promise.allSettled([cleanup(foreign)])),
        ...(await Promise.allSettled(
          subjects.map((subject) => cleanup(subject))
        )),
      ]);
    }
    expect(
      await db
        .select()
        .from(users)
        .where(
          inArray(
            users.id,
            rows.map((row) => row.id)
          )
        )
    ).toEqual([]);
  });
});
