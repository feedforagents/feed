/** Account deletion preserves the retained chat history (PRD §§7.1, 9.5, 12). */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createStewardTestToken } from './helpers/steward-auth';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'Account deletion and retained chat history';
const cases = {
  member: 'removes only the departing member and keeps the DM readable',
  standalone: 'deletes an account without any chat rows',
};
const deletePath = '/api/users/delete-account';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks account deletion in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'account-deletion-chat-participants',
      file: 'packages/testing/integration/account-deletion-chat-participants.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  process.env.STEWARD_JWT_SECRET = crypto.randomUUID();
  process.env.ALLOW_TEST_PRIVY_DID_AUTH = 'false';
  mock.module('server-only', () => ({}));

  const { chatParticipants, chats, db, eq, messages, users } = await import(
    '@feed/db'
  );
  const { generateSnowflakeId } = await import('@feed/shared');
  const { GET: chatDetail } = await import(
    '../../../apps/web/src/app/api/chats/[id]/route'
  );
  const { POST: deleteAccount } = await import(
    '../../../apps/web/src/app/api/users/delete-account/route'
  );

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'POST' && path === deletePath) {
        return deleteAccount(new NextRequest(request));
      }
      const [, id] = /^\/api\/chats\/([^/]+)$/.exec(path) ?? [];
      if (request.method === 'GET' && id) {
        return chatDetail(new NextRequest(request), {
          params: Promise.resolve({ id }),
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  afterAll(() => server.stop(true));

  async function createUser(label: string) {
    const id = await generateSnowflakeId();
    const stewardId = `f183-fixture-${id}`;
    await db.insert(users).values({
      id,
      stewardId,
      username: `f183-${label}-${id}`,
      displayName: label,
      updatedAt: new Date(),
    });
    return { id, stewardId };
  }

  async function sendAs(
    user: { stewardId: string },
    path: string,
    options: RequestInit = {}
  ) {
    const headers = new Headers(options.headers);
    headers.set(
      'authorization',
      `Bearer ${await createStewardTestToken(user.stewardId)}`
    );
    return fetch(new URL(path, server.url), { ...options, headers });
  }

  async function deleteFixture(user: { stewardId: string }) {
    return sendAs(user, deletePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE MY ACCOUNT' }),
    });
  }

  type ChatDetail = {
    participants: Array<{ id: string }>;
    messages: Array<{ id: string }>;
  };

  async function readChat(user: { stewardId: string }, id: string) {
    const response = await sendAs(user, `/api/chats/${id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatDetail & {
      data?: ChatDetail;
    };
    return body.data ?? body;
  }

  async function userExists(id: string) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id));
    return !!row;
  }

  describe(suite, () => {
    test(cases.member, async () => {
      const departing = await createUser('departing');
      const recipient = await createUser('recipient');
      const groupMember = await createUser('group-member');
      const groupChatId = await generateSnowflakeId();
      const dmChatId = await generateSnowflakeId();
      const dmMessageId = await generateSnowflakeId();
      const now = new Date();

      await db.insert(chats).values([
        {
          id: groupChatId,
          name: 'F183 group chat',
          isGroup: true,
          createdBy: recipient.id,
          updatedAt: now,
        },
        {
          id: dmChatId,
          isGroup: false,
          createdBy: departing.id,
          updatedAt: now,
        },
      ]);
      await db.insert(chatParticipants).values(
        await Promise.all(
          [
            { chatId: groupChatId, userId: departing.id },
            { chatId: groupChatId, userId: recipient.id },
            { chatId: groupChatId, userId: groupMember.id },
            { chatId: dmChatId, userId: departing.id },
            { chatId: dmChatId, userId: recipient.id },
          ].map(async (row) => ({
            ...row,
            id: await generateSnowflakeId(),
            isActive: true,
          }))
        )
      );
      await db.insert(messages).values({
        id: dmMessageId,
        chatId: dmChatId,
        senderId: departing.id,
        content: 'F183 retained direct message',
        type: 'user',
        createdAt: new Date(now.getTime() - 5 * 60_000),
      });

      const before = await readChat(recipient, groupChatId);
      expect(before.participants.map((p) => p.id).sort()).toEqual(
        [departing.id, recipient.id, groupMember.id].sort()
      );

      const response = await deleteFixture(departing);
      expect(response.status).toBe(200);
      expect(await userExists(departing.id)).toBe(false);
      const remaining = await db
        .select({
          chatId: chatParticipants.chatId,
          userId: chatParticipants.userId,
        })
        .from(chatParticipants);
      const post = await readChat(recipient, groupChatId);
      const dm = await readChat(recipient, dmChatId);
      const departingRows = remaining.filter(
        (row) => row.userId === departing.id
      );
      const retainedMessage = dm.messages.some(
        (message) => message.id === dmMessageId
      );
      console.info(
        `[F183] account-delete=${response.status} departing-memberships=${departingRows.length} group-members=${post.participants.length} dm-message-retained=${retainedMessage}`
      );
      expect(departingRows).toHaveLength(0);
      expect(
        remaining.map((row) => `${row.chatId}:${row.userId}`).sort()
      ).toEqual(
        [
          `${groupChatId}:${recipient.id}`,
          `${groupChatId}:${groupMember.id}`,
          `${dmChatId}:${recipient.id}`,
        ].sort()
      );
      expect(post.participants.map((p) => p.id).sort()).toEqual(
        [recipient.id, groupMember.id].sort()
      );
      expect(retainedMessage).toBe(true);
    });

    test(cases.standalone, async () => {
      const user = await createUser('without-chats');
      const response = await deleteFixture(user);
      expect(response.status).toBe(200);
      expect(await userExists(user.id)).toBe(false);
    });
  });
}
