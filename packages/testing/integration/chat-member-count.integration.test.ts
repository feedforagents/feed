/**
 * GET /api/chats/[id] against a real database: the group chat header
 * renders "{N} participants" (ChatViewHeader) from this response, and N
 * must be the room's current member count.
 *
 * A ChatParticipant row is soft state: leaving through the A2A or MCP
 * client, a tier promotion/demotion, or an agent kick/leave all keep the
 * row with `isActive: false` instead of deleting it, and leaving through
 * the web deletes the row entirely. Every membership check in the app
 * reads the flag — this route's own access check requires the caller's
 * row to be active, and the dedicated participants list is being fixed
 * to active-only (#1668) for the same reason. But this route builds its
 * participants array from every row regardless of the flag and appends
 * message senders who have no row at all, because the array's job is to
 * resolve sender names for old messages (MessageList). The header then
 * renders the array's length as the member count, so departed members —
 * inactive rows and row-less senders alike — are counted as if they were
 * still in the room, and the count even grows with whoever happens to
 * appear in the currently loaded message page.
 *
 * The fix keeps the array exactly as it is (departed senders keep their
 * names) and reports the current member count separately as
 * `chat.memberCount`: the number of active participant rows, the same
 * membership rule the route's access check and #1668 apply.
 *
 * Requests use the existing CI-only synthetic Steward bearer. The only
 * stub is the `server-only` marker package; every database dependency
 * runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  chatParticipants,
  chats,
  db,
  eq,
  groups,
  inArray,
  messages,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

const bearer = (id: string) =>
  ['Bearer', ['steward', 'test', id].join(':')].join(' ');

type UserInsert = typeof users.$inferInsert;
type GroupInsert = typeof groups.$inferInsert;
type ChatInsert = typeof chats.$inferInsert;
type ParticipantInsert = typeof chatParticipants.$inferInsert;
type MessageInsert = typeof messages.$inferInsert;

/**
 * Tracks only rows whose INSERT ... RETURNING succeeded. Cleanup deletes
 * exactly those rows by ID — Groups by their exact IDs, not by a broad
 * owner predicate — so a setup that fails partway (for example on an ID
 * collision with a pre-existing row) can never delete data this fixture
 * did not create.
 */
class OwnedFixtures {
  readonly userIds: string[] = [];
  readonly groupIds: string[] = [];
  readonly chatIds: string[] = [];
  readonly participantIds: string[] = [];
  readonly messageIds: string[] = [];

  async insertUser(values: UserInsert): Promise<string> {
    const [row] = await db
      .insert(users)
      .values(values)
      .returning({ id: users.id });
    if (!row) throw new Error('user insert returned no row');
    this.userIds.push(row.id);
    return row.id;
  }

  async insertGroup(values: GroupInsert): Promise<string> {
    const [row] = await db
      .insert(groups)
      .values(values)
      .returning({ id: groups.id });
    if (!row) throw new Error('group insert returned no row');
    this.groupIds.push(row.id);
    return row.id;
  }

  async insertChat(values: ChatInsert): Promise<string> {
    const [row] = await db
      .insert(chats)
      .values(values)
      .returning({ id: chats.id });
    if (!row) throw new Error('chat insert returned no row');
    this.chatIds.push(row.id);
    return row.id;
  }

  async insertParticipant(values: ParticipantInsert): Promise<string> {
    const [row] = await db
      .insert(chatParticipants)
      .values(values)
      .returning({ id: chatParticipants.id });
    if (!row) throw new Error('participant insert returned no row');
    this.participantIds.push(row.id);
    return row.id;
  }

  async insertMessage(values: MessageInsert): Promise<string> {
    const [row] = await db
      .insert(messages)
      .values(values)
      .returning({ id: messages.id });
    if (!row) throw new Error('message insert returned no row');
    this.messageIds.push(row.id);
    return row.id;
  }

  async cleanup(): Promise<void> {
    if (this.messageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, this.messageIds));
    }
    if (this.participantIds.length > 0) {
      await db
        .delete(chatParticipants)
        .where(inArray(chatParticipants.id, this.participantIds));
    }
    if (this.chatIds.length > 0) {
      await db.delete(chats).where(inArray(chats.id, this.chatIds));
    }
    if (this.groupIds.length > 0) {
      await db.delete(groups).where(inArray(groups.id, this.groupIds));
    }
    if (this.userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, this.userIds));
    }
    this.userIds.length = 0;
    this.groupIds.length = 0;
    this.chatIds.length = 0;
    this.participantIds.length = 0;
    this.messageIds.length = 0;
  }
}

const fixtures = new OwnedFixtures();
let viewerId: string;
let memberId: string;
let departedSenderId: string;
let departedSilentId: string;
let rowlessSenderId: string;
let groupId: string;
let chatId: string;
let activeChatId: string;

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

interface ChatBody {
  chat?: { memberCount?: number };
  participants?: Array<{ id: string; displayName?: string }>;
}

async function fetchChat(id: string): Promise<ChatBody> {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${id}`, {
      headers: { authorization: bearer(viewerId) },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data?: ChatBody } & ChatBody;
  return body.data ?? body;
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));

  const now = new Date();
  const seedUser = async (name: string): Promise<string> => {
    const id = await generateSnowflakeId();
    return fixtures.insertUser({
      id,
      username: `f78-${name.toLowerCase().replace(' ', '-')}-${id}`,
      displayName: `F78 ${name}`,
      updatedAt: now,
    });
  };
  viewerId = await seedUser('Viewer');
  memberId = await seedUser('Member');
  departedSenderId = await seedUser('Departed Sender');
  departedSilentId = await seedUser('Departed Silent');
  rowlessSenderId = await seedUser('Rowless Sender');

  groupId = await fixtures.insertGroup({
    id: await generateSnowflakeId(),
    name: 'F78 Member Count Group',
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });
  const extraGroupId = await fixtures.insertGroup({
    id: await generateSnowflakeId(),
    name: 'F78 All Active Group',
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });

  chatId = await fixtures.insertChat({
    id: await generateSnowflakeId(),
    name: 'F78 Member Count Group',
    isGroup: true,
    groupId,
    createdAt: now,
    updatedAt: now,
  });
  activeChatId = await fixtures.insertChat({
    id: await generateSnowflakeId(),
    name: 'F78 All Active Group',
    isGroup: true,
    groupId: extraGroupId,
    createdAt: now,
    updatedAt: now,
  });

  const row = async (chat: string, userId: string, isActive: boolean) =>
    fixtures.insertParticipant({
      id: await generateSnowflakeId(),
      chatId: chat,
      userId,
      isActive,
      joinedAt: now,
    });
  // The room under test: two current members, two departed members
  // whose rows remain as soft state.
  await row(chatId, viewerId, true);
  await row(chatId, memberId, true);
  await row(chatId, departedSenderId, false);
  await row(chatId, departedSilentId, false);
  // A second room where everyone is a current member.
  await row(activeChatId, viewerId, true);
  await row(activeChatId, memberId, true);
  await row(activeChatId, departedSenderId, true);

  const msg = async (chat: string, senderId: string, content: string) =>
    fixtures.insertMessage({
      id: await generateSnowflakeId(),
      chatId: chat,
      senderId,
      content,
      createdAt: now,
    });
  await msg(chatId, memberId, 'Still here.');
  await msg(chatId, departedSenderId, 'Last note before I was moved out.');
  // The row-less sender left through the web, which deletes the
  // participant row; only their messages remain.
  await msg(chatId, rowlessSenderId, 'I left through the web earlier.');
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe('GET /api/chats/[id] member count for the room header', () => {
  it('counts only current members, not departed rows or senders', async () => {
    const body = await fetchChat(chatId);
    // Two active rows; the header must not count the two inactive rows
    // or the row-less departed sender.
    expect(body.chat?.memberCount).toBe(2);
  });

  it('keeps departed senders in the array so old messages keep names', async () => {
    const body = await fetchChat(chatId);
    const byId = new Map((body.participants ?? []).map((p) => [p.id, p]));

    expect(body.participants?.length).toBe(5);
    expect(byId.get(departedSenderId)?.displayName).toBe('F78 Departed Sender');
    expect(byId.get(departedSilentId)?.displayName).toBe('F78 Departed Silent');
    expect(byId.get(rowlessSenderId)?.displayName).toBe('F78 Rowless Sender');
  });

  it('counts every member when all rows are active', async () => {
    const body = await fetchChat(activeChatId);
    expect(body.chat?.memberCount).toBe(3);
    expect(body.participants?.length).toBe(3);
  });
});

describe('fixture ownership', () => {
  it('cleanup after failed setup never deletes rows the fixture did not create', async () => {
    const victim = new OwnedFixtures();
    const attempt = new OwnedFixtures();
    try {
      const now = new Date();
      const victimUserRaw = await generateSnowflakeId();
      const victimUserId = await victim.insertUser({
        id: victimUserRaw,
        username: `f78v-${victimUserRaw}`,
        displayName: 'Pre-existing owner',
        updatedAt: now,
      });
      const victimGroupId = await victim.insertGroup({
        id: await generateSnowflakeId(),
        name: 'Pre-existing group',
        type: 'user',
        ownerId: victimUserId,
        createdById: victimUserId,
        createdAt: now,
        updatedAt: now,
      });

      // A user INSERT that collides with the pre-existing user fails and
      // registers no ownership.
      let userCollisionFailed = false;
      try {
        await attempt.insertUser({
          id: victimUserId,
          username: `f78c-${victimUserId}`,
          displayName: 'Collision attempt',
          updatedAt: now,
        });
      } catch {
        userCollisionFailed = true;
      }
      expect(userCollisionFailed).toBe(true);
      expect(attempt.userIds).toEqual([]);

      // Partial setup: the user insert succeeds, then the Group INSERT
      // collides with the pre-existing group and registers nothing.
      const attemptUserRaw = await generateSnowflakeId();
      const attemptUserId = await attempt.insertUser({
        id: attemptUserRaw,
        username: `f78p-${attemptUserRaw}`,
        displayName: 'Partial setup',
        updatedAt: now,
      });
      let groupCollisionFailed = false;
      try {
        await attempt.insertGroup({
          id: victimGroupId,
          name: 'Collision attempt group',
          type: 'user',
          ownerId: attemptUserId,
          createdById: attemptUserId,
          createdAt: now,
          updatedAt: now,
        });
      } catch {
        groupCollisionFailed = true;
      }
      expect(groupCollisionFailed).toBe(true);
      expect(attempt.groupIds).toEqual([]);

      await attempt.cleanup();

      // The pre-existing rows survive the failed setup's cleanup
      // untouched, and the one acquired row is removed.
      const [survivingUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, victimUserId));
      expect(survivingUser?.displayName).toBe('Pre-existing owner');
      const [survivingGroup] = await db
        .select()
        .from(groups)
        .where(eq(groups.id, victimGroupId));
      expect(survivingGroup?.name).toBe('Pre-existing group');
      const [removedUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, attemptUserId));
      expect(removedUser).toBeUndefined();
    } finally {
      await attempt.cleanup();
      await victim.cleanup();
    }
  });
});
