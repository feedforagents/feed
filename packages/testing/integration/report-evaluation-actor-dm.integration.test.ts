/** Retained DM moderation. PRD §12 and MVP Phase 5. */
import { afterAll, describe, expect, it, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const suite = 'report evaluation DM evidence';
const cases = {
  active: 'collects messages from an active Snowflake DM',
  departed: 'keeps evidence from a departed DM after a new DM is opened',
  legacy: 'keeps legacy DM evidence without participant rows',
};

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('collects report evidence in a disposable PostgreSQL database', async () => {
    await runIsolatedSubMarketCases({
      name: 'report-evaluation-actor-dm',
      file: 'packages/testing/integration/report-evaluation-actor-dm.integration.test.ts',
      cases: Object.values(cases).map((name) => `${suite} > ${name}`),
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { collectReportContext } = await import('@feed/api');
  const {
    and,
    chatParticipants,
    chats,
    closeDatabase,
    db,
    eq,
    reports,
    users,
  } = await import('@feed/db');
  const { findDMChat, getOrCreateDMChat, sendMessageToChat } = await import(
    '@feed/engine'
  );
  const { generateSnowflakeId } = await import('@feed/shared');

  afterAll(async () => {
    await closeDatabase();
  }, 10_000);

  async function seedUser(isActor = false) {
    const id = await generateSnowflakeId();
    const [user] = await db
      .insert(users)
      .values({
        id,
        username: `report-eval-${id}`,
        isActor,
        updatedAt: new Date(),
      })
      .returning({ id: users.id });
    if (!user) throw new Error('User fixture was not created');
    return user.id;
  }

  async function seedReport(reporterId: string, reportedUserId: string) {
    const [report] = await db
      .insert(reports)
      .values({
        id: await generateSnowflakeId(),
        reporterId,
        reportedUserId,
        reportType: 'user',
        category: 'scam',
        reason: 'Message reported by a fixture participant',
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning({ id: reports.id });
    if (!report) throw new Error('Report fixture was not created');
    return report.id;
  }

  describe(suite, () => {
    it(cases.active, async () => {
      const reporterId = await seedUser();
      const actorId = await seedUser(true);
      const chatId = await getOrCreateDMChat(actorId, reporterId);
      expect(chatId.startsWith('dm-')).toBe(false);
      const messageId = await sendMessageToChat(
        chatId,
        actorId,
        'Reported message'
      );
      const reportId = await seedReport(reporterId, actorId);

      const context = await collectReportContext(reportId);
      expect(context?.chatMessages).toEqual([
        expect.objectContaining({ id: messageId, senderId: actorId }),
      ]);
    });

    it(cases.departed, async () => {
      const reporterId = await seedUser();
      const actorId = await seedUser(true);
      const otherId = await seedUser();
      const oldChat = await getOrCreateDMChat(actorId, reporterId);
      const oldMessage = await sendMessageToChat(
        oldChat,
        actorId,
        'Earlier message'
      );
      // The leave endpoint removes the active membership row.
      const departed = await db
        .delete(chatParticipants)
        .where(
          and(
            eq(chatParticipants.chatId, oldChat),
            eq(chatParticipants.userId, reporterId)
          )
        )
        .returning({ id: chatParticipants.id });
      expect(departed).toHaveLength(1);
      expect(await findDMChat(reporterId, actorId)).toBeNull();

      const reportId = await seedReport(reporterId, actorId);
      const departedContext = await collectReportContext(reportId);
      expect(departedContext?.chatMessages.map(({ id }) => id)).toEqual([
        oldMessage,
      ]);

      // Reverse the creator to prove both stored acceptance orientations.
      const newChat = await getOrCreateDMChat(reporterId, actorId);
      expect(newChat).not.toBe(oldChat);
      const newMessage = await sendMessageToChat(
        newChat,
        reporterId,
        'Later message'
      );
      const unrelatedChat = await getOrCreateDMChat(actorId, otherId);
      await sendMessageToChat(unrelatedChat, actorId, 'Unrelated conversation');

      const context = await collectReportContext(reportId);
      expect(context?.chatMessages.map(({ id }) => id).sort()).toEqual(
        [newMessage, oldMessage].sort()
      );
    });

    it(cases.legacy, async () => {
      const reporterId = await seedUser();
      const humanId = await seedUser();
      const chatId = `dm-${[reporterId, humanId].sort().join('-')}`;
      await db
        .insert(chats)
        .values({ id: chatId, isGroup: false, updatedAt: new Date() });
      const messageId = await sendMessageToChat(
        chatId,
        humanId,
        'Legacy message'
      );
      const reportId = await seedReport(reporterId, humanId);

      const context = await collectReportContext(reportId);
      expect(context?.chatMessages.map(({ id }) => id)).toEqual([messageId]);
    });
  });
}
