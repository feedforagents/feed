/**
 * The chat detail API must identify active mention targets while retaining
 * departed senders for history. The child runs on a leased local database.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  test,
} from 'bun:test';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedChatMentionCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('runs chat mention cases in a leased fresh database', async () => {
    await runIsolatedChatMentionCases();
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  mock.module('server-only', () => ({}));

  const { chatParticipants, chats, db, groups, messages, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { GET } = await import(
    '../../../apps/web/src/app/api/chats/[id]/route'
  );

  let token: string;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      GET(new NextRequest(request), {
        params: Promise.resolve({ id: chatId }),
      }),
  });

  let viewerId: string;
  let departedSilentId: string;
  let departedSenderId: string;
  let groupId: string;
  let chatId: string;
  const novaIds: string[] = [];

  interface ParticipantEntry {
    id: string;
    displayName?: string;
    username?: string;
    isActive?: boolean;
  }

  async function fetchParticipants(): Promise<ParticipantEntry[]> {
    const requestId = crypto.randomUUID();
    const response = await fetch(new URL('/api/chats/' + chatId, server.url), {
      headers: { authorization: 'Bearer ' + token, 'x-request-id': requestId },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      participants: ParticipantEntry[];
    };
    expect(Array.isArray(body.participants)).toBe(true);
    console.info('Chat detail HTTP response', {
      requestId,
      status: response.status,
      participants: body.participants.length,
      active: body.participants.filter((participant) => participant.isActive)
        .length,
    });
    return body.participants;
  }

  /** The mentionable set as ChatView computes it from this response. */
  function mentionableIds(participants: ParticipantEntry[]): string[] {
    return participants.filter((p) => p.isActive !== false).map((p) => p.id);
  }

  beforeAll(async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => generateSnowflakeId())
    );
    viewerId = ids[0]!;
    departedSilentId = ids[1]!;
    departedSenderId = ids[2]!;
    groupId = ids[3]!;
    chatId = ids[4]!;
    const departedMsgId = ids[5]!;
    const stewardId = 'mention-lease-' + viewerId;
    token = await createStewardTestToken(stewardId);

    const now = new Date();
    await db.insert(users).values([
      {
        id: viewerId,
        username: `f31-viewer-${viewerId}`,
        displayName: 'F31 Viewer',
        stewardId,
        updatedAt: now,
      },
      {
        id: departedSilentId,
        username: `f31-departed-silent-${departedSilentId}`,
        displayName: 'F31 Departed Silent',
        updatedAt: now,
      },
      {
        id: departedSenderId,
        username: `f31-departed-sender-${departedSenderId}`,
        displayName: 'F31 Departed Sender',
        updatedAt: now,
      },
    ]);

    // 60 active members sharing one username prefix: the suggestion list
    // must keep every current member reachable, however common the prefix.
    const novaUsers: (typeof users.$inferInsert)[] = [];
    for (let i = 0; i < 60; i++) {
      const id = await generateSnowflakeId();
      novaIds.push(id);
      novaUsers.push({
        id,
        username: `f31nova-${String(i).padStart(2, '0')}-${id}`,
        displayName: `Nova ${String(i).padStart(2, '0')}`,
        updatedAt: now,
      });
    }
    await db.insert(users).values(novaUsers);

    await db.insert(groups).values({
      id: groupId,
      name: 'F31 Mention Group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(chats).values({
      id: chatId,
      name: 'F31 Mention Group',
      isGroup: true,
      groupId,
      createdAt: now,
      updatedAt: now,
    });

    const participantRows = [
      { userId: viewerId, isActive: true },
      // Departed via a path that keeps the row (A2A/MCP leave, tier move,
      // agent kick/leave): isActive=false. The silent one never spoke.
      { userId: departedSilentId, isActive: false },
      { userId: departedSenderId, isActive: false },
      ...novaIds.map((userId) => ({ userId, isActive: true })),
    ];
    await db.insert(chatParticipants).values(
      await Promise.all(
        participantRows.map(async (row) => ({
          id: await generateSnowflakeId(),
          chatId,
          userId: row.userId,
          isActive: row.isActive,
          joinedAt: now,
        }))
      )
    );

    await db.insert(messages).values({
      id: departedMsgId,
      chatId,
      senderId: departedSenderId,
      content: 'Last note before I was moved out of this tier chat.',
      createdAt: now,
    });
  });

  afterAll(async () => {
    try {
      await server.stop(true);
    } finally {
      await db.$disconnect();
    }
  });

  describe('GET /api/chats/[id] participants as the mention source', () => {
    it('marks departed participants inactive so mentions skip them', async () => {
      const participants = await fetchParticipants();
      const byId = new Map(participants.map((p) => [p.id, p]));

      expect(byId.get(departedSilentId)?.isActive).toBe(false);
      expect(byId.get(departedSenderId)?.isActive).toBe(false);
      expect(byId.get(viewerId)?.isActive).toBe(true);

      const mentionable = mentionableIds(participants);
      expect(mentionable).not.toContain(departedSilentId);
      expect(mentionable).not.toContain(departedSenderId);
      expect(mentionable).toContain(viewerId);
    });

    it('keeps departed senders listed with names for old messages', async () => {
      const participants = await fetchParticipants();
      const byId = new Map(participants.map((p) => [p.id, p]));

      // Nobody is dropped: the array still resolves every sender's name.
      expect(participants.length).toBe(63);
      expect(byId.get(departedSenderId)?.displayName).toBe(
        'F31 Departed Sender'
      );
      expect(byId.get(departedSilentId)?.displayName).toBe(
        'F31 Departed Silent'
      );
    });

    it('keeps every active member reachable behind a shared prefix', async () => {
      const participants = await fetchParticipants();
      const mentionable = new Set(mentionableIds(participants));

      for (const id of novaIds) {
        expect(mentionable.has(id)).toBe(true);
      }
      expect(mentionable.size).toBe(61);
    });
  });
}
