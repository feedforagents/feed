/** PRD §§8.1, 13 / MVP Phase 3: preserve the result of committed NPC actions. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {
  agentLogs,
  and,
  chatParticipants,
  chats,
  comments,
  db,
  dmAcceptances,
  eq,
  follows,
  groupMembers,
  groups,
  inArray,
  messages,
  notifications,
  or,
  posts,
  postTags,
  reactions,
  shares,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { MultiStepExecutor } from '../../agents/src/autonomous/MultiStepExecutor';
import { Features } from '../../agents/src/autonomous/templates/multi-step-decision';
import { agentService } from '../../agents/src/services/AgentService';

const original = agentService.createLog;
const actions = [
  'POST',
  'COMMENT',
  'LIKE',
  'REPOST',
  'FOLLOW',
  'UNFOLLOW',
  'REPLY_COMMENT',
  'REPLY_CHAT',
  'DM',
  'GROUP_MESSAGE',
  'CREATE_GROUP',
  'INVITE_TO_GROUP',
  'KICK_FROM_GROUP',
  'LEAVE_GROUP',
  'FAILED_LIKE',
  'REPEATED_LIKE',
  'REPEATED_REPOST',
] as const;
for (const action of actions) {
  test(`preserves ${action} result when activity persistence fails`, async () => {
    const uid = await generateSnowflakeId(),
      other = await generateSnowflakeId(),
      third = await generateSnowflakeId(),
      pid = await generateSnowflakeId(),
      cid = await generateSnowflakeId(),
      gid = await generateSnowflakeId(),
      chat = await generateSnowflakeId(),
      dm = await generateSnowflakeId(),
      ids = [uid, other, third];
    try {
      for (const id of ids)
        await db.insert(users).values({
          id,
          username: `dot-activity-${id}`,
          displayName: 'Synthetic activity test',
          virtualBalance: '10000',
          updatedAt: new Date(),
        });
      await db.insert(posts).values({
        id: pid,
        authorId: other,
        content: 'Synthetic post for isolated activity regression',
      });
      await db.insert(comments).values({
        id: cid,
        authorId: other,
        postId: pid,
        content: 'Synthetic parent comment',
        updatedAt: new Date(),
      });
      await db.insert(groups).values({
        id: gid,
        name: 'Synthetic activity group',
        type: 'agent',
        ownerId: action === 'LEAVE_GROUP' ? other : uid,
        createdById: other,
        updatedAt: new Date(),
      });
      await db.insert(chats).values([
        { id: chat, isGroup: true, groupId: gid, updatedAt: new Date() },
        { id: dm, isGroup: false, updatedAt: new Date() },
      ]);
      for (const id of [uid, other]) {
        await db.insert(groupMembers).values({
          id: await generateSnowflakeId(),
          groupId: gid,
          userId: id,
          role:
            id === (action === 'LEAVE_GROUP' ? other : uid)
              ? 'owner'
              : 'member',
        });
        for (const chatId of [chat, dm])
          await db
            .insert(chatParticipants)
            .values({ id: await generateSnowflakeId(), chatId, userId: id });
      }
      if (action === 'UNFOLLOW')
        await db.insert(follows).values({
          id: await generateSnowflakeId(),
          followerId: uid,
          followingId: other,
        });
      if (action === 'REPEATED_LIKE')
        await db.insert(reactions).values({
          id: await generateSnowflakeId(),
          userId: uid,
          postId: pid,
          type: 'like',
        });
      if (action === 'REPEATED_REPOST')
        await db.insert(shares).values({
          id: await generateSnowflakeId(),
          userId: uid,
          postId: pid,
        });
      let attempts = 0;
      agentService.createLog = async () => {
        attempts++;
        throw Error('injected activity log failure');
      };
      const parameters = {
        content:
          'Synthetic local activity acceptance with a unique quiet orchard observation',
        postId: action === 'FAILED_LIKE' ? 'missing-' + pid : pid,
        commentId: cid,
        targetUserId: other,
        recipientId: other,
        chatId: chat,
        groupId: gid,
        userId: action === 'INVITE_TO_GROUP' ? third : other,
        name: 'Synthetic newly created group',
      };
      const executor = new MultiStepExecutor();
      let result:
        | Awaited<ReturnType<MultiStepExecutor['executeAction']>>
        | undefined;
      let error: string | undefined;
      try {
        result = await executor['executeAction'](
          uid,
          action === 'FAILED_LIKE' || action === 'REPEATED_LIKE'
            ? 'LIKE'
            : action === 'REPEATED_REPOST'
              ? 'REPOST'
              : action,
          parameters,
          Object.values(Features),
          {} as Parameters<MultiStepExecutor['executeAction']>[4],
          true,
          { prompt: 'synthetic', completion: 'synthetic', thought: 'synthetic' }
        );
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const ownPosts = await db
        .select()
        .from(posts)
        .where(eq(posts.authorId, uid));
      const ownComments = await db
        .select()
        .from(comments)
        .where(eq(comments.authorId, uid));
      const likes = await db
        .select()
        .from(reactions)
        .where(eq(reactions.userId, uid));
      const reposts = await db
        .select()
        .from(shares)
        .where(eq(shares.userId, uid));
      const following = await db
        .select()
        .from(follows)
        .where(eq(follows.followerId, uid));
      const sent = await db
        .select()
        .from(messages)
        .where(eq(messages.senderId, uid));
      const memberships = await db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, gid));
      const ownedGroups = await db
        .select()
        .from(groups)
        .where(eq(groups.createdById, uid));
      assert.equal(attempts, 1);
      if (action === 'POST') assert.equal(ownPosts.length, 1);
      if (action === 'COMMENT' || action === 'REPLY_COMMENT') {
        assert.equal(ownComments.length, 1);
        assert.ok(ownComments[0]);
        assert.equal(
          ownComments[0].parentCommentId,
          action === 'REPLY_COMMENT' ? cid : null
        );
      }
      if (action === 'LIKE' || action === 'REPEATED_LIKE')
        assert.equal(likes.length, 1);
      if (action === 'FAILED_LIKE') assert.equal(likes.length, 0);
      if (action === 'REPOST' || action === 'REPEATED_REPOST')
        assert.equal(reposts.length, 1);
      if (action === 'FOLLOW' || action === 'UNFOLLOW')
        assert.equal(following.length, action === 'FOLLOW' ? 1 : 0);
      if (['REPLY_CHAT', 'DM', 'GROUP_MESSAGE'].includes(action)) {
        assert.equal(sent.length, 1);
        assert.ok(sent[0]);
        assert.equal(sent[0].chatId, action === 'DM' ? dm : chat);
      }
      if (action === 'CREATE_GROUP') assert.equal(ownedGroups.length, 1);
      if (action === 'INVITE_TO_GROUP')
        assert.equal(
          memberships.find((m) => m.userId === third)?.isActive,
          true
        );
      if (action === 'KICK_FROM_GROUP' || action === 'LEAVE_GROUP') {
        const target = action === 'LEAVE_GROUP' ? uid : other;
        assert.equal(
          memberships.find((m) => m.userId === target)?.isActive,
          false
        );
        const [member] = await db
          .select()
          .from(chatParticipants)
          .where(
            and(
              eq(chatParticipants.chatId, chat),
              eq(chatParticipants.userId, target)
            )
          );
        assert.ok(member);
        assert.equal(member.isActive, false);
      }
      assert.equal(
        (
          await db
            .select()
            .from(agentLogs)
            .where(eq(agentLogs.agentUserId, uid))
        ).length,
        0
      );
      {
        assert.ok(result);
        assert.equal(error, undefined);
        assert.equal(result.success, action !== 'FAILED_LIKE');
        if (action === 'FAILED_LIKE')
          assert.match(result.summary, /Post not found/);
        if (action === 'REPEATED_LIKE')
          assert.match(result.summary, /Already liked/);
        if (action === 'REPEATED_REPOST')
          assert.match(result.summary, /Already reposted/);
      }
    } finally {
      agentService.createLog = original;
      const groupRows = await db
        .select()
        .from(groups)
        .where(
          or(inArray(groups.createdById, ids), inArray(groups.ownerId, ids))
        );
      const groupIds = groupRows.map((g) => g.id);
      const chatRows = await db
        .select()
        .from(chats)
        .where(
          or(inArray(chats.id, [chat, dm]), inArray(chats.groupId, groupIds))
        );
      const chatIds = chatRows.map((x) => x.id);
      const postRows = await db
        .select()
        .from(posts)
        .where(inArray(posts.authorId, ids));
      const postIds = postRows.map((p) => p.id);
      await db
        .delete(notifications)
        .where(
          or(
            inArray(notifications.userId, ids),
            inArray(notifications.actorId, ids)
          )
        );
      await db.delete(agentLogs).where(inArray(agentLogs.agentUserId, ids));
      await db
        .delete(dmAcceptances)
        .where(inArray(dmAcceptances.chatId, chatIds));
      await db.delete(messages).where(inArray(messages.chatId, chatIds));
      await db
        .delete(chatParticipants)
        .where(inArray(chatParticipants.chatId, chatIds));
      await db.delete(chats).where(inArray(chats.id, chatIds));
      await db
        .delete(groupMembers)
        .where(inArray(groupMembers.groupId, groupIds));
      await db.delete(groups).where(inArray(groups.id, groupIds));
      await db.delete(reactions).where(inArray(reactions.userId, ids));
      await db.delete(shares).where(inArray(shares.userId, ids));
      await db
        .delete(follows)
        .where(
          or(
            inArray(follows.followerId, ids),
            inArray(follows.followingId, ids)
          )
        );
      await db.delete(comments).where(inArray(comments.postId, postIds));
      await db.delete(postTags).where(inArray(postTags.postId, postIds));
      await db.delete(posts).where(inArray(posts.id, postIds));
      await db.delete(users).where(inArray(users.id, ids));
    }
  });
}
