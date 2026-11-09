import { afterAll, expect, test } from 'bun:test';
import { chatParticipants, chats, db, eq, users } from '@feed/db';
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

async function seedUser(userId: string): Promise<void> {
  await db.insert(users).values({
    id: userId,
    username: userId,
    isAgent: true,
    isTest: true,
    updatedAt: new Date(),
  });
}

async function seedChats(
  userId: string,
  total: number,
  joinedAtFor: (index: number) => Date
): Promise<void> {
  for (let i = 0; i < total; i++) {
    const joinedAt = joinedAtFor(i);
    await db.insert(chats).values({
      id: chatIdFor(userId, i),
      name: `Chat ${i}`,
      isGroup: true,
      createdBy: userId,
      createdAt: joinedAt,
      updatedAt: joinedAt,
    });
    await db.insert(chatParticipants).values({
      id: `${userId}-participant-${String(i).padStart(2, '0')}`,
      chatId: chatIdFor(userId, i),
      userId,
      joinedAt,
      isActive: true,
    });
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
  for (const userId of [pagerId, tieUserId, smallUserId]) {
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.userId, userId));
    await db.delete(chats).where(eq(chats.createdBy, userId));
    await db.delete(users).where(eq(users.id, userId));
  }
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
