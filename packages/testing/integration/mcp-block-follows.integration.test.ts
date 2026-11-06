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
    username: `blk_${id.slice(-12)}`,
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
});
