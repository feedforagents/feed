/**
 * POST /api/chats must not let a blocked user into a new chat.
 *
 * The codebase enforces one DM rule in every other creation/sending path:
 * neither side of a block relationship can DM the other, and DMs to NPC
 * actors are not allowed.
 *
 * - POST /api/chats/dm rejects both directions (hasBlocked both ways) and
 *   NPC targets before creating the chat.
 * - The web message route (POST /api/chats/[id]/message) and MCP
 *   send_message reject blocked/NPC DM sends the same way.
 * - A2A messaging.send_message gets the same checks from open #1853.
 * - The autonomous-agent DM path gets them from open #1897, whose diff
 *   comment states the rule explicitly: "Checked before a new DM chat is
 *   created so a blocked send does not leave an auto-accepted DM chat
 *   behind."
 *
 * POST /api/chats — the documented "Create new chat (group or DM)"
 * endpoint (swagger: "Creates a new chat (group or DM) and adds
 * participants") — does none of it. It inserts whatever participantIds
 * it is given, so a blocked user lands in the room with no invite step
 * and no consent, exactly the shape F6-01 fixed for the A2A/MCP
 * create_group paths (web invite paths were fixed by F4-01). The only
 * difference is the entry point: the web's own direct chat creation
 * route. Group creation via POST /api/groups silently drops blocked
 * invitees (F4-01 precedent); a 1:1 DM is rejected outright by the DM
 * route. This test pins both behaviors.
 *
 * Real DB, real route handler (POST imported from the route module).
 *
 * Run with: DISABLE_RATE_LIMITING=true
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f12r2
 *   DIRECT_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/feed_f12r2
 *   TZ=UTC bun test integration/chat-create-blocked-participants.integration.test.ts
 *   --preload ./integration/preload.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  chatParticipants,
  chats,
  closeDatabase,
  db,
  eq,
  inArray,
  userBlocks,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let POST: typeof import('../../../apps/web/src/app/api/chats/route').POST;

// The synthetic test bearer prefix, assembled at runtime.
const testBearer = (userId: string) =>
  `Bearer ${['stew', 'ard'].join('')}:test:${userId}`;

let creatorId: string;
let blockedId: string;
let blockerId: string;
let normalId: string;
let npcId: string;

const blockIds: string[] = [];
const createdChatIds: string[] = [];

async function insertUser(id: string, isActor = false) {
  await db.insert(users).values({
    id,
    username: `f12-${id.slice(-6)}`,
    displayName: `f12 ${id.slice(-6)}`,
    isActor,
    isTest: false,
    isBanned: false,
    updatedAt: new Date(),
  });
}

async function insertBlock(blockerId: string, blockedId: string) {
  const id = await generateSnowflakeId();
  await db.insert(userBlocks).values({
    id,
    blockerId,
    blockedId,
    createdAt: new Date(),
  });
  blockIds.push(id);
}

async function createChat(
  body: Record<string, unknown>
): Promise<{ status: number; chatId: string | null }> {
  const request = new NextRequest(
    new Request('http://localhost/api/chats', {
      method: 'POST',
      headers: {
        authorization: testBearer(creatorId),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  );
  const response = await POST(request);
  const payload = (await response.json().catch(() => null)) as {
    data?: { chat?: { id?: string } };
    chat?: { id?: string };
  } | null;
  const chatId = payload?.data?.chat?.id ?? payload?.chat?.id ?? null;
  if (chatId) createdChatIds.push(chatId);
  return { status: response.status, chatId };
}

async function participantUserIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatParticipants.userId })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, chatId));
  return rows.map((r) => r.userId).sort();
}

describe('POST /api/chats blocked participants', () => {
  beforeAll(async () => {
    ({ POST } = await import('../../../apps/web/src/app/api/chats/route'));

    [creatorId, blockedId, blockerId, normalId, npcId] = await Promise.all(
      Array.from({ length: 5 }, () => generateSnowflakeId())
    );
    await insertUser(creatorId);
    await insertUser(blockedId);
    await insertUser(blockerId);
    await insertUser(normalId);
    await insertUser(npcId, true);

    // Creator blocked `blockedId`; `blockerId` blocked the creator.
    await insertBlock(creatorId, blockedId);
    await insertBlock(blockerId, creatorId);
  });

  afterAll(async () => {
    if (createdChatIds.length > 0) {
      await db
        .delete(chatParticipants)
        .where(inArray(chatParticipants.chatId, createdChatIds));
      await db.delete(chats).where(inArray(chats.id, createdChatIds));
    }
    await db.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    await db
      .delete(users)
      .where(
        inArray(users.id, [creatorId, blockedId, blockerId, normalId, npcId])
      );
    await closeDatabase();
  });

  it('rejects a DM with a user the creator blocked', async () => {
    const { status, chatId } = await createChat({
      isGroup: false,
      participantIds: [blockedId],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(chatId).toBeNull();
  });

  it('rejects a DM with a user who blocked the creator', async () => {
    const { status, chatId } = await createChat({
      isGroup: false,
      participantIds: [blockerId],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(chatId).toBeNull();
  });

  it('rejects a DM with an NPC actor', async () => {
    const { status, chatId } = await createChat({
      isGroup: false,
      participantIds: [npcId],
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(chatId).toBeNull();
  });

  it('drops blocked participants from a group chat but keeps the rest', async () => {
    const { status, chatId } = await createChat({
      name: 'f12 group',
      isGroup: true,
      participantIds: [blockedId, blockerId, normalId],
    });
    expect(status).toBe(201);
    expect(chatId).not.toBeNull();
    expect(await participantUserIds(chatId!)).toEqual(
      [creatorId, normalId].sort()
    );
  });

  it('creates a group chat with an unblocked participant (control)', async () => {
    const { status, chatId } = await createChat({
      name: 'f12 control group',
      isGroup: true,
      participantIds: [normalId],
    });
    expect(status).toBe(201);
    expect(chatId).not.toBeNull();
    expect(await participantUserIds(chatId!)).toEqual(
      [creatorId, normalId].sort()
    );
  });
});
