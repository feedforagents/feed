/**
 * F135 probe: MCP get_chats must honor its published `filter` argument.
 *
 * The MCP server advertises get_chats with an input schema declaring
 * `filter: 'all' | 'dms' | 'groups'` ("Filter by chat type"), the args
 * type and zod validation carry the value to the executor, and every
 * result row already carries `type: 'dm' | 'group'`. The fixtures below
 * give the viewer two DM chats and two group chats (one group-backed,
 * one direct group chat with groupId null), plus two controls that must
 * never appear (a chat the viewer left, a chat the viewer is not in).
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  closeDatabase,
  db,
  groupMembers,
  groups,
  inArray,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { executeGetChats } from '../../mcp/src/handlers/tool-handlers';

const owned = {
  users: [] as string[],
  chats: [] as string[],
  groups: [] as string[],
};

let viewerId = '';
let otherId = '';
let dmA = '';
let dmB = '';
let groupBacked = '';
let directGroup = '';
let leftChat = '';
let foreignChat = '';

async function createUser(label: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    username: `f135-${label}-${id.slice(-8)}`,
    isActor: false,
    updatedAt: new Date(),
  });
  owned.users.push(id);
  return id;
}

async function createChat(
  isGroup: boolean,
  groupId: string | null,
  memberIds: string[],
  viewerActive = true
): Promise<string> {
  const id = await generateSnowflakeId();
  await db.insert(chats).values({
    id,
    name: `f135 chat ${id.slice(-6)}`,
    isGroup,
    groupId,
    updatedAt: new Date(),
  });
  owned.chats.push(id);
  for (const userId of memberIds) {
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId: id,
      userId,
      isActive: userId === viewerId ? viewerActive : true,
    });
  }
  return id;
}

async function idsFor(filter?: 'all' | 'dms' | 'groups'): Promise<string[]> {
  const result = await executeGetChats(
    { agentId: 'agent', userId: viewerId },
    filter === undefined ? {} : { filter }
  );
  return result.chats.map((c) => c.id);
}

describe('MCP get_chats filter', () => {
  beforeAll(async () => {
    viewerId = await createUser('viewer');
    otherId = await createUser('other');

    dmA = await createChat(false, null, [viewerId, otherId]);
    dmB = await createChat(false, null, [viewerId, otherId]);

    // Group-backed group chat: Group row + groupMembers + chats.groupId.
    const groupId = await generateSnowflakeId();
    await db.insert(groups).values({
      id: groupId,
      name: 'f135 group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      updatedAt: new Date(),
    });
    owned.groups.push(groupId);
    for (const userId of [viewerId, otherId]) {
      await db.insert(groupMembers).values({
        id: await generateSnowflakeId(),
        groupId,
        userId,
        role: userId === viewerId ? 'admin' : 'member',
      });
    }
    groupBacked = await createChat(true, groupId, [viewerId, otherId]);

    // Direct group chat: isGroup with groupId null, chatParticipants only
    // (the shape POST /api/chats with isGroup=true creates).
    directGroup = await createChat(true, null, [viewerId, otherId]);

    // Controls: viewer left this chat; viewer is not a member of that one.
    leftChat = await createChat(false, null, [viewerId, otherId], false);
    foreignChat = await createChat(false, null, [otherId]);
  });

  afterAll(async () => {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.chatId, owned.chats));
    await db.delete(chats).where(inArray(chats.id, owned.chats));
    await db
      .delete(groupMembers)
      .where(inArray(groupMembers.groupId, owned.groups));
    await db.delete(groups).where(inArray(groups.id, owned.groups));
    await db.delete(users).where(inArray(users.id, owned.users));
    await closeDatabase();
  });

  it('filter=all (and no filter) lists every reachable chat exactly once', async () => {
    const expected = [dmA, dmB, groupBacked, directGroup].sort();
    for (const filter of [undefined, 'all'] as const) {
      const ids = await idsFor(filter);
      expect([...ids].sort()).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(leftChat);
      expect(ids).not.toContain(foreignChat);
    }
  });

  it('filter=dms returns only DM chats', async () => {
    const result = await executeGetChats(
      { agentId: 'agent', userId: viewerId },
      { filter: 'dms' }
    );
    expect(result.chats.map((c) => c.id).sort()).toEqual([dmA, dmB].sort());
    expect(result.chats.every((c) => c.type === 'dm')).toBe(true);
  });

  it('filter=groups returns only group chats', async () => {
    const result = await executeGetChats(
      { agentId: 'agent', userId: viewerId },
      { filter: 'groups' }
    );
    expect(result.chats.map((c) => c.id).sort()).toEqual(
      [groupBacked, directGroup].sort()
    );
    expect(result.chats.every((c) => c.type === 'group')).toBe(true);
  });
});
