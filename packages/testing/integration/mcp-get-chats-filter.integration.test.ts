/**
 * MCP get_chats must honor its published `filter` argument — proven at
 * the real client boundary, POST /api/mcp.
 *
 * The MCP server advertises get_chats with an input schema declaring
 * `filter: 'all' | 'dms' | 'groups'` ("Filter by chat type", PRD §8/§12;
 * MVP Phase 3 keeps DMs and group chats as live agent surfaces), the
 * args type and zod validation carry the value to the executor, and
 * every result row already carries `type: 'dm' | 'group'`. The original
 * suite called executeGetChats with a constructed agent, so it never
 * exercised the /api/mcp boundary, argument validation, or caller
 * authentication. This suite drives the real route over HTTP with
 * per-user API keys, and keeps the direct executor cases below it.
 *
 * HTTP protocol test identities: the two callers in this suite are
 * distinguished only by the clientInfo labels of their initialize
 * handshakes and by the API key each presents — the "viewer" identity
 * and the "peer" identity, each bound to its own account. These labels
 * are not recorded agent clients/providers/models under CONTRIBUTING
 * §10. Transport: Bun fetch against a running server (TEST_API_URL,
 * default http://127.0.0.1:3100), the same boundary the CI production
 * server exposes.
 *
 * Caller authentication at this boundary has two layers, and the
 * negative cases accept the rejection either layer produces: the
 * route rejects a missing or unknown key with HTTP 401 when its
 * localhost bypass is off (the CI production server), and with the
 * bypass on (a local dev server) the MCP handler itself rejects the
 * call with JSON-RPC error -32001 before any tool runs. In both modes
 * the call is rejected and no chat data is returned.
 *
 * Fixture ownership: every ID is unique to the run (snowflake-derived
 * or taken from one), the owned arrays start empty, and an ID is
 * registered only from the RETURNING clause of the insert that
 * created it. A setup collision therefore registers nothing, and
 * teardown can only ever delete rows this file created — the
 * collision suite at the bottom proves a pre-existing row survives
 * both a failed setup and the cleanup. This file never calls
 * closeDatabase(): that helper closes the shared process's primary
 * and replica clients, which belong to the whole test process; the
 * preload disconnects the shared client when the run drains.
 *
 * Database guard: the suite runs only against the repository's strict
 * disposable target — an intentional loopback database or the explicit
 * GitHub Actions postgres@localhost:5432/test_db target, with an
 * identical DIRECT URL and no replica — and the connected server must
 * confirm the same database name, so fixtures and teardown can never
 * land in an unintended database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  gameOnboarding,
  groupMembers,
  groups,
  inArray,
  notInArray,
  userApiKeys,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { z } from 'zod';
import { generateApiKey, hashApiKey } from '../../api/src/utils/api-keys';
import { executeGetChats } from '../../mcp/src/handlers/tool-handlers';
import type { AuthenticatedAgent } from '../../mcp/src/types/mcp';

// Clients are lazy. Refuse unintended destinations before the first query.
// This is the repository's strict guard, shared with the other HTTP
// boundary suites: it accepts only an intentional loopback disposable
// target or the explicit GitHub Actions postgres@localhost:5432/test_db
// target, requires the DIRECT URL to name the identical target, and
// refuses any read replica.
if (process.env.DATABASE_READ_REPLICA_URL?.trim())
  throw new Error('MCP get_chats fixture refuses a read replica');
function databaseTarget(value: string | undefined): string {
  if (!value) throw new Error('Explicit fixture database URL required');
  const url = new URL(value);
  const port = url.port || '5432';
  const name = decodeURIComponent(url.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !(
      (port === '55685' &&
        /^feed_pr\d+$/.test(name) &&
        url.username === 'symbiex') ||
      (port === '5432' && name === 'test_db' && process.env.CI === 'true')
    )
  )
    throw new Error('Disposable loopback fixture database required');
  return `${port}/${name}/${url.username}`;
}
const primary = databaseTarget(process.env.DATABASE_URL);
if (
  process.env.DIRECT_DATABASE_URL &&
  databaseTarget(process.env.DIRECT_DATABASE_URL) !== primary
)
  throw new Error('MCP get_chats fixture primary/direct targets differ');
const baseUrl =
  process.env.TEST_API_URL ||
  process.env.TEST_BASE_URL ||
  'http://127.0.0.1:3100';
const endpoint = new URL(baseUrl);
if (
  endpoint.protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== '/' ||
  endpoint.search ||
  endpoint.hash
)
  throw new Error('Disposable loopback HTTP server required');

const HTTP_CLIENT_IDENTITIES = {
  viewer: { name: 'get-chats-boundary-viewer', version: '1' },
  peer: { name: 'get-chats-boundary-peer', version: '1' },
} as const;

type Owned = {
  users: string[];
  chats: string[];
  groups: string[];
  keys: string[];
};

const owned: Owned = { users: [], chats: [], groups: [], keys: [] };

let viewerId = '';
let peerId = '';
let thirdId = '';
let viewerApiKey = '';
let peerApiKey = '';
let dmA = '';
let dmB = '';
let groupBacked = '';
let directGroup = '';
let leftChat = '';
let foreignChat = '';
let viewerOnlyChat = '';
let peerOnlyGroup = '';

const viewerAll = () => [dmA, dmB, groupBacked, directGroup, viewerOnlyChat];
const viewerDms = () => [dmA, dmB, viewerOnlyChat];
const viewerGroups = () => [groupBacked, directGroup];
const peerAll = () => [
  dmA,
  dmB,
  groupBacked,
  directGroup,
  leftChat,
  foreignChat,
  peerOnlyGroup,
];
const peerDms = () => [dmA, dmB, leftChat, foreignChat];
const peerGroups = () => [groupBacked, directGroup, peerOnlyGroup];

async function assertConnectedDatabase(): Promise<void> {
  const name = primary.split('/')[1];
  const rows = z
    .array(z.object({ current_database: z.string() }))
    .parse(await db.$queryRaw`SELECT current_database() AS current_database`);
  assert.equal(
    rows[0]?.current_database,
    name,
    'connected database does not match the intended test target'
  );
}

async function insertOwnedUserInto(
  target: Owned,
  label: string
): Promise<string> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(users)
    .values({
      id,
      username: `f135-${label}-${id.slice(-6)}`,
      isTest: false,
      isActor: false,
      updatedAt: new Date(),
    })
    .returning({ id: users.id });
  const row = inserted[0];
  assert.ok(row, 'user insert returned no row');
  target.users.push(row.id);
  return row.id;
}

async function insertOwnedChatInto(
  target: Owned,
  values: { isGroup: boolean; groupId: string | null }
): Promise<string> {
  const id = await generateSnowflakeId();
  const inserted = await db
    .insert(chats)
    .values({
      id,
      name: `f135 chat ${id.slice(-6)}`,
      isGroup: values.isGroup,
      groupId: values.groupId,
      updatedAt: new Date(),
    })
    .returning({ id: chats.id });
  const row = inserted[0];
  assert.ok(row, 'chat insert returned no row');
  target.chats.push(row.id);
  return row.id;
}

async function addParticipant(
  chatId: string,
  userId: string,
  isActive = true
): Promise<void> {
  await db.insert(chatParticipants).values({
    id: await generateSnowflakeId(),
    chatId,
    userId,
    isActive,
  });
}

async function createChat(
  target: Owned,
  values: { isGroup: boolean; groupId: string | null },
  members: Array<{ userId: string; isActive?: boolean }>
): Promise<string> {
  const chatId = await insertOwnedChatInto(target, values);
  for (const member of members) {
    await addParticipant(chatId, member.userId, member.isActive ?? true);
  }
  return chatId;
}

async function insertOwnedApiKey(
  target: Owned,
  userId: string
): Promise<string> {
  const raw = generateApiKey();
  const inserted = await db
    .insert(userApiKeys)
    .values({
      id: await generateSnowflakeId(),
      userId,
      keyHash: hashApiKey(raw),
      name: 'f135 get_chats boundary evidence',
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: userApiKeys.id });
  const row = inserted[0];
  assert.ok(row, 'api key insert returned no row');
  target.keys.push(row.id);
  return raw;
}

/**
 * Delete only rows this fixture acquired, by ID — and refuse before
 * deleting anything when a row this fixture does not own still
 * references an owned parent. The checks and the deletes run in one
 * transaction, so the refusal decision cannot drift apart from the
 * deletion. Two gaps the old cleanup had:
 *
 * - Parent-ID ownership does not own every participant/member now
 *   referencing that parent: a chatParticipant or groupMember row for
 *   an owned chat/group can belong to a foreign user. Only rows whose
 *   user is also owned are deleted; any other row refuses cleanup.
 * - Deleting an owned user silently destroys or blanks another
 *   owner's data through the five destructive User FK references:
 *   three ON DELETE CASCADE (GameOnboarding, UserPnLSnapshot,
 *   Whitelist) and two ON DELETE SET NULL (Whitelist.grantedBy,
 *   WhitelistConfig.updatedBy). Any such row refuses cleanup.
 */
async function cleanupOwned(target: Owned): Promise<void> {
  await db.transaction(async (tx) => {
    if (target.chats.length > 0) {
      const foreignParticipants = await tx
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(
          target.users.length > 0
            ? and(
                inArray(chatParticipants.chatId, target.chats),
                notInArray(chatParticipants.userId, target.users)
              )
            : inArray(chatParticipants.chatId, target.chats)
        )
        .limit(1);
      if (foreignParticipants.length > 0)
        throw new Error(
          'cleanup refused: a participant this fixture does not own still references an owned chat'
        );
    }
    if (target.groups.length > 0) {
      const foreignMembers = await tx
        .select({ id: groupMembers.id })
        .from(groupMembers)
        .where(
          target.users.length > 0
            ? and(
                inArray(groupMembers.groupId, target.groups),
                notInArray(groupMembers.userId, target.users)
              )
            : inArray(groupMembers.groupId, target.groups)
        )
        .limit(1);
      if (foreignMembers.length > 0)
        throw new Error(
          'cleanup refused: a member this fixture does not own still references an owned group'
        );
    }
    if (target.users.length > 0) {
      const [onboarding, snapshots, whitelistRows, grantedRows, configRows] =
        await Promise.all([
          tx
            .select({ id: gameOnboarding.id })
            .from(gameOnboarding)
            .where(inArray(gameOnboarding.userId, target.users))
            .limit(1),
          tx
            .select({ id: userPnLSnapshots.id })
            .from(userPnLSnapshots)
            .where(inArray(userPnLSnapshots.userId, target.users))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.userId, target.users))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.grantedBy, target.users))
            .limit(1),
          tx
            .select({ id: whitelistConfig.id })
            .from(whitelistConfig)
            .where(inArray(whitelistConfig.updatedBy, target.users))
            .limit(1),
        ]);
      if (
        onboarding.length > 0 ||
        snapshots.length > 0 ||
        whitelistRows.length > 0 ||
        grantedRows.length > 0 ||
        configRows.length > 0
      )
        throw new Error(
          'cleanup refused: a row this fixture does not own still references an owned user'
        );
    }

    if (target.keys.length > 0) {
      await tx.delete(userApiKeys).where(inArray(userApiKeys.id, target.keys));
    }
    if (target.chats.length > 0) {
      if (target.users.length > 0) {
        await tx
          .delete(chatParticipants)
          .where(
            and(
              inArray(chatParticipants.chatId, target.chats),
              inArray(chatParticipants.userId, target.users)
            )
          );
      }
      await tx.delete(chats).where(inArray(chats.id, target.chats));
    }
    if (target.groups.length > 0) {
      if (target.users.length > 0) {
        await tx
          .delete(groupMembers)
          .where(
            and(
              inArray(groupMembers.groupId, target.groups),
              inArray(groupMembers.userId, target.users)
            )
          );
      }
      await tx.delete(groups).where(inArray(groups.id, target.groups));
    }
    if (target.users.length > 0) {
      await tx.delete(users).where(inArray(users.id, target.users));
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP boundary helpers
// ---------------------------------------------------------------------------

async function rpc(
  method: string,
  params: Record<string, unknown>,
  apiKey?: string
): Promise<{ status: number; body: unknown; requestId: string }> {
  const requestId = randomUUID();
  const response = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'X-Feed-Api-Key': apiKey } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json();
  return { status: response.status, body, requestId };
}

const toolSuccessSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.string(),
  result: z.object({
    isError: z.literal(false),
    content: z
      .array(z.object({ type: z.literal('text'), text: z.string() }))
      .length(1),
  }),
});

const chatListPayloadSchema = z.object({
  chats: z.array(z.object({ id: z.string(), type: z.string() })),
});

async function getChatsViaHttp(
  apiKey: string,
  args: Record<string, unknown>
): Promise<Array<{ id: string; type: string }>> {
  const { status, body, requestId } = await rpc(
    'tools/call',
    { name: 'get_chats', arguments: args },
    apiKey
  );
  expect(status).toBe(200);
  const parsed = toolSuccessSchema.parse(body);
  expect(parsed.id).toBe(requestId);
  const text = parsed.result.content[0]?.text;
  assert.ok(text, 'tool call returned no text content');
  return chatListPayloadSchema.parse(JSON.parse(text)).chats;
}

async function sortedIdsViaHttp(
  apiKey: string,
  args: Record<string, unknown>
): Promise<string[]> {
  const chats = await getChatsViaHttp(apiKey, args);
  return chats.map((c) => c.id).sort();
}

function expectAuthRejected(status: number, body: unknown): void {
  if (status === 401) {
    // Route layer rejected the key before the handler ran.
    return;
  }
  // Localhost-bypass mode: the MCP handler itself must have rejected
  // the call with the authentication error, and no result is present.
  expect(status).toBe(200);
  const parsed = z
    .object({ error: z.object({ code: z.literal(-32001) }) })
    .parse(body);
  expect(parsed.error.code).toBe(-32001);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await assertConnectedDatabase();

  viewerId = await insertOwnedUserInto(owned, 'viewer');
  peerId = await insertOwnedUserInto(owned, 'peer');
  thirdId = await insertOwnedUserInto(owned, 'third');
  viewerApiKey = await insertOwnedApiKey(owned, viewerId);
  peerApiKey = await insertOwnedApiKey(owned, peerId);

  dmA = await createChat(owned, { isGroup: false, groupId: null }, [
    { userId: viewerId },
    { userId: peerId },
  ]);
  dmB = await createChat(owned, { isGroup: false, groupId: null }, [
    { userId: viewerId },
    { userId: peerId },
  ]);

  // Group-backed group chat: Group row + groupMembers + chats.groupId.
  const groupId = await generateSnowflakeId();
  const insertedGroup = await db
    .insert(groups)
    .values({
      id: groupId,
      name: 'f135 group',
      type: 'user',
      ownerId: viewerId,
      createdById: viewerId,
      updatedAt: new Date(),
    })
    .returning({ id: groups.id });
  const groupRow = insertedGroup[0];
  assert.ok(groupRow, 'group insert returned no row');
  owned.groups.push(groupRow.id);
  for (const userId of [viewerId, peerId]) {
    await db.insert(groupMembers).values({
      id: await generateSnowflakeId(),
      groupId: groupRow.id,
      userId,
      role: userId === viewerId ? 'admin' : 'member',
    });
  }
  groupBacked = await createChat(
    owned,
    { isGroup: true, groupId: groupRow.id },
    [{ userId: viewerId }, { userId: peerId }]
  );

  // Direct group chat: isGroup with groupId null, chatParticipants only
  // (the shape POST /api/chats with isGroup=true creates).
  directGroup = await createChat(owned, { isGroup: true, groupId: null }, [
    { userId: viewerId },
    { userId: peerId },
  ]);

  // Controls and isolation fixtures.
  leftChat = await createChat(owned, { isGroup: false, groupId: null }, [
    { userId: viewerId, isActive: false },
    { userId: peerId },
  ]);
  foreignChat = await createChat(owned, { isGroup: false, groupId: null }, [
    { userId: peerId },
  ]);
  viewerOnlyChat = await createChat(owned, { isGroup: false, groupId: null }, [
    { userId: viewerId },
    { userId: thirdId },
  ]);
  peerOnlyGroup = await createChat(owned, { isGroup: true, groupId: null }, [
    { userId: peerId },
    { userId: thirdId },
  ]);
});

afterAll(async () => {
  await cleanupOwned(owned);
});

// ---------------------------------------------------------------------------
// Direct executor semantics (kept from the original suite)
// ---------------------------------------------------------------------------

describe('MCP get_chats filter — direct executor', () => {
  async function idsFor(filter?: 'all' | 'dms' | 'groups'): Promise<string[]> {
    const agent: AuthenticatedAgent = { agentId: viewerId, userId: viewerId };
    const result = await executeGetChats(
      agent,
      filter === undefined ? {} : { filter }
    );
    return result.chats.map((c) => c.id);
  }

  it('filter=all (and no filter) lists every reachable chat exactly once', async () => {
    const expected = viewerAll().sort();
    for (const filter of [undefined, 'all'] as const) {
      const ids = await idsFor(filter);
      expect([...ids].sort()).toEqual(expected);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).not.toContain(leftChat);
      expect(ids).not.toContain(foreignChat);
      expect(ids).not.toContain(peerOnlyGroup);
    }
  });

  it('filter=dms returns only DM chats', async () => {
    const agent: AuthenticatedAgent = { agentId: viewerId, userId: viewerId };
    const result = await executeGetChats(agent, { filter: 'dms' });
    expect(result.chats.map((c) => c.id).sort()).toEqual(viewerDms().sort());
    expect(result.chats.every((c) => c.type === 'dm')).toBe(true);
  });

  it('filter=groups returns only group chats', async () => {
    const agent: AuthenticatedAgent = { agentId: viewerId, userId: viewerId };
    const result = await executeGetChats(agent, { filter: 'groups' });
    expect(result.chats.map((c) => c.id).sort()).toEqual(viewerGroups().sort());
    expect(result.chats.every((c) => c.type === 'group')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real /api/mcp boundary
// ---------------------------------------------------------------------------

describe('MCP get_chats filter — /api/mcp boundary', () => {
  it('records both HTTP client identities: initialize answers and tools/list advertises the filter', async () => {
    for (const [client, apiKey] of [
      [HTTP_CLIENT_IDENTITIES.viewer, viewerApiKey],
      [HTTP_CLIENT_IDENTITIES.peer, peerApiKey],
    ] as const) {
      const { status, body, requestId } = await rpc(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: client,
        },
        apiKey
      );
      expect(status).toBe(200);
      const parsed = z
        .object({
          id: z.string(),
          result: z.object({ protocolVersion: z.string() }),
        })
        .parse(body);
      expect(parsed.id).toBe(requestId);
      expect(parsed.result.protocolVersion).toBeTruthy();
    }

    const { status, body } = await rpc('tools/list', {}, viewerApiKey);
    expect(status).toBe(200);
    const listing = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              inputSchema: z
                .object({
                  properties: z
                    .object({
                      filter: z
                        .object({ enum: z.array(z.string()).optional() })
                        .optional(),
                    })
                    .optional(),
                })
                .optional(),
            })
          ),
        }),
      })
      .parse(body);
    const getChats = listing.result.tools.find((t) => t.name === 'get_chats');
    assert.ok(getChats, 'get_chats missing from tools/list');
    expect(getChats.inputSchema?.properties?.filter?.enum).toEqual([
      'all',
      'dms',
      'groups',
    ]);
  });

  it('omitted filter returns exactly the caller’s reachable chats', async () => {
    expect(await sortedIdsViaHttp(viewerApiKey, {})).toEqual(
      viewerAll().sort()
    );
  });

  it('filter=all returns exactly the caller’s reachable chats', async () => {
    expect(await sortedIdsViaHttp(viewerApiKey, { filter: 'all' })).toEqual(
      viewerAll().sort()
    );
  });

  it('filter=dms returns only the caller’s DM chats', async () => {
    const chats = await getChatsViaHttp(viewerApiKey, { filter: 'dms' });
    expect(chats.map((c) => c.id).sort()).toEqual(viewerDms().sort());
    expect(chats.every((c) => c.type === 'dm')).toBe(true);
  });

  it('filter=groups returns only the caller’s group chats', async () => {
    const chats = await getChatsViaHttp(viewerApiKey, { filter: 'groups' });
    expect(chats.map((c) => c.id).sort()).toEqual(viewerGroups().sort());
    expect(chats.every((c) => c.type === 'group')).toBe(true);
  });

  it('an invalid filter is rejected by argument validation at the boundary', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'get_chats', arguments: { filter: 'dm' } },
      viewerApiKey
    );
    expect(status).toBe(200);
    const parsed = z
      .object({
        result: z.object({
          isError: z.literal(true),
          content: z.array(z.object({ text: z.string() })),
        }),
      })
      .parse(body);
    expect(parsed.result.content[0]?.text).toContain('Tool execution failed');
  });

  it('an unknown API key is rejected before any tool runs', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'get_chats', arguments: {} },
      'feed_unknown_key_for_f135_boundary_negative'
    );
    expectAuthRejected(status, body);
  });

  it('a missing API key is rejected before any tool runs', async () => {
    const { status, body } = await rpc('tools/call', {
      name: 'get_chats',
      arguments: {},
    });
    expectAuthRejected(status, body);
  });

  it('caller isolation: the peer sees its own chats, never the viewer-only chat', async () => {
    expect(await sortedIdsViaHttp(peerApiKey, {})).toEqual(peerAll().sort());
    const dms = await getChatsViaHttp(peerApiKey, { filter: 'dms' });
    expect(dms.map((c) => c.id).sort()).toEqual(peerDms().sort());
    const groups = await getChatsViaHttp(peerApiKey, { filter: 'groups' });
    expect(groups.map((c) => c.id).sort()).toEqual(peerGroups().sort());
    expect(peerAll()).not.toContain(viewerOnlyChat);
  });

  it('inactive and foreign chats never reach the caller, while an active member still sees the left chat', async () => {
    const viewerChats = await getChatsViaHttp(viewerApiKey, {});
    const viewerIds = viewerChats.map((c) => c.id);
    // The viewer left leftChat (inactive participant row) and is not a
    // member of foreignChat or peerOnlyGroup at all.
    expect(viewerIds).not.toContain(leftChat);
    expect(viewerIds).not.toContain(foreignChat);
    expect(viewerIds).not.toContain(peerOnlyGroup);
    // The peer is still an active member of leftChat, so the same chat
    // is visible to the peer: the hiding follows the caller's own
    // membership state, not the chat.
    const peerChats = await getChatsViaHttp(peerApiKey, {});
    expect(peerChats.map((c) => c.id)).toContain(leftChat);
  });
});

// ---------------------------------------------------------------------------
// Fixture ownership under setup collision
// ---------------------------------------------------------------------------

describe('MCP get_chats fixture ownership under setup collision', () => {
  // Rows that simulate another owner's data. They stay out of every
  // owned array the fixture helpers manage; this suite removes them
  // itself at the end.
  const foreign = { userId: '', chatId: '' };

  beforeAll(async () => {
    foreign.userId = await generateSnowflakeId();
    await db.insert(users).values({
      id: foreign.userId,
      username: 'f135-foreign-user',
      isTest: false,
      isActor: false,
      updatedAt: new Date(),
    });
    foreign.chatId = await generateSnowflakeId();
    await db.insert(chats).values({
      id: foreign.chatId,
      name: 'f135 foreign chat',
      isGroup: false,
      groupId: null,
      updatedAt: new Date(),
    });
    await db.insert(chatParticipants).values({
      id: await generateSnowflakeId(),
      chatId: foreign.chatId,
      userId: foreign.userId,
      isActive: true,
    });
  });

  afterAll(async () => {
    await db
      .delete(chatParticipants)
      .where(eq(chatParticipants.chatId, foreign.chatId));
    await db.delete(chats).where(eq(chats.id, foreign.chatId));
    await db.delete(users).where(eq(users.id, foreign.userId));
  });

  it('a colliding setup registers nothing and cleanup preserves pre-existing rows', async () => {
    const localOwned: Owned = { users: [], chats: [], groups: [], keys: [] };

    // A setup insert that collides with the pre-existing user fails,
    // and because ownership is registered only from RETURNING, the
    // failed insert leaves localOwned empty.
    let collisionFailed = false;
    try {
      const inserted = await db
        .insert(users)
        .values({
          id: foreign.userId,
          username: 'f135-collision-attempt',
          isTest: false,
          isActor: false,
          updatedAt: new Date(),
        })
        .returning({ id: users.id });
      const row = inserted[0];
      if (row) localOwned.users.push(row.id);
    } catch {
      collisionFailed = true;
    }
    expect(collisionFailed).toBe(true);
    expect(localOwned.users).toEqual([]);

    // A partial setup: one later insert succeeds and is registered.
    const partialChatId = await insertOwnedChatInto(localOwned, {
      isGroup: false,
      groupId: null,
    });
    expect(localOwned.chats).toEqual([partialChatId]);

    await cleanupOwned(localOwned);

    // The row the partial setup actually created is gone...
    const partialRows = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, partialChatId));
    expect(partialRows).toEqual([]);

    // ...and the pre-existing rows were never touched.
    const foreignUser = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, foreign.userId));
    expect(foreignUser).toEqual([
      { id: foreign.userId, username: 'f135-foreign-user' },
    ]);
    const foreignChatRows = await db
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.id, foreign.chatId));
    expect(foreignChatRows).toEqual([{ id: foreign.chatId }]);
    const foreignParticipants = await db
      .select({ id: chatParticipants.id })
      .from(chatParticipants)
      .where(eq(chatParticipants.chatId, foreign.chatId));
    expect(foreignParticipants).toHaveLength(1);
  });

  it('cleanup refuses foreign participants and foreign user references, preserving every row', async () => {
    const localOwned: Owned = { users: [], chats: [], groups: [], keys: [] };
    const foreignParticipantUserId = await generateSnowflakeId();
    const foreignParticipantRowId = await generateSnowflakeId();
    const onboardingRowId = await generateSnowflakeId();
    try {
      const guardUserId = await insertOwnedUserInto(localOwned, 'guard');
      const guardChatId = await createChat(
        localOwned,
        { isGroup: false, groupId: null },
        [{ userId: guardUserId }]
      );

      // A participant this fixture does not own, on the owned chat...
      await db.insert(users).values({
        id: foreignParticipantUserId,
        username: 'f135-guard-foreign-participant',
        isTest: false,
        isActor: false,
        updatedAt: new Date(),
      });
      await db.insert(chatParticipants).values({
        id: foreignParticipantRowId,
        chatId: guardChatId,
        userId: foreignParticipantUserId,
        isActive: true,
      });
      // ...and a GameOnboarding row for the owned user, which deleting
      // the user would silently cascade away.
      await db.insert(gameOnboarding).values({
        id: onboardingRowId,
        userId: guardUserId,
      });

      await expect(cleanupOwned(localOwned)).rejects.toThrow(/cleanup refused/);

      // The refusal rolls the whole transaction back: nothing was deleted.
      const survivingParticipant = await db
        .select({ id: chatParticipants.id })
        .from(chatParticipants)
        .where(eq(chatParticipants.id, foreignParticipantRowId));
      expect(survivingParticipant).toEqual([{ id: foreignParticipantRowId }]);
      const survivingOnboarding = await db
        .select({ id: gameOnboarding.id })
        .from(gameOnboarding)
        .where(eq(gameOnboarding.id, onboardingRowId));
      expect(survivingOnboarding).toEqual([{ id: onboardingRowId }]);
      const survivingChat = await db
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, guardChatId));
      expect(survivingChat).toEqual([{ id: guardChatId }]);
      const survivingUser = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, guardUserId));
      expect(survivingUser).toEqual([{ id: guardUserId }]);
    } finally {
      // Remove the foreign rows directly, then cleanup removes only the
      // rows this fixture acquired.
      await db
        .delete(chatParticipants)
        .where(eq(chatParticipants.id, foreignParticipantRowId));
      await db
        .delete(gameOnboarding)
        .where(eq(gameOnboarding.id, onboardingRowId));
      await db.delete(users).where(eq(users.id, foreignParticipantUserId));
      await cleanupOwned(localOwned);
    }
  });
});
