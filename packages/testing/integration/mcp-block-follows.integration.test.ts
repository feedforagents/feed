/**
 * MCP block_user must sever follow edges the same way the website block does.
 *
 * The website block route inserts the block and deletes both follow directions
 * in one transaction. MCP block_user used to insert only the block, so an
 * agent block left the follow graph in place.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { and, db, eq, follows, inArray, or, userBlocks, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeBlockUser } from '../../mcp/src/handlers/tool-handlers';

const userIds: string[] = [];

async function createUser(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `blk_${id}`,
    isActor: false,
    updatedAt: new Date(),
  });
  userIds.push(id);
  return id;
}

async function follow(followerId: string, followingId: string): Promise<void> {
  await db.insert(follows).values({
    id: await generateSnowflakeId(),
    followerId,
    followingId,
  });
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
    if (userIds.length === 0) return;
    await db
      .delete(follows)
      .where(
        or(
          inArray(follows.followerId, userIds),
          inArray(follows.followingId, userIds)
        )
      );
    await db
      .delete(userBlocks)
      .where(
        or(
          inArray(userBlocks.blockerId, userIds),
          inArray(userBlocks.blockedId, userIds)
        )
      );
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it('removes both follow directions and leaves an unrelated follow', async () => {
    const blockerId = await createUser();
    const blockedId = await createUser();
    const otherId = await createUser();
    await follow(blockerId, blockedId);
    await follow(blockedId, blockerId);
    await follow(blockerId, otherId);

    const result = await executeBlockUser(
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
    await db.insert(userBlocks).values({
      id: await generateSnowflakeId(),
      blockerId,
      blockedId,
    });
    await follow(blockerId, blockedId);
    await follow(blockedId, blockerId);

    const result = await executeBlockUser(
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
      executeBlockUser(
        { agentId: blockerId, userId: blockerId },
        { userId: missingId }
      )
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
        executeBlockUser(
          { agentId: rightId, userId: rightId },
          { userId: leftId }
        )
      );
      await waitForBlockedCalls(barrierPid, 1);
      operations.push(
        executeBlockUser(
          { agentId: leftId, userId: leftId },
          { userId: rightId }
        )
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
});
