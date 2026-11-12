import { afterAll, expect, test } from 'bun:test';
import { chatParticipants, chats, db, eq, inArray, users } from '@feed/db';
import { FeedAgentExecutor } from '../../a2a/src/executors/feed-executor';

/**
 * A2A messaging.get_chats is documented as "List all chats" (docs/skills.md),
 * but the handler capped the participant query at `limit` (default 20, max 50)
 * with no offset/cursor, so an account in more chats than the cap could never
 * reach the rest. These tests page through the full membership list the same
 * way an agent client would and require every chat to be reachable exactly
 * once.
 */

const suffix = crypto.randomUUID();
const pagerId = `chatlist-pager-${suffix}`;
const tieUserId = `chatlist-ties-${suffix}`;
const smallUserId = `chatlist-small-${suffix}`;

const PAGED_TOTAL = 60;
const TIE_TOTAL = 30;
const baseTime = Date.UTC(2026, 0, 5, 12, 0, 0);

function chatIdFor(userId: string, index: number): string {
  return `${userId}-chat-${String(index).padStart(2, '0')}`;
}

function participantIdFor(userId: string, index: number): string {
  return `${userId}-participant-${String(index).padStart(2, '0')}`;
}

// Rows this suite actually created. Every fixture insert records its id from
// INSERT RETURNING immediately, and teardown deletes only these ids — never
// rows matched by a proposed id, userId, or createdBy, which could belong to
// someone else if a setup insert collided or failed partway.
const owned = {
  users: [] as string[],
  chats: [] as string[],
  participants: [] as string[],
};

async function deleteOwnedRows(target: typeof owned): Promise<void> {
  if (target.participants.length > 0) {
    await db
      .delete(chatParticipants)
      .where(inArray(chatParticipants.id, target.participants));
  }
  if (target.chats.length > 0) {
    await db.delete(chats).where(inArray(chats.id, target.chats));
  }
  if (target.users.length > 0) {
    await db.delete(users).where(inArray(users.id, target.users));
  }
}

async function seedUser(userId: string): Promise<void> {
  const [row] = await db
    .insert(users)
    .values({
      id: userId,
      username: userId,
      isAgent: true,
      isTest: true,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  if (row) owned.users.push(row.id);
}

async function seedChatRow(
  userId: string,
  index: number,
  joinedAt: Date
): Promise<void> {
  const [chatRow] = await db
    .insert(chats)
    .values({
      id: chatIdFor(userId, index),
      name: `Chat ${index}`,
      isGroup: true,
      createdBy: userId,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    })
    .returning({ id: chats.id });
  if (chatRow) owned.chats.push(chatRow.id);
  const [participantRow] = await db
    .insert(chatParticipants)
    .values({
      id: participantIdFor(userId, index),
      chatId: chatIdFor(userId, index),
      userId,
      joinedAt,
      isActive: true,
    })
    .returning({ id: chatParticipants.id });
  if (participantRow) owned.participants.push(participantRow.id);
}

async function seedChats(
  userId: string,
  total: number,
  joinedAtFor: (index: number) => Date
): Promise<void> {
  for (let i = 0; i < total; i++) {
    await seedChatRow(userId, i, joinedAtFor(i));
  }
}

interface ChatsResult {
  chats: Array<{ id: string }>;
}

async function getChats(
  userId: string,
  params: Record<string, number>
): Promise<ChatsResult> {
  const raw: unknown = await FeedAgentExecutor.executeDirectly(
    'messaging.get_chats',
    params,
    userId
  );
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { chats?: unknown }).chats)
  ) {
    throw new Error('messaging.get_chats returned an unexpected shape');
  }
  const chats = (raw as { chats: Array<{ id?: unknown }> }).chats;
  return {
    chats: chats.map((chat) => {
      if (
        typeof chat !== 'object' ||
        chat === null ||
        typeof chat.id !== 'string'
      ) {
        throw new Error(
          'messaging.get_chats returned a chat without a string id'
        );
      }
      return { id: chat.id };
    }),
  };
}

async function walkAllChats(
  userId: string,
  pageSize: number,
  total: number
): Promise<string[]> {
  const seen: string[] = [];
  // Bounded: a correct walk needs ceil(total / pageSize) full pages plus one
  // short/empty page. Anything beyond that means pages are repeating.
  const maxPages = Math.ceil(total / pageSize) + 2;
  for (let page = 0; page < maxPages; page++) {
    const result = await getChats(userId, {
      limit: pageSize,
      offset: page * pageSize,
    });
    seen.push(...result.chats.map((c) => c.id));
    if (result.chats.length < pageSize) break;
  }
  return seen;
}

afterAll(async () => {
  await deleteOwnedRows(owned);
});

test('paging reaches every chat exactly once past the 50-chat cap', async () => {
  await seedUser(pagerId);
  // Distinct joinedAt, increasing with index: most recent join is index 59.
  await seedChats(pagerId, PAGED_TOTAL, (i) => new Date(baseTime + i * 60_000));

  // Default and max-limit calls keep their current window semantics:
  // the most recently joined chats, newest first.
  const defaultPage = await getChats(pagerId, {});
  expect(defaultPage.chats.length).toBe(20);
  expect(defaultPage.chats[0]?.id).toBe(chatIdFor(pagerId, 59));

  const maxPage = await getChats(pagerId, { limit: 50 });
  expect(maxPage.chats.length).toBe(50);
  expect(maxPage.chats[0]?.id).toBe(chatIdFor(pagerId, 59));
  expect(maxPage.chats[49]?.id).toBe(chatIdFor(pagerId, 10));

  // Offset paging must continue where the first window stopped and reach
  // every remaining chat exactly once.
  const walked = await walkAllChats(pagerId, 20, PAGED_TOTAL);
  expect(walked.length).toBe(PAGED_TOTAL);
  expect(new Set(walked).size).toBe(PAGED_TOTAL);
  expect(new Set(walked)).toEqual(
    new Set(
      Array.from({ length: PAGED_TOTAL }, (_, i) => chatIdFor(pagerId, i))
    )
  );
});

test('paging is deterministic when many memberships share one joinedAt', async () => {
  await seedUser(tieUserId);
  // One batch join: every membership carries the exact same joinedAt, so the
  // order — and therefore which chats fall inside each page — is only defined
  // if the query carries a total order.
  const batchTime = new Date(baseTime);
  await seedChats(tieUserId, TIE_TOTAL, () => batchTime);

  const expected = new Set(
    Array.from({ length: TIE_TOTAL }, (_, i) => chatIdFor(tieUserId, i))
  );
  for (let walk = 0; walk < 3; walk++) {
    const walked = await walkAllChats(tieUserId, 10, TIE_TOTAL);
    expect(walked.length).toBe(TIE_TOTAL);
    expect(new Set(walked).size).toBe(TIE_TOTAL);
    expect(new Set(walked)).toEqual(expected);
  }
});

test('accounts with few chats still get them all in one default call', async () => {
  await seedUser(smallUserId);
  await seedChats(smallUserId, 2, (i) => new Date(baseTime + i * 60_000));

  const result = await getChats(smallUserId, {});
  expect(result.chats.length).toBe(2);
  expect(new Set(result.chats.map((c) => c.id))).toEqual(
    new Set([chatIdFor(smallUserId, 0), chatIdFor(smallUserId, 1)])
  );
});

test('fixture ownership control (partial setup / collision)', async () => {
  // The old teardown deleted by proposed userId/createdBy, so it would have
  // removed a pre-existing membership and a chat the user created outside
  // this suite. The new teardown deletes only ids recorded from successful
  // INSERT RETURNING, so foreign rows must survive a partial setup.
  const controlUserId = `chatlist-control-${suffix}`;
  const foreignUserId = `keep-foreign-user-${suffix}`;
  const foreignChatId = `keep-foreign-chat-${suffix}`;
  const foreignMembershipId = `${controlUserId}-participant-foreign`;
  const foreignCreatedByChatId = `keep-foreign-createdby-${suffix}`;
  const collidingChatId = chatIdFor(controlUserId, 1);

  const foreignOwned: typeof owned = { users: [], chats: [], participants: [] };

  try {
    // Foreign rows the suite must never touch.
    const [foreignUserRow] = await db
      .insert(users)
      .values({
        id: foreignUserId,
        username: foreignUserId,
        isAgent: true,
        isTest: true,
        updatedAt: new Date(),
      })
      .returning({ id: users.id });
    if (foreignUserRow) foreignOwned.users.push(foreignUserRow.id);
    const [foreignChatRow] = await db
      .insert(chats)
      .values({
        id: foreignChatId,
        name: 'Foreign chat',
        isGroup: true,
        createdBy: foreignUserId,
        createdAt: new Date(baseTime),
        updatedAt: new Date(baseTime),
      })
      .returning({ id: chats.id });
    if (foreignChatRow) foreignOwned.chats.push(foreignChatRow.id);
    const [foreignUserParticipantRow] = await db
      .insert(chatParticipants)
      .values({
        id: `${foreignUserId}-participant-00`,
        chatId: foreignChatId,
        userId: foreignUserId,
        joinedAt: new Date(baseTime),
        isActive: true,
      })
      .returning({ id: chatParticipants.id });
    if (foreignUserParticipantRow) {
      foreignOwned.participants.push(foreignUserParticipantRow.id);
    }
    // Pre-existing membership of the control user in the foreign chat.
    const [foreignMembershipRow] = await db
      .insert(chatParticipants)
      .values({
        id: foreignMembershipId,
        chatId: foreignChatId,
        userId: controlUserId,
        joinedAt: new Date(baseTime),
        isActive: true,
      })
      .returning({ id: chatParticipants.id });
    if (foreignMembershipRow) {
      foreignOwned.participants.push(foreignMembershipRow.id);
    }
    // A chat the control user created outside this suite.
    const [foreignCreatedByChatRow] = await db
      .insert(chats)
      .values({
        id: foreignCreatedByChatId,
        name: 'Foreign chat created by control user',
        isGroup: true,
        createdBy: controlUserId,
        createdAt: new Date(baseTime),
        updatedAt: new Date(baseTime),
      })
      .returning({ id: chats.id });
    if (foreignCreatedByChatRow) {
      foreignOwned.chats.push(foreignCreatedByChatRow.id);
    }
    // A foreign chat squatting on the exact id the suite will propose for
    // index 1, so that insert collides and setup stops partway.
    const [collidingChatRow] = await db
      .insert(chats)
      .values({
        id: collidingChatId,
        name: 'Foreign colliding chat',
        isGroup: true,
        createdBy: foreignUserId,
        createdAt: new Date(baseTime),
        updatedAt: new Date(baseTime),
      })
      .returning({ id: chats.id });
    if (collidingChatRow) foreignOwned.chats.push(collidingChatRow.id);

    // Partial setup: index 0 succeeds, index 1 collides, indices 2-4 succeed.
    await seedUser(controlUserId);
    await seedChatRow(controlUserId, 0, new Date(baseTime));
    await expect(
      seedChatRow(controlUserId, 1, new Date(baseTime + 60_000))
    ).rejects.toThrow();
    for (const i of [2, 3, 4]) {
      await seedChatRow(controlUserId, i, new Date(baseTime + i * 60_000));
    }

    await deleteOwnedRows(owned);

    // Owned rows are gone even though setup failed partway.
    expect(
      await db.select().from(users).where(eq(users.id, controlUserId))
    ).toHaveLength(0);
    for (const i of [0, 2, 3, 4]) {
      expect(
        await db
          .select()
          .from(chats)
          .where(eq(chats.id, chatIdFor(controlUserId, i)))
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(chatParticipants)
          .where(eq(chatParticipants.id, participantIdFor(controlUserId, i)))
      ).toHaveLength(0);
    }

    // Every foreign row survives unchanged.
    expect(
      await db.select().from(users).where(eq(users.id, foreignUserId))
    ).toHaveLength(1);
    const survivingChat = await db
      .select()
      .from(chats)
      .where(eq(chats.id, foreignChatId));
    expect(survivingChat).toHaveLength(1);
    expect(survivingChat[0]?.createdBy).toBe(foreignUserId);
    expect(
      await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.id, `${foreignUserId}-participant-00`))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(chatParticipants)
        .where(eq(chatParticipants.id, foreignMembershipId))
    ).toHaveLength(1);
    const survivingCreatedByChat = await db
      .select()
      .from(chats)
      .where(eq(chats.id, foreignCreatedByChatId));
    expect(survivingCreatedByChat).toHaveLength(1);
    expect(survivingCreatedByChat[0]?.createdBy).toBe(controlUserId);
    const survivingCollidingChat = await db
      .select()
      .from(chats)
      .where(eq(chats.id, collidingChatId));
    expect(survivingCollidingChat).toHaveLength(1);
    expect(survivingCollidingChat[0]?.createdBy).toBe(foreignUserId);
  } finally {
    await deleteOwnedRows(foreignOwned);
  }
});
