/** Account deletion and retained chat reactions. PRD §§7.1/9.5/12, MVP Phases 2/5. */
import { expect, mock, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const toggleCase =
  'keeps the count exact across react / duplicate / unreact / re-react';
const deletionCase =
  'stops counting a reactor once that reactor deletes their account';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks chat reaction deletion in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'account-deletion-message-reactions',
      file: 'packages/testing/integration/account-deletion-message-reactions.integration.test.ts',
      cases: [toggleCase, deletionCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();

  // The Next.js server-only marker has no runtime behavior under Bun.
  mock.module('server-only', () => ({}));
  const { chatParticipants, chats, db, eq, messageReactions, messages, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { NextRequest } = await import('next/server');
  const { POST: reactPOST, DELETE: reactDELETE } = await import(
    '../../../apps/web/src/app/api/chats/[id]/messages/[messageId]/reactions/route'
  );
  const { GET: chatGET } = await import(
    '../../../apps/web/src/app/api/chats/[id]/route'
  );
  const { POST: deleteAccountPOST } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  );

  async function seedChat() {
    const [reactorId, authorId, controlId, chatId, messageId] =
      await Promise.all([
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
        generateSnowflakeId(),
      ]);
    const members = [reactorId, authorId, controlId];
    const participants = await Promise.all(
      members.map(async (userId) => ({
        id: await generateSnowflakeId(),
        chatId,
        userId,
      }))
    );
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(users).values(
        members.map((id) => ({
          id,
          username: `f179-${id}`,
          displayName: 'Reaction fixture account',
          updatedAt: now,
        }))
      );
      await tx.insert(chats).values({
        id: chatId,
        name: 'Reaction deletion fixture chat',
        isGroup: true,
        createdBy: authorId,
        updatedAt: now,
      });
      await tx.insert(chatParticipants).values(participants);
      await tx.insert(messages).values({
        id: messageId,
        chatId,
        senderId: authorId,
        content: 'Reaction deletion fixture message',
        createdAt: now,
      });
    });
    return { reactorId, authorId, controlId, chatId, messageId };
  }

  function request(
    path: string,
    userId: string,
    method = 'GET',
    body?: object
  ) {
    const headers = new Headers({ 'x-dev-user-id': userId });
    if (body) headers.set('content-type', 'application/json');
    return new NextRequest(
      new Request(`http://localhost${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      })
    );
  }

  async function react(
    chatId: string,
    messageId: string,
    userId: string,
    emoji: string,
    method: 'POST' | 'DELETE' = 'POST'
  ) {
    const path = `/api/chats/${chatId}/messages/${messageId}/reactions`;
    const handler = method === 'POST' ? reactPOST : reactDELETE;
    const response = await handler(
      method === 'POST'
        ? request(path, userId, method, { emoji })
        : request(`${path}?emoji=${encodeURIComponent(emoji)}`, userId, method),
      { params: Promise.resolve({ id: chatId, messageId }) }
    );
    return response.status;
  }

  async function reactionCounts(
    chatId: string,
    messageId: string,
    viewerId: string
  ) {
    const response = await chatGET(request(`/api/chats/${chatId}`, viewerId), {
      params: Promise.resolve({ id: chatId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: {
        id: string;
        reactions: { emoji: string; count: number }[];
      }[];
    };
    const message = body.messages.find(({ id }) => id === messageId);
    expect(message).toBeDefined();
    return new Map(
      message?.reactions.map(({ emoji, count }) => [emoji, count])
    );
  }

  function reactionRowsBy(userId: string) {
    return db
      .select({ id: messageReactions.id })
      .from(messageReactions)
      .where(eq(messageReactions.userId, userId));
  }

  test(toggleCase, async () => {
    const { reactorId, authorId, chatId, messageId } = await seedChat();
    expect(await react(chatId, messageId, reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(chatId, messageId, authorId)).get('❤️')).toBe(
      1
    );

    expect(await react(chatId, messageId, reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(chatId, messageId, authorId)).get('❤️')).toBe(
      1
    );
    expect(await reactionRowsBy(reactorId)).toHaveLength(1);

    expect(await react(chatId, messageId, reactorId, '❤️', 'DELETE')).toBe(200);
    expect(
      (await reactionCounts(chatId, messageId, authorId)).get('❤️')
    ).toBeUndefined();
    expect(await reactionRowsBy(reactorId)).toHaveLength(0);

    expect(await react(chatId, messageId, reactorId, '❤️')).toBe(200);
    expect((await reactionCounts(chatId, messageId, authorId)).get('❤️')).toBe(
      1
    );
  });

  test(deletionCase, async () => {
    const { reactorId, authorId, controlId, chatId, messageId } =
      await seedChat();
    expect(await react(chatId, messageId, reactorId, '❤️')).toBe(200);
    expect(await react(chatId, messageId, authorId, '❤️')).toBe(200);
    expect(await react(chatId, messageId, controlId, '👍')).toBe(200);
    const before = await reactionCounts(chatId, messageId, authorId);
    expect(before.get('❤️')).toBe(2);
    expect(before.get('👍')).toBe(1);

    const response = await deleteAccountPOST(
      request('/api/users/delete-account', reactorId, 'POST', {
        confirmation: 'DELETE MY ACCOUNT',
      })
    );
    expect(response.status).toBe(200);
    const [gone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, reactorId));
    expect(gone).toBeUndefined();

    const after = await reactionCounts(chatId, messageId, authorId);
    expect(after.get('❤️')).toBe(1);
    expect(after.get('👍')).toBe(1);
    expect(await reactionRowsBy(reactorId)).toHaveLength(0);
  });
}
