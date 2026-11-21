/**
 * Chat message reaction counts after the reactor deletes their account,
 * against a real database and the real routes.
 *
 * POST /api/users/delete-account states the contract in its own response:
 * "Your account and personal data have been deleted from our servers." The
 * route deletes the user's follows, interactions, group memberships,
 * invites, follow statuses, share actions and pool deposits inside the
 * deletion transaction and relies on schema cascades for "most other
 * tables". MessageReaction has no foreign keys at all, so nothing
 * cascades: a deleted user's chat reactions survive and every reaction
 * count keeps counting a person who no longer exists (the chat view
 * aggregates MessageReaction with a plain COUNT grouped by emoji — no
 * join against the user table).
 *
 * Sibling precedent: open PR #1858 cleans up the post/comment Reaction
 * table in the same transaction for exactly this shape. MessageReaction
 * is the chat-side twin and was not covered there (its diff never
 * mentions this table). Deleting the account must do the same for the
 * reactions the account left in chats.
 *
 * Toggle guard in the same file: the react -> duplicate-react ->
 * unreact -> re-react cycle must keep the count exact (the POST handler
 * is idempotent per (messageId, userId, emoji)).
 *
 * Auth uses the non-production x-dev-user-id header. Only the
 * `server-only` marker package is stubbed.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

import {
  chatParticipants,
  chats,
  db,
  eq,
  inArray,
  messageReactions,
  messages,
  notifications,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let reactorId: string;
let authorId: string;
let controlId: string;
let chatId: string;
let messageId: string;
const ownedUserIds: string[] = [];

let reactPOST: typeof import('../../../apps/web/src/app/api/chats/[id]/messages/[messageId]/reactions/route').POST;
let reactDELETE: typeof import('../../../apps/web/src/app/api/chats/[id]/messages/[messageId]/reactions/route').DELETE;
let chatGET: typeof import('../../../apps/web/src/app/api/chats/[id]/route').GET;
let deleteAccountPOST: typeof import('../../../apps/web/src/app/api/users/delete-account/route').POST;

function req(url: string, userId: string, method = 'GET', body?: unknown) {
  return new NextRequest(
    new Request(url, {
      method,
      headers: {
        'x-dev-user-id': userId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

async function react(
  userId: string,
  emoji: string,
  method: 'POST' | 'DELETE' = 'POST'
) {
  const url =
    method === 'POST'
      ? `http://localhost/api/chats/${chatId}/messages/${messageId}/reactions`
      : `http://localhost/api/chats/${chatId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`;
  const response = await (method === 'POST' ? reactPOST : reactDELETE)(
    req(url, userId, method, method === 'POST' ? { emoji } : undefined),
    { params: Promise.resolve({ id: chatId, messageId }) }
  );
  return response.status;
}

function findMessage(node: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findMessage(v);
      if (hit) return hit;
    }
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.id === messageId && Array.isArray(o.reactions)) return o;
    for (const v of Object.values(o)) {
      const hit = findMessage(v);
      if (hit) return hit;
    }
  }
  return undefined;
}

async function reactionCounts(viewerId: string) {
  const response = await chatGET(
    req(`http://localhost/api/chats/${chatId}`, viewerId),
    {
      params: Promise.resolve({ id: chatId }),
    }
  );
  const body = await response.json().catch(() => null);
  const message = findMessage(body);
  const counts = new Map<string, number>();
  for (const r of (message?.reactions ?? []) as Array<{
    emoji: string;
    count: number;
  }>) {
    counts.set(r.emoji, r.count);
  }
  return counts;
}

async function reactionRowsBy(userId: string) {
  return db
    .select({ id: messageReactions.id })
    .from(messageReactions)
    .where(eq(messageReactions.userId, userId));
}

beforeAll(async () => {
  ({ POST: reactPOST, DELETE: reactDELETE } = await import(
    '../../../apps/web/src/app/api/chats/[id]/messages/[messageId]/reactions/route'
  ));
  ({ GET: chatGET } = await import(
    '../../../apps/web/src/app/api/chats/[id]/route'
  ));
  ({ POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  ));

  [reactorId, authorId, controlId, chatId, messageId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  ownedUserIds.push(reactorId, authorId, controlId);

  const now = new Date();
  const past = new Date(now.getTime() - 10 * 60_000);

  // privyId = own id so ensureUserForAuth resolves the fixture row
  // directly instead of provisioning a fresh account.
  await db.insert(users).values([
    {
      id: reactorId,
      privyId: reactorId,
      username: `f179-reactor-${reactorId}`,
      displayName: 'F179 Reactor',
      updatedAt: now,
    },
    {
      id: authorId,
      privyId: authorId,
      username: `f179-author-${authorId}`,
      displayName: 'F179 Author',
      updatedAt: now,
    },
    {
      id: controlId,
      privyId: controlId,
      username: `f179-control-${controlId}`,
      displayName: 'F179 Control',
      updatedAt: now,
    },
  ]);

  await db.insert(chats).values({
    id: chatId,
    name: 'F179 reaction deletion chat',
    isGroup: true,
    createdBy: authorId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chatParticipants).values([
    {
      id: await generateSnowflakeId(),
      chatId,
      userId: reactorId,
      isActive: true,
    },
    {
      id: await generateSnowflakeId(),
      chatId,
      userId: authorId,
      isActive: true,
    },
    {
      id: await generateSnowflakeId(),
      chatId,
      userId: controlId,
      isActive: true,
    },
  ]);
  await db.insert(messages).values({
    id: messageId,
    chatId,
    senderId: authorId,
    content: 'Fixture message for reaction deletion test',
    type: 'user',
    createdAt: past,
  });
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(eq(notifications.chatId, chatId))
    .catch(() => {});
  await db.delete(messageReactions).where(eq(messageReactions.chatId, chatId));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatParticipants).where(eq(chatParticipants.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  if (ownedUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, ownedUserIds));
  }
});

describe('chat message reaction counts', () => {
  it('keeps the count exact across react / duplicate / unreact / re-react', async () => {
    expect(await react(reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(authorId)).get('❤️')).toBe(1);

    // Duplicate react is idempotent: still one row, count stays 1.
    expect(await react(reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(authorId)).get('❤️')).toBe(1);
    expect(await reactionRowsBy(reactorId)).toHaveLength(1);

    expect(await react(reactorId, '❤️', 'DELETE')).toBe(200);
    expect((await reactionCounts(authorId)).get('❤️')).toBeUndefined();
    expect(await reactionRowsBy(reactorId)).toHaveLength(0);

    expect(await react(reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(authorId)).get('❤️')).toBe(1);
  });

  it('stops counting a reactor once that reactor deletes their account', async () => {
    expect(await react(authorId, '❤️')).toBe(200);
    expect(await react(controlId, '👍')).toBe(200);
    const before = await reactionCounts(authorId);
    expect(before.get('❤️')).toBe(2);
    expect(before.get('👍')).toBe(1);

    const response = await deleteAccountPOST(
      req('http://localhost/api/users/delete-account', reactorId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(response.status).toBe(200);

    // The account itself is gone (the route's own contract).
    const [gone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, reactorId));
    expect(gone).toBeUndefined();

    // Its chat reactions must be gone too: only the author's own ❤️ and
    // the control user's 👍 remain in the count.
    const after = await reactionCounts(authorId);
    expect(after.get('❤️')).toBe(1);
    expect(after.get('👍')).toBe(1);
    expect(await reactionRowsBy(reactorId)).toHaveLength(0);
  });
});
