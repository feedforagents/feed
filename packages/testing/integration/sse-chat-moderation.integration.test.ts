/**
 * GET /api/sse/events for chat channels against a real database and a real
 * Redis stream: the live copy of a group chat must honor the same viewer
 * moderation rule as the group chat history.
 *
 * The history surface applies the viewer rule — authors the viewer blocked
 * or muted, and authors who blocked the viewer, do not appear in a group
 * chat the viewer reads, and a visible reply cannot quote a hidden author's
 * message back in (see the group-chat history fix, #1710, and the shared
 * rule in apps/web/src/app/api/feed/_lib/viewer-moderation.ts). Every other
 * reading surface filters server-side; the block/mute dialogs promise
 * "Hide their posts from your feed".
 *
 * But a group message is also delivered live: the send route broadcasts the
 * full message (plus a 200-char quote of any replied-to message) to the
 * chat's realtime channel, the SSE endpoint forwards every event on an
 * authorized channel verbatim, and the web client appends `new_message`
 * payloads straight into the rendered list. Nothing in that path consults
 * the viewer's moderation relationships, so a blocked member's message —
 * hidden on refresh — appears live in the group the moment it is sent.
 *
 * Scope mirrors the history fix: group chats only. DM delivery is asserted
 * unchanged (a block already prevents creating a DM and sending in one),
 * and a viewer with no moderation relationships must receive everything.
 *
 * The only stub is the `server-only` marker package; the database, the
 * Redis stream, the broadcaster, the token signer, and the SSE route all
 * run for real (REDIS_URL must point at a disposable Redis).
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

process.env.REALTIME_SIGNING_SECRET ??= 'sse-chat-moderation-test-secret';

import {
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  userBlocks,
  userMutes,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { NextRequest } from 'next/server';

let broadcastChatMessage: typeof import('@feed/api').broadcastChatMessage;
let issueRealtimeToken: typeof import('@feed/api').issueRealtimeToken;
let GET: typeof import('../../../apps/web/src/app/api/sse/events/route').GET;

let viewerId: string;
let otherViewerId: string;
let blockedAuthorId: string;
let mutedAuthorId: string;
let blockedByAuthorId: string;
let normalAuthorId: string;
let groupId: string;
let groupChatId: string;
let dmChatId: string;

const allUserIds: string[] = [];

type ReceivedMessage = {
  content: string;
  senderId: string;
  replyToSenderId: string | null;
  hasReplyQuote: boolean;
};

type Connection = {
  controller: AbortController;
  messages: ReceivedMessage[];
  sawConnected: boolean;
  stop: () => Promise<void>;
};

async function connect(
  userId: string,
  channelList: string[]
): Promise<Connection> {
  const token = issueRealtimeToken({ userId, channels: channelList });
  const controller = new AbortController();
  // Resume every channel from the start of its stream (the reconnection
  // path the web client's SSEManager uses with its stored cursors). With
  // id-based cursors the read path is deterministic; the no-cursor '$'
  // path has its own delivery gap, recorded separately in the lane report.
  const cursor = JSON.stringify(
    Object.fromEntries(channelList.map((ch) => [ch, '0-0']))
  );
  const url =
    `http://localhost/api/sse/events?token=${encodeURIComponent(token)}` +
    `&channels=${encodeURIComponent(channelList.join(','))}` +
    `&cursor=${encodeURIComponent(cursor)}`;
  const request = new NextRequest(url, { signal: controller.signal });
  const response = await GET(request);
  if (response.status !== 200 || !response.body) {
    throw new Error(`SSE connect failed with status ${response.status}`);
  }
  const conn: Connection = {
    controller,
    messages: [],
    sawConnected: false,
    stop: async () => {},
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame
            .split('\n')
            .find((line) => line.startsWith('data: '));
          if (dataLine) {
            try {
              const payload = JSON.parse(dataLine.slice(6)) as {
                type?: string;
                data?: {
                  message?: {
                    content?: string;
                    senderId?: string;
                    replyToMessage?: { senderId?: string } | null;
                  };
                };
              };
              if (payload.type === 'new_message' && payload.data?.message) {
                const m = payload.data.message;
                conn.messages.push({
                  content: m.content ?? '',
                  senderId: m.senderId ?? '',
                  replyToSenderId: m.replyToMessage?.senderId ?? null,
                  hasReplyQuote: m.replyToMessage != null,
                });
              }
            } catch {
              // heartbeat comments and the connected frame are not JSON data
              if (dataLine.includes('"channels"')) conn.sawConnected = true;
            }
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted at teardown
    }
  })();
  conn.stop = async () => {
    controller.abort();
    try {
      await reader.cancel();
    } catch {}
    await pump.catch(() => {});
  };
  return conn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  cond: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

let viewerConn: Connection;
let otherConn: Connection;

const BLOCKED_CONTENT = 'live message from the blocked author';
const MUTED_CONTENT = 'live message from the muted author';
const REVERSE_CONTENT = 'live message from the author who blocked the viewer';
const NORMAL_CONTENT = 'live message from a normal author';
const QUOTE_CONTENT = 'a visible reply quoting the blocked author';
const HIDDEN_QUOTE = 'blocked author text that must not be quoted back';
const DM_CONTENT = 'live DM message from the blocked author';

async function broadcast(
  chatId: string,
  senderId: string,
  content: string,
  replyToMessage?: { id: string; content: string; senderId: string }
): Promise<void> {
  await broadcastChatMessage(chatId, {
    id: await generateSnowflakeId(),
    content,
    chatId,
    senderId,
    type: 'user',
    createdAt: new Date().toISOString(),
    replyToMessage: replyToMessage ?? null,
  });
}

beforeAll(async () => {
  // The realtime Redis client skips initialization entirely when
  // NODE_ENV=test (packages/api/src/redis/client.ts). This suite exercises
  // the real delivery path, so flip to development just for the dynamic
  // imports that load the client, with REDIS_URL pointing at a disposable
  // local Redis; afterAll restores the test value.
  process.env.NODE_ENV = 'development';
  ({ broadcastChatMessage, issueRealtimeToken } = await import('@feed/api'));
  ({ GET } = await import('../../../apps/web/src/app/api/sse/events/route'));

  [
    viewerId,
    otherViewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId,
    groupId,
    groupChatId,
    dmChatId,
  ] = await Promise.all(Array.from({ length: 9 }, () => generateSnowflakeId()));
  allUserIds.push(
    viewerId,
    otherViewerId,
    blockedAuthorId,
    mutedAuthorId,
    blockedByAuthorId,
    normalAuthorId
  );

  const now = new Date();
  const seedUser = (id: string, label: string) => ({
    id,
    username: `test-f35-${label}-${id}`,
    displayName: `F35 ${label}`,
    updatedAt: now,
  });
  await db
    .insert(users)
    .values([
      seedUser(viewerId, 'viewer'),
      seedUser(otherViewerId, 'other-viewer'),
      seedUser(blockedAuthorId, 'blocked'),
      seedUser(mutedAuthorId, 'muted'),
      seedUser(blockedByAuthorId, 'blockedby'),
      seedUser(normalAuthorId, 'normal'),
    ]);

  await db.insert(groups).values({
    id: groupId,
    name: 'F35 Group',
    type: 'user',
    ownerId: viewerId,
    createdById: viewerId,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(chats).values([
    {
      id: groupChatId,
      name: 'F35 Group',
      isGroup: true,
      groupId,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: dmChatId,
      name: null,
      isGroup: false,
      groupId: null,
      createdAt: now,
      updatedAt: now,
    },
  ]);
  const memberIds = await Promise.all(
    allUserIds.map(() => generateSnowflakeId())
  );
  await db.insert(groupMembers).values(
    allUserIds.map((userId, i) => ({
      id: memberIds[i]!,
      groupId,
      userId,
      role: userId === viewerId ? 'owner' : 'member',
      isActive: true,
      joinedAt: now,
    }))
  );
  const participantIds = await Promise.all(
    Array.from({ length: allUserIds.length + 2 }, () => generateSnowflakeId())
  );
  const participantRows = [
    ...allUserIds.map((userId, i) => ({
      id: participantIds[i]!,
      chatId: groupChatId,
      userId,
      isActive: true,
      joinedAt: now,
    })),
    {
      id: participantIds[allUserIds.length]!,
      chatId: dmChatId,
      userId: viewerId,
      isActive: true,
      joinedAt: now,
    },
    {
      id: participantIds[allUserIds.length + 1]!,
      chatId: dmChatId,
      userId: blockedAuthorId,
      isActive: true,
      joinedAt: now,
    },
  ];
  await db.insert(chatParticipants).values(participantRows);

  const relIds = await Promise.all(
    Array.from({ length: 3 }, () => generateSnowflakeId())
  );
  await db.insert(userBlocks).values([
    { id: relIds[0]!, blockerId: viewerId, blockedId: blockedAuthorId },
    { id: relIds[1]!, blockerId: blockedByAuthorId, blockedId: viewerId },
  ]);
  await db
    .insert(userMutes)
    .values([{ id: relIds[2]!, muterId: viewerId, mutedId: mutedAuthorId }]);

  // Connect both viewers before anything is broadcast.
  viewerConn = await connect(viewerId, [
    `chat:${groupChatId}`,
    `chat:${dmChatId}`,
  ]);
  otherConn = await connect(otherViewerId, [`chat:${groupChatId}`]);
  // Let both SSE loops settle into their blocking reads.
  await sleep(1500);

  const hiddenMsgId = await generateSnowflakeId();
  await broadcast(groupChatId, blockedAuthorId, BLOCKED_CONTENT);
  await broadcast(groupChatId, mutedAuthorId, MUTED_CONTENT);
  await broadcast(groupChatId, blockedByAuthorId, REVERSE_CONTENT);
  await broadcast(groupChatId, normalAuthorId, QUOTE_CONTENT, {
    id: hiddenMsgId,
    content: HIDDEN_QUOTE,
    senderId: blockedAuthorId,
  });
  await broadcast(groupChatId, normalAuthorId, NORMAL_CONTENT);
  await broadcast(dmChatId, blockedAuthorId, DM_CONTENT);

  // Wait until the unfiltered viewer has seen the last group message and
  // the moderated viewer has had the same window, then drain briefly.
  await waitFor(
    () =>
      otherConn.messages.some((m) => m.content === NORMAL_CONTENT) &&
      viewerConn.messages.some((m) => m.content === NORMAL_CONTENT),
    15000
  );
  await sleep(1500);
});

afterAll(async () => {
  process.env.NODE_ENV = 'test';
  await viewerConn?.stop().catch(() => {});
  await otherConn?.stop().catch(() => {});
  await db
    .delete(chatParticipants)
    .where(inArray(chatParticipants.chatId, [groupChatId, dmChatId]));
  await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
  await db.delete(userBlocks).where(inArray(userBlocks.blockerId, allUserIds));
  await db.delete(userMutes).where(inArray(userMutes.muterId, allUserIds));
  await db.delete(chats).where(inArray(chats.id, [groupChatId, dmChatId]));
  await db.delete(groups).where(eq(groups.id, groupId));
  await db.delete(users).where(inArray(users.id, allUserIds));
});

describe('SSE live chat delivery and viewer moderation', () => {
  it('does not deliver group messages from authors the viewer blocked, muted, or was blocked by', () => {
    const contents = viewerConn.messages.map((m) => m.content);
    expect(contents).not.toContain(BLOCKED_CONTENT);
    expect(contents).not.toContain(MUTED_CONTENT);
    expect(contents).not.toContain(REVERSE_CONTENT);
  });

  it('still delivers group messages from authors with no moderation relation', () => {
    const contents = viewerConn.messages.map((m) => m.content);
    expect(contents).toContain(NORMAL_CONTENT);
  });

  it('does not quote a hidden author back through a visible reply', () => {
    const reply = viewerConn.messages.find((m) => m.content === QUOTE_CONTENT);
    expect(reply).toBeDefined();
    expect(reply?.hasReplyQuote).toBe(false);
  });

  it('delivers everything to a viewer with no moderation relationships', () => {
    const contents = otherConn.messages.map((m) => m.content);
    expect(contents).toContain(BLOCKED_CONTENT);
    expect(contents).toContain(MUTED_CONTENT);
    expect(contents).toContain(REVERSE_CONTENT);
    expect(contents).toContain(NORMAL_CONTENT);
    const reply = otherConn.messages.find((m) => m.content === QUOTE_CONTENT);
    expect(reply?.hasReplyQuote).toBe(true);
    expect(reply?.replyToSenderId).toBe(blockedAuthorId);
  });

  it('leaves DM delivery unchanged', () => {
    const contents = viewerConn.messages.map((m) => m.content);
    expect(contents).toContain(DM_CONTENT);
  });
});
