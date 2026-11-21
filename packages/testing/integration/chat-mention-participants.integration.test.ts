/**
 * GET /api/chats/[id] against a real database: the participants array in
 * the response is what the web chat turns into @mention suggestions
 * (ChatView maps `chatDetails.participants` verbatim into
 * `mentionableMembers` for MessageInput's MentionAutocomplete).
 *
 * A ChatParticipant row is soft state: leaving through the A2A or MCP
 * client, a tier promotion/demotion, or an agent kick/leave all keep the
 * row with `isActive: false` instead of deleting it. Every other chat
 * surface treats that flag as "no longer a member" — this route's own
 * access check requires the caller's row to be active, the message route
 * notifies active rows only, and the dedicated participants list is
 * being fixed to active-only (#1668) for the same reason. But this route
 * built its participants list from every row regardless of the flag and
 * returned the entries with no membership marker, so a departed member
 * who never even spoke was still offered as a mention suggestion, and
 * the client had no way to tell them apart from a current member.
 * Mentioning them addresses someone who can no longer open the chat.
 *
 * The same array also resolves sender names for old messages
 * (MessageList), so departed members who did speak must stay in the
 * list — marked inactive, not dropped.
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

let viewerId: string;
let departedSilentId: string;
let departedSenderId: string;
let groupId: string;
let chatId: string;
const novaIds: string[] = [];
const allUserIds: string[] = [];

let GET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;

interface ParticipantEntry {
  id: string;
  displayName?: string;
  username?: string;
  isActive?: boolean;
}

async function fetchParticipants(): Promise<ParticipantEntry[]> {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}`, {
      headers: { authorization: bearer(viewerId) },
    })
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: chatId }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data?: { participants?: ParticipantEntry[] };
    participants?: ParticipantEntry[];
  };
  return body.data?.participants ?? body.participants ?? [];
}

/** The mentionable set as ChatView computes it from this response. */
function mentionableIds(participants: ParticipantEntry[]): string[] {
  return participants.filter((p) => p.isActive !== false).map((p) => p.id);
}

beforeAll(async () => {
  ({ GET } = await import('../../../apps/web/src/app/api/chats/[id]/route'));

  const ids = await Promise.all(
    Array.from({ length: 6 }, () => generateSnowflakeId())
  );
  viewerId = ids[0]!;
  departedSilentId = ids[1]!;
  departedSenderId = ids[2]!;
  groupId = ids[3]!;
  chatId = ids[4]!;
  const departedMsgId = ids[5]!;
  allUserIds.push(viewerId, departedSilentId, departedSenderId);

  const now = new Date();
  await db.insert(users).values([
    {
      id: viewerId,
      username: `f31-viewer-${viewerId}`,
      displayName: 'F31 Viewer',
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
  const novaUsers = [];
  for (let i = 0; i < 60; i++) {
    const id = await generateSnowflakeId();
    novaIds.push(id);
    allUserIds.push(id);
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
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatParticipants).where(eq(chatParticipants.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(groups).where(eq(groups.id, groupId));
  await db.delete(users).where(inArray(users.id, allUserIds));
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
    expect(byId.get(departedSenderId)?.displayName).toBe('F31 Departed Sender');
    expect(byId.get(departedSilentId)?.displayName).toBe('F31 Departed Silent');
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
