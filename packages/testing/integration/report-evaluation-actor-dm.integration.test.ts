/**
 * PRD §12 (moderation): a report evaluation must see the DM evidence
 * between reporter and reported user. Actor/NPC DMs are created by
 * getOrCreateDMChat with a Snowflake chat id, not the legacy
 * `dm-<sorted ids>` id the evaluator used to assume, so reports against
 * actors silently evaluated with zero chat messages.
 *
 * Runs the real context collection against a real database. Nothing is
 * mocked: the DM chat is created through the production getOrCreateDMChat
 * path, and the report row is a real row.
 *
 * Run with:
 *   DATABASE_URL=<redacted>
 *     bun test packages/testing/integration/report-evaluation-actor-dm.integration.test.ts \
 *     --preload ./integration/preload.ts   (from packages/testing)
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { collectReportContext } from '@feed/api';
import {
  chatParticipants,
  chats,
  db,
  eq,
  messages,
  reports,
  users,
} from '@feed/db';
import { findDMChat, getOrCreateDMChat } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

const reporterId = await generateSnowflakeId();
const actorId = await generateSnowflakeId();
const humanId = await generateSnowflakeId();
const actorReportId = await generateSnowflakeId();
const humanReportId = await generateSnowflakeId();
let actorChatId = '';

async function seedReport(
  reportId: string,
  reporter: string,
  reported: string
) {
  await db.insert(reports).values({
    id: reportId,
    reporterId: reporter,
    reportedUserId: reported,
    reportType: 'user',
    category: 'scam',
    reason: 'Sent a scam pitch in DM',
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('report evaluation DM evidence', () => {
  beforeAll(async () => {
    await db.insert(users).values([
      {
        id: reporterId,
        username: `report-eval-reporter-${reporterId}`,
        virtualBalance: '10000',
        totalDeposited: '10000',
        updatedAt: new Date(),
      },
      {
        id: actorId,
        username: `report-eval-actor-${actorId}`,
        isActor: true,
        virtualBalance: '10000',
        totalDeposited: '10000',
        updatedAt: new Date(),
      },
      {
        id: humanId,
        username: `report-eval-human-${humanId}`,
        virtualBalance: '10000',
        totalDeposited: '10000',
        updatedAt: new Date(),
      },
    ]);

    // Actor DM created through the production path: Snowflake chat id.
    actorChatId = await getOrCreateDMChat(actorId, reporterId);
    expect(actorChatId.startsWith('dm-')).toBe(false);
    expect(await findDMChat(reporterId, actorId)).toBe(actorChatId);
    await db.insert(messages).values({
      id: await generateSnowflakeId(),
      chatId: actorChatId,
      senderId: actorId,
      content: 'Send me 500 points and I will double them for you.',
      createdAt: new Date(),
    });
    await seedReport(actorReportId, reporterId, actorId);

    // Legacy human-human DM: the `dm-<sorted ids>` id with participants.
    const sortedIds = [reporterId, humanId].sort();
    const legacyChatId = `dm-${sortedIds.join('-')}`;
    await db.insert(chats).values({
      id: legacyChatId,
      isGroup: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(chatParticipants).values([
      {
        id: await generateSnowflakeId(),
        chatId: legacyChatId,
        userId: reporterId,
        joinedAt: new Date(),
        isActive: true,
      },
      {
        id: await generateSnowflakeId(),
        chatId: legacyChatId,
        userId: humanId,
        joinedAt: new Date(),
        isActive: true,
      },
    ]);
    await db.insert(messages).values({
      id: await generateSnowflakeId(),
      chatId: legacyChatId,
      senderId: humanId,
      content: 'Hello, this is a normal human DM.',
      createdAt: new Date(),
    });
    await seedReport(humanReportId, reporterId, humanId);
  });

  afterAll(async () => {
    await db.delete(messages).where(eq(messages.chatId, actorChatId));
    const sortedIds = [reporterId, humanId].sort();
    const legacyChatId = `dm-${sortedIds.join('-')}`;
    await db.delete(messages).where(eq(messages.chatId, legacyChatId));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, legacyChatId));
    await db.delete(chats).where(eq(chats.id, legacyChatId));
    await db.delete(chats).where(eq(chats.id, actorChatId));
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, actorChatId));
    await db.delete(reports).where(eq(reports.reporterId, reporterId));
    await db.delete(users).where(eq(users.id, reporterId));
    await db.delete(users).where(eq(users.id, actorId));
    await db.delete(users).where(eq(users.id, humanId));
  });

  it('sees the actor DM messages, not zero evidence', async () => {
    const context = await collectReportContext(actorReportId);
    expect(context).not.toBeNull();
    expect(context!.chatMessages).toHaveLength(1);
    expect(context!.chatMessages[0]!.content).toContain('double them');
    expect(context!.chatMessages[0]!.senderId).toBe(actorId);
  });

  it('still sees legacy human-human DM messages', async () => {
    const context = await collectReportContext(humanReportId);
    expect(context).not.toBeNull();
    expect(context!.chatMessages).toHaveLength(1);
    expect(context!.chatMessages[0]!.content).toContain('normal human DM');
  });
});
