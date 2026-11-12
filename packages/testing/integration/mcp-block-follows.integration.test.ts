/**
 * PRD section 12 / MVP Phase 1: MCP block must sever both follow directions
 * atomically, using the same pair lock as the existing website follow/block.
 * Requires an owned disposable local integration database with current schema.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import {
  and,
  dbWrite as db,
  eq,
  follows,
  gameOnboarding,
  inArray,
  or,
  sql,
  userBlocks,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeBlockUser } from '../../mcp/src/handlers/tool-handlers';

// Preserve PostgreSQL timestamp precision and full row values at acquisition.
// JSON travels as text before the jsonb cast, avoiding driver JSON scalar encoding.
type CapturedRow = { id: string; canonical: string };

function ownership() {
  return {
    users: new Map<string, CapturedRow>(),
    follows: new Map<string, CapturedRow>(),
    userBlocks: new Map<string, CapturedRow>(),
    gameOnboarding: new Map<string, CapturedRow>(),
    userPnLSnapshots: new Map<string, CapturedRow>(),
    whitelist: new Map<string, CapturedRow>(),
    whitelistConfig: new Map<string, CapturedRow>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();

async function insertUser(
  values: Array<typeof users.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}

async function insertFollow(
  values: Array<typeof follows.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(follows)
    .values(values)
    .returning({
      id: follows.id,
      canonical: sql<string>`to_jsonb(${follows})::text`,
    });
  for (const row of rows) receipt.follows.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Follow RETURNING');
  return rows;
}

async function insertUserBlock(
  values: Array<typeof userBlocks.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(userBlocks)
    .values(values)
    .returning({
      id: userBlocks.id,
      canonical: sql<string>`to_jsonb(${userBlocks})::text`,
    });
  for (const row of rows) receipt.userBlocks.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserBlock RETURNING');
  return rows;
}

async function insertGameOnboarding(
  values: Array<typeof gameOnboarding.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(gameOnboarding)
    .values(values)
    .returning({
      id: gameOnboarding.id,
      canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
    });
  for (const row of rows) receipt.gameOnboarding.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete GameOnboarding RETURNING');
  return rows;
}

async function insertUserPnLSnapshot(
  values: Array<typeof userPnLSnapshots.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(userPnLSnapshots)
    .values(values)
    .returning({
      id: userPnLSnapshots.id,
      canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
    });
  for (const row of rows) receipt.userPnLSnapshots.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserPnLSnapshot RETURNING');
  return rows;
}

async function insertWhitelist(
  values: Array<typeof whitelist.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(whitelist)
    .values(values)
    .returning({
      id: whitelist.id,
      canonical: sql<string>`to_jsonb(${whitelist})::text`,
    });
  for (const row of rows) receipt.whitelist.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Whitelist RETURNING');
  return rows;
}

async function insertWhitelistConfig(
  values: Array<typeof whitelistConfig.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(whitelistConfig)
    .values(values)
    .returning({
      id: whitelistConfig.id,
      canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
    });
  for (const row of rows) receipt.whitelistConfig.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete WhitelistConfig RETURNING');
  return rows;
}

async function createUser(receipt = owned): Promise<string> {
  const id = await generateSnowflakeId();
  await insertUser(
    [{ id, username: `blk_${id}`, isActor: false, updatedAt: new Date() }],
    receipt
  );
  return id;
}
async function follow(
  followerId: string,
  followingId: string,
  receipt = owned
): Promise<void> {
  await insertFollow(
    [{ id: await generateSnowflakeId(), followerId, followingId }],
    receipt
  );
}

async function block(...args: Parameters<typeof executeBlockUser>) {
  const [agent, input] = args;
  const before = await db
    .select({
      id: userBlocks.id,
      canonical: sql<string>`to_jsonb(${userBlocks})::text`,
    })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, agent.userId),
        eq(userBlocks.blockedId, input.userId)
      )
    );
  for (const row of before) {
    if (owned.userBlocks.get(row.id)?.canonical !== row.canonical) {
      throw new Error('Refusing to adopt a pre-existing UserBlock');
    }
  }
  const result = await executeBlockUser(...args);
  // The successful handler is the only writer for these freshly owned users.
  // Acquire its exact committed row before assertions, never all touching rows.
  const rows = await db
    .select({
      id: userBlocks.id,
      canonical: sql<string>`to_jsonb(${userBlocks})::text`,
    })
    .from(userBlocks)
    .where(
      and(
        eq(userBlocks.blockerId, agent.userId),
        eq(userBlocks.blockedId, input.userId)
      )
    );
  for (const row of rows) {
    if (!before.some((prior) => prior.id === row.id))
      owned.userBlocks.set(row.id, row);
  }
  return result;
}

async function cleanup(receipt: Ownership) {
  for (const row of receipt.follows.values()) {
    await db
      .delete(follows)
      .where(
        and(
          eq(follows.id, row.id),
          sql`to_jsonb(${follows}) = to_jsonb(jsonb_populate_record(NULL::"Follow", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: follows.id,
        canonical: sql<string>`to_jsonb(${follows})::text`,
      })
      .from(follows)
      .where(eq(follows.id, row.id));
    if (remaining.length) throw new Error(`Owned Follow remains: ${row.id}`);
    receipt.follows.delete(row.id);
  }
  for (const row of receipt.userBlocks.values()) {
    await db
      .delete(userBlocks)
      .where(
        and(
          eq(userBlocks.id, row.id),
          sql`to_jsonb(${userBlocks}) = to_jsonb(jsonb_populate_record(NULL::"UserBlock", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: userBlocks.id,
        canonical: sql<string>`to_jsonb(${userBlocks})::text`,
      })
      .from(userBlocks)
      .where(eq(userBlocks.id, row.id));
    if (remaining.length) throw new Error(`Owned UserBlock remains: ${row.id}`);
    receipt.userBlocks.delete(row.id);
  }
  for (const row of receipt.gameOnboarding.values()) {
    await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, row.id),
          sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: gameOnboarding.id,
        canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
      })
      .from(gameOnboarding)
      .where(eq(gameOnboarding.id, row.id));
    if (remaining.length)
      throw new Error(`Owned GameOnboarding remains: ${row.id}`);
    receipt.gameOnboarding.delete(row.id);
  }
  for (const row of receipt.userPnLSnapshots.values()) {
    await db
      .delete(userPnLSnapshots)
      .where(
        and(
          eq(userPnLSnapshots.id, row.id),
          sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: userPnLSnapshots.id,
        canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
      })
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.id, row.id));
    if (remaining.length)
      throw new Error(`Owned UserPnLSnapshot remains: ${row.id}`);
    receipt.userPnLSnapshots.delete(row.id);
  }
  for (const row of receipt.whitelist.values()) {
    await db
      .delete(whitelist)
      .where(
        and(
          eq(whitelist.id, row.id),
          sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: whitelist.id,
        canonical: sql<string>`to_jsonb(${whitelist})::text`,
      })
      .from(whitelist)
      .where(eq(whitelist.id, row.id));
    if (remaining.length) throw new Error(`Owned Whitelist remains: ${row.id}`);
    receipt.whitelist.delete(row.id);
  }
  for (const row of receipt.whitelistConfig.values()) {
    await db
      .delete(whitelistConfig)
      .where(
        and(
          eq(whitelistConfig.id, row.id),
          sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: whitelistConfig.id,
        canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
      })
      .from(whitelistConfig)
      .where(eq(whitelistConfig.id, row.id));
    if (remaining.length)
      throw new Error(`Owned WhitelistConfig remains: ${row.id}`);
    receipt.whitelistConfig.delete(row.id);
  }
  for (const row of receipt.users.values()) {
    await db
      .delete(users)
      .where(
        and(
          eq(users.id, row.id),
          sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${row.canonical}::text::jsonb))`,
          sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id} OR ${whitelist.grantedBy} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followerId} = ${row.id} OR ${follows.followingId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE ${userBlocks.blockerId} = ${row.id} OR ${userBlocks.blockedId} = ${row.id})`
        )
      );
    const remaining = await db
      .select({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      })
      .from(users)
      .where(eq(users.id, row.id));
    if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
    receipt.users.delete(row.id);
  }
}
async function followIdsBetween(
  leftId: string,
  rightId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: follows.id })
    .from(follows)
    .where(
      or(
        and(eq(follows.followerId, leftId), eq(follows.followingId, rightId)),
        and(eq(follows.followerId, rightId), eq(follows.followingId, leftId))
      )
    );
  return rows.map((row) => row.id);
}

describe('MCP block_user follow edges', () => {
  afterAll(async () => {
    await cleanup(owned);
  });

  it('removes both follow directions and leaves an unrelated follow', async () => {
    const blockerId = await createUser();
    const blockedId = await createUser();
    const otherId = await createUser();
    await follow(blockerId, blockedId);
    await follow(blockedId, blockerId);
    await follow(blockerId, otherId);

    const result = await block(
      { agentId: blockerId, userId: blockerId },
      { userId: blockedId }
    );

    expect(result).toEqual({ success: true });
    const blocks = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, blockerId),
          eq(userBlocks.blockedId, blockedId)
        )
      );
    expect(blocks).toHaveLength(1);
    expect(await followIdsBetween(blockerId, blockedId)).toEqual([]);

    const unrelated = await db
      .select({ id: follows.id })
      .from(follows)
      .where(
        and(eq(follows.followerId, blockerId), eq(follows.followingId, otherId))
      );
    expect(unrelated).toHaveLength(1);
  });

  it('removes follow edges that survived an earlier block row', async () => {
    const blockerId = await createUser();
    const blockedId = await createUser();
    await insertUserBlock([
      {
        id: await generateSnowflakeId(),
        blockerId,
        blockedId,
      },
    ]);
    await follow(blockerId, blockedId);
    await follow(blockedId, blockerId);

    const result = await block(
      { agentId: blockerId, userId: blockerId },
      { userId: blockedId }
    );

    expect(result).toEqual({ success: true });
    const blocks = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(
        and(
          eq(userBlocks.blockerId, blockerId),
          eq(userBlocks.blockedId, blockedId)
        )
      );
    expect(blocks).toHaveLength(1);
    expect(await followIdsBetween(blockerId, blockedId)).toEqual([]);
  });

  it('does not create a block for a missing user', async () => {
    const blockerId = await createUser();
    const missingId = await generateSnowflakeId();

    await expect(
      block({ agentId: blockerId, userId: blockerId }, { userId: missingId })
    ).rejects.toThrow(`User ${missingId} not found`);

    const blocks = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, blockerId));
    expect(blocks).toEqual([]);
  });

  it('commits reciprocal blocks without opposite-order follow deadlocks', async () => {
    const [leftId, rightId] = [await createUser(), await createUser()].sort();
    if (!leftId || !rightId) throw new Error('Missing owned fixture IDs');
    await follow(leftId, rightId);
    await follow(rightId, leftId);

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for this test');
    const connection = new Bun.SQL(databaseUrl);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = (_pid: number) => {};
    const prepared = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const barrier = connection.begin(async (tx) => {
      await tx`SELECT id FROM "Follow"
        WHERE "followerId" = ${rightId} AND "followingId" = ${leftId}
        FOR UPDATE`;
      const [row] = await tx`SELECT pg_backend_pid() AS pid`;
      ready(Number(row.pid));
      await held;
    });
    const operations: ReturnType<typeof executeBlockUser>[] = [];

    async function waitForBlockedCalls(barrierPid: number, count: number) {
      for (let attempt = 0; attempt < 200; attempt++) {
        // Follow the blocker chain from our owned row-lock transaction only.
        // This proves the actual handler DELETEs overlap, without module mocks
        // or triggers and without observing unrelated database activity.
        const [row] = await connection`
          WITH RECURSIVE waiting(pid) AS (
            SELECT ${barrierPid}::integer
            UNION
            SELECT a.pid FROM pg_stat_activity a
            JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
          ) SELECT count(*)::integer - 1 AS count FROM waiting`;
        if (Number(row.count) >= count) return;
        await Bun.sleep(25);
      }
      throw new Error(
        'Actual block calls did not reach the owned lock barrier'
      );
    }

    try {
      const barrierPid = await prepared;
      operations.push(
        block({ agentId: rightId, userId: rightId }, { userId: leftId })
      );
      await waitForBlockedCalls(barrierPid, 1);
      operations.push(
        block({ agentId: leftId, userId: leftId }, { userId: rightId })
      );
      const outcomes = Promise.allSettled(operations);
      await waitForBlockedCalls(barrierPid, 2);
      release();
      await barrier;
      const results = await outcomes;
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      const blocks = await db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(
          and(
            inArray(userBlocks.blockerId, [leftId, rightId]),
            inArray(userBlocks.blockedId, [leftId, rightId])
          )
        );
      expect(blocks).toHaveLength(2);
      expect(await followIdsBetween(leftId, rightId)).toEqual([]);
    } finally {
      release();
      await barrier;
      await Promise.allSettled(operations);
      await connection.close();
    }
  });

  it('retains conflicting rows after partial fixture acquisition', async () => {
    const control = ownership();
    const partial = ownership();
    try {
      const left = await createUser(control);
      const right = await createUser(control);
      await follow(left, right, control);
      await insertUserBlock(
        [
          {
            id: await generateSnowflakeId(),
            blockerId: right,
            blockedId: left,
          },
        ],
        control
      );
      const user = control.users.get(left);
      const edge = [...control.follows.values()][0];
      const blocked = [...control.userBlocks.values()][0];
      if (!user || !edge || !blocked)
        throw new Error('Missing collision controls');
      await createUser(partial);
      let collisions = 0;
      for (const attempt of [
        () =>
          insertUser(
            [
              {
                id: user.id,
                username: `collision_${right}`,
                updatedAt: new Date(),
              },
            ],
            partial
          ),
        () =>
          insertFollow(
            [{ id: edge.id, followerId: right, followingId: left }],
            partial
          ),
        () =>
          insertUserBlock(
            [{ id: blocked.id, blockerId: left, blockedId: right }],
            partial
          ),
      ]) {
        try {
          await attempt();
          throw new Error('Expected primary key collision');
        } catch (error) {
          const cause =
            error instanceof Error && 'cause' in error ? error.cause : error;
          if (
            !cause ||
            typeof cause !== 'object' ||
            !('code' in cause) ||
            cause.code !== '23505' ||
            !('constraint_name' in cause) ||
            !['User_pkey', 'Follow_pkey', 'UserBlock_pkey'].includes(
              String(cause.constraint_name)
            )
          )
            throw error;
          collisions++;
        }
      }
      expect(collisions).toBe(3);
      expect(partial.follows.size).toBe(0);
      expect(partial.userBlocks.size).toBe(0);
      await cleanup(partial);
      expect(
        await db
          .select({
            id: users.id,
            canonical: sql<string>`to_jsonb(${users})::text`,
          })
          .from(users)
          .where(eq(users.id, left))
      ).toEqual([user]);
      expect(
        await db
          .select({
            id: follows.id,
            canonical: sql<string>`to_jsonb(${follows})::text`,
          })
          .from(follows)
          .where(eq(follows.id, edge.id))
      ).toEqual([edge]);
      expect(
        await db
          .select({
            id: userBlocks.id,
            canonical: sql<string>`to_jsonb(${userBlocks})::text`,
          })
          .from(userBlocks)
          .where(eq(userBlocks.id, blocked.id))
      ).toEqual([blocked]);
    } finally {
      await cleanup(partial);
      await cleanup(control);
    }
  });

  it('refuses User cleanup while foreign destructive references remain', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    try {
      const ids: string[] = [];
      for (const subject of subjects) ids.push(await createUser(subject));
      const [onboardingId, pnlId, whitelistedId, grantorId, configId] = ids;
      if (!onboardingId || !pnlId || !whitelistedId || !grantorId || !configId)
        throw new Error('Missing foreign-reference subjects');
      const now = new Date();
      await insertGameOnboarding(
        [
          {
            id: await generateSnowflakeId(),
            userId: onboardingId,
            updatedAt: now,
          },
        ],
        foreign
      );
      await insertUserPnLSnapshot(
        [
          {
            id: await generateSnowflakeId(),
            userId: pnlId,
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
            userId: whitelistedId,
            grantedBy: grantorId,
            source: 'admin_manual',
            grantedAt: now,
          },
        ],
        foreign
      );
      await insertWhitelistConfig(
        [
          {
            id: await generateSnowflakeId(),
            updatedBy: configId,
            updatedAt: now,
          },
        ],
        foreign
      );
      const before = {
        onboarding: await db
          .select({
            id: gameOnboarding.id,
            canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
          })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.userId, onboardingId)),
        pnl: await db
          .select({
            id: userPnLSnapshots.id,
            canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
          })
          .from(userPnLSnapshots)
          .where(eq(userPnLSnapshots.userId, pnlId)),
        whitelist: await db
          .select({
            id: whitelist.id,
            canonical: sql<string>`to_jsonb(${whitelist})::text`,
          })
          .from(whitelist)
          .where(eq(whitelist.userId, whitelistedId)),
        configs: await db
          .select({
            id: whitelistConfig.id,
            canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
          })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.updatedBy, configId)),
      };
      for (const subject of subjects) {
        await expect(cleanup(subject)).rejects.toThrow('Owned User remains');
        const row = [...subject.users.values()][0];
        if (!row) throw new Error('Lost refused User receipt');
        expect(
          await db
            .select({
              id: users.id,
              canonical: sql<string>`to_jsonb(${users})::text`,
            })
            .from(users)
            .where(eq(users.id, row.id))
        ).toEqual([row]);
        expect({
          onboarding: await db
            .select({
              id: gameOnboarding.id,
              canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
            })
            .from(gameOnboarding)
            .where(eq(gameOnboarding.userId, onboardingId)),
          pnl: await db
            .select({
              id: userPnLSnapshots.id,
              canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
            })
            .from(userPnLSnapshots)
            .where(eq(userPnLSnapshots.userId, pnlId)),
          whitelist: await db
            .select({
              id: whitelist.id,
              canonical: sql<string>`to_jsonb(${whitelist})::text`,
            })
            .from(whitelist)
            .where(eq(whitelist.userId, whitelistedId)),
          configs: await db
            .select({
              id: whitelistConfig.id,
              canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
            })
            .from(whitelistConfig)
            .where(eq(whitelistConfig.updatedBy, configId)),
        }).toEqual(before);
      }
    } finally {
      await cleanup(foreign);
      for (const subject of subjects) await cleanup(subject);
    }
  });
});
