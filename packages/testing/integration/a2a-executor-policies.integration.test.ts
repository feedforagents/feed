/**
 * FeedAgentExecutor applies the same content/profile/membership policies as
 * the HTTP routes.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { FeedAgentExecutor } from '@feed/a2a';
import {
  acquireUserBlockPairLock,
  and,
  chatParticipants,
  chats,
  comments,
  db,
  eq,
  follows,
  groupMembers,
  groups,
  inArray,
  or,
  posts,
  sql,
  userBlocks,
  users,
  withTransaction,
} from '@feed/db';
import { generateSnowflakeId, type JsonValue } from '@feed/shared';
import {
  executeBlockUser,
  executeFollowUser,
} from '../../mcp/src/handlers/tool-handlers';
import { assertDisposableAgentFollowDatabase } from './helpers/agent-follow-database';

const createdUsers: string[] = [];
const createdPosts: string[] = [];
const followPeers: string[] = [];
let userId: string;
let liveFeedPostId: string;
let deletedFeedPostId: string;
let groupId: string;
let chatId: string;

function run(operation: string, params: Record<string, JsonValue> = {}) {
  return FeedAgentExecutor.executeDirectly(operation, params, userId);
}

async function createFollowPeer(): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(users).values({
    id,
    username: `exec_follow_${id.slice(-10)}`,
    updatedAt: new Date(),
  });
  createdUsers.push(id);
  followPeers.push(id);
  return id;
}

describe('FeedAgentExecutor policies', () => {
  beforeAll(async () => {
    userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: userId,
      username: `exec_${userId.slice(-10)}`,
      isActor: false,
      updatedAt: new Date(),
    });
    createdUsers.push(userId);

    // Newest posts in the table so they land in the first feed page.
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    liveFeedPostId = await generateSnowflakeId();
    deletedFeedPostId = await generateSnowflakeId();
    await db.insert(posts).values([
      {
        id: liveFeedPostId,
        content: 'live post',
        authorId: userId,
        timestamp: new Date(future),
      },
      {
        id: deletedFeedPostId,
        content: 'deleted post',
        authorId: userId,
        timestamp: new Date(future + 1000),
        deletedAt: new Date(),
      },
    ]);
    createdPosts.push(liveFeedPostId, deletedFeedPostId);

    groupId = await generateSnowflakeId();
    chatId = await generateSnowflakeId();
    await db.insert(groups).values({
      id: groupId,
      name: 'executor test group',
      type: 'user',
      ownerId: 'someone-else',
      createdById: 'someone-else',
      updatedAt: new Date(),
    });
    await db.insert(chats).values({
      id: chatId,
      isGroup: true,
      groupId,
      updatedAt: new Date(),
    });
    await db.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId,
      userId,
      role: 'member',
    });
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId,
      userId,
    });
  });

  afterAll(async () => {
    if (!createdUsers.length) return;
    await db
      .delete(follows)
      .where(
        or(
          and(
            eq(follows.followerId, userId),
            inArray(follows.followingId, followPeers)
          ),
          and(
            inArray(follows.followerId, followPeers),
            eq(follows.followingId, userId)
          )
        )
      );
    await db
      .delete(userBlocks)
      .where(
        or(
          and(
            eq(userBlocks.blockerId, userId),
            inArray(userBlocks.blockedId, followPeers)
          ),
          and(
            inArray(userBlocks.blockerId, followPeers),
            eq(userBlocks.blockedId, userId)
          )
        )
      );
    await db.delete(comments).where(inArray(comments.postId, createdPosts));
    await db.delete(posts).where(inArray(posts.id, createdPosts));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, chatId));
    await db.delete(chats).where(eq(chats.id, chatId));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    await db.delete(groups).where(eq(groups.id, groupId));
    await db.delete(users).where(inArray(users.id, createdUsers));
  });

  it('social.get_feed excludes deleted posts', async () => {
    const result = (await run('social.get_feed', { limit: 5 })) as {
      posts: Array<{ id: string }>;
    };
    const ids = result.posts.map((p) => p.id);
    expect(ids).toContain(liveFeedPostId);
    expect(ids).not.toContain(deletedFeedPostId);
  });

  it('rejects comments over the shared 2000 character limit', async () => {
    await expect(
      run('social.create_comment', {
        postId: liveFeedPostId,
        content: 'a'.repeat(2001),
      })
    ).rejects.toThrow('exceeds maximum length (2000');
  });

  it('rejects content that is empty after removing control characters', async () => {
    await expect(
      run('social.create_comment', {
        postId: liveFeedPostId,
        content: '\u0001\u0002\u0003',
      })
    ).rejects.toThrow('content cannot be empty');
  });

  it('validates profile updates with the shared schema', async () => {
    await expect(
      run('users.update_profile', { username: 'no spaces allowed' })
    ).rejects.toThrow('Invalid profile update');
    await expect(
      run('users.update_profile', { profileImageUrl: 'javascript:alert(1)' })
    ).rejects.toThrow('Invalid profile update');

    const ok = (await run('users.update_profile', {
      displayName: '  Exec Tester  ',
    })) as { user: { displayName: string } };
    expect(ok.user.displayName).toBe('Exec Tester');
  });

  it('rejects a users.update_profile username another user holds in any letter case', async () => {
    const holderId = await generateSnowflakeId();
    const holderName = `Held_${holderId.slice(-10)}`;
    await db.insert(users).values({
      id: holderId,
      username: holderName,
      updatedAt: new Date(),
    });
    createdUsers.push(holderId);
    const [before] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId));

    await expect(
      run('users.update_profile', { username: holderName.toUpperCase() })
    ).rejects.toThrow('Username is already taken');

    const [after] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, userId));
    expect(after).toEqual(before);
  });

  it('rejects users.follow in either block direction', async () => {
    await assertDisposableAgentFollowDatabase();
    const blockedByUserId = await createFollowPeer();
    const blockerOfUserId = await createFollowPeer();
    const cleanFollowId = await createFollowPeer();
    await db.insert(userBlocks).values([
      {
        id: await generateSnowflakeId(),
        blockerId: userId,
        blockedId: blockedByUserId,
      },
      {
        id: await generateSnowflakeId(),
        blockerId: blockerOfUserId,
        blockedId: userId,
      },
    ]);
    await expect(
      run('users.follow', { userId: blockedByUserId })
    ).rejects.toThrow('Cannot follow this user');
    await expect(
      run('users.follow', { userId: blockerOfUserId })
    ).rejects.toThrow('Cannot follow this user');

    const blockedRows = await db
      .select({ id: follows.id })
      .from(follows)
      .where(eq(follows.followerId, userId));
    expect(blockedRows).toHaveLength(0);

    const ok = (await run('users.follow', {
      userId: cleanFollowId,
    })) as { success: boolean };
    expect(ok.success).toBe(true);
    const cleanRows = await db
      .select({ id: follows.id })
      .from(follows)
      .where(eq(follows.followerId, userId));
    expect(cleanRows).toHaveLength(1);
  });

  for (const first of ['A2A block', 'A2A follow'] as const) {
    it(`serializes ${first} with the competing MCP write`, async () => {
      await assertDisposableAgentFollowDatabase();
      const targetId = await createFollowPeer();

      const ready = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const calls: Promise<void>[] = [];
      const barrier = withTransaction(async (tx) => {
        await acquireUserBlockPairLock(tx, userId, targetId);
        const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        ready.resolve(Number(row?.pid));
        await release.promise;
      }).catch((error: Error) => {
        ready.reject(error);
        throw error;
      });
      async function waitForQueuedCalls(pid: number, count: number) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await db.execute(sql`
            WITH RECURSIVE waiting(pid) AS (
              SELECT ${pid}::integer
              UNION
              SELECT a.pid FROM pg_stat_activity a
              JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
            )
            SELECT count(*)::integer - 1 AS count FROM waiting
          `);
          if (Number(row?.count) >= count) return;
          await Bun.sleep(20);
        }
        throw new Error(
          'The follow or block operation did not take the pair lock'
        );
      }

      try {
        const pid = await ready.promise;
        const a2a = run(
          first === 'A2A block' ? 'moderation.block_user' : 'users.follow',
          { userId: targetId }
        );
        calls.push(Promise.allSettled([a2a]).then(() => {}));
        await waitForQueuedCalls(pid, 1);
        const mcpAgent = { agentId: targetId, userId: targetId };
        const mcp =
          first === 'A2A block'
            ? executeFollowUser(mcpAgent, { userId })
            : executeBlockUser(mcpAgent, { userId });
        calls.push(Promise.allSettled([mcp]).then(() => {}));
        await waitForQueuedCalls(pid, 2);
        release.resolve();
        await expect(a2a).resolves.toMatchObject({ success: true });
        if (first === 'A2A block') {
          await expect(mcp).rejects.toThrow('Cannot follow this user');
        } else {
          await expect(mcp).resolves.toEqual({ success: true });
        }
        const pair = [userId, targetId];
        expect(
          await db
            .select()
            .from(follows)
            .where(
              and(
                inArray(follows.followerId, pair),
                inArray(follows.followingId, pair)
              )
            )
        ).toHaveLength(0);
        expect(
          await db
            .select()
            .from(userBlocks)
            .where(
              and(
                inArray(userBlocks.blockerId, pair),
                inArray(userBlocks.blockedId, pair)
              )
            )
        ).toHaveLength(1);
      } finally {
        release.resolve();
        await barrier;
        await Promise.all(calls);
      }
    }, 10000);
  }

  it('leaving a group chat also deactivates group membership', async () => {
    await run('messaging.leave_chat', { chatId });
    const [membership] = await db
      .select({ isActive: groupMembers.isActive })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    expect(membership?.isActive).toBe(false);
  });
});
