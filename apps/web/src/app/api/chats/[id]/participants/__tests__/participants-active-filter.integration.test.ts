/**
 * Integration test: GET /api/chats/[id]/participants must list only the
 * chat's current (active) participants.
 *
 * ChatParticipant soft state is the isActive flag: when the tiered group
 * service moves a member between tier chats (promotion/demotion) it sets
 * the old chat's participant row isActive=false instead of deleting it,
 * and the notification fix for group chat sends (#1655) treats inactive
 * participants as out of the chat. Every sibling "who is in this group"
 * surface honors the flag: GET /api/groups/[groupId]/members lists only
 * isActive members, GET /api/chats/[id]/group requires the requester's
 * participant row to be active, and this route's own access check
 * requires the requester to be an active participant. The list this
 * route returns, however, was built from every participant row, so a
 * member who was moved out of the chat still showed up in the
 * participant list the remaining members see.
 *
 * The request is authenticated with the non-production x-dev-user-id
 * header. The only stub is the `server-only` marker package (an empty
 * environment guard that throws outside a Server Component); every
 * database dependency runs for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import { chatParticipants, chats, db, eq, inArray, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

type ParticipantsResponse = {
  participants: Array<{ id: string; username: string | null }>;
};

let requesterId: string;
let activeMemberId: string;
let inactiveMemberId: string;
let chatId: string;
const allUserIds: string[] = [];

let GET: typeof import('../route').GET;

async function fetchParticipants() {
  const request = new NextRequest(
    new Request(`http://localhost/api/chats/${chatId}/participants`),
    { headers: { 'x-dev-user-id': requesterId } }
  );
  const response = await GET(request, {
    params: Promise.resolve({ id: chatId }),
  });
  const body = (await response.json().catch(() => null)) as
    | ParticipantsResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

beforeAll(async () => {
  ({ GET } = await import('../route'));

  [requesterId, activeMemberId, inactiveMemberId, chatId] = await Promise.all(
    Array.from({ length: 4 }, () => generateSnowflakeId())
  );
  allUserIds.push(requesterId, activeMemberId, inactiveMemberId);

  const now = new Date();

  await db.insert(users).values(
    allUserIds.map((id, i) => ({
      id,
      username: `test-f11-${i}-${id}`,
      displayName: `F11 Fixture ${i}`,
      updatedAt: now,
    }))
  );

  await db.insert(chats).values({
    id: chatId,
    name: 'F11 Fixture Group Chat',
    isGroup: true,
    createdAt: now,
    updatedAt: now,
  });

  const participantIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(chatParticipants).values([
    {
      id: participantIds[0]!,
      chatId,
      userId: requesterId,
      joinedAt: now,
      isActive: true,
    },
    {
      id: participantIds[1]!,
      chatId,
      userId: activeMemberId,
      joinedAt: now,
      isActive: true,
    },
    {
      // Moved out of this chat (e.g. tier demotion): the tiered group
      // service leaves the row in place with isActive=false.
      id: participantIds[2]!,
      chatId,
      userId: inactiveMemberId,
      joinedAt: now,
      isActive: false,
    },
  ]);
});

afterAll(async () => {
  await db.delete(chatParticipants).where(eq(chatParticipants.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('GET /api/chats/[id]/participants active filter', () => {
  it('lists only active participants, not members moved out of the chat', async () => {
    const { status, body } = await fetchParticipants();
    expect(status).toBe(200);
    const participants = (body as ParticipantsResponse | null)?.participants;
    expect(participants).toBeDefined();
    const ids = (participants ?? []).map((p) => p.id).sort();
    expect(ids).toEqual([requesterId, activeMemberId].sort());
  });
});
