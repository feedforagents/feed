/**
 * GET /api/users/[userId]/posts?type=replies against a real database: the
 * public profile replies list must apply the viewer's own moderation policy
 * to the content it embeds and the counts it reports.
 *
 * Every sibling read surface already does this — the post feeds, the
 * favorites feed, notifications, user search and the post comment list all
 * exclude authors the viewer blocked or muted, and authors who blocked the
 * viewer (see apps/web/src/app/api/feed/_lib/viewer-moderation.ts: "Authors
 * the viewer must not see"). Within this same route, a parent post that
 * cannot be exposed (deleted or future-dated) already renders as
 * post: null while the reply itself stays listed (the #1688 contract), and
 * a deleted parent comment renders as parentComment: null. A parent post or
 * parent comment whose author the viewer must not see is the same kind of
 * non-exposable parent, and child replies by such authors must not be
 * counted (the rule the comment detail route applies to its reply counts).
 * The profile owner's own replies are the target of the page and stay
 * listed; anonymous reads have no moderation set and stay unfiltered.
 * The route handler is exercised unmodified; the viewer is a real Steward
 * JWT principal (publicRateLimit/optionalAuth accept nothing else).
 * Fixture rows are owned only from a committed INSERT ... RETURNING, and
 * cleanup deletes exactly those ids, refusing when a foreign row still
 * references an owned parent.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  and,
  comments,
  db,
  eq,
  gameOnboarding,
  inArray,
  notInArray,
  npcMarketClues,
  or,
  posts,
  sql,
  userBlocks,
  userMutes,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { SignJWT } from 'jose';
import { NextRequest } from 'next/server';

type ReplyItem = {
  id: string;
  content: string;
  replyCount: number;
  post: { id: string; content: string; authorId: string } | null;
  parentComment: { id: string; content: string; authorId: string } | null;
};
type RepliesResponse = {
  type: string;
  total: number;
  items: ReplyItem[];
};

// Run-scoped Steward principal: a fixed steward id would let parallel or
// retained runs fight over the same viewer row.
const RUN_ID = randomUUID().slice(0, 8);
const STEWARD_ID = `f148-steward-viewer-${RUN_ID}`;
const STEWARD_SECRET = 'f148-steward-secret';
process.env.STEWARD_JWT_SECRET =
  process.env.STEWARD_JWT_SECRET || STEWARD_SECRET;

// Destructive fixtures run only against an explicitly owned disposable
// database: loopback host and a test database name.
function ownedDatabaseUrl(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required for integration tests`);
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    (!/^(test_db|feed_pr\d+)$/i.test(databaseName) &&
      !/(?:^|[_-])(test|testing|verification)(?:[_-]|$)/i.test(databaseName))
  ) {
    throw new Error(`${label} must point to a local disposable test database`);
  }
  return databaseName;
}
const DATABASE_NAME = ownedDatabaseUrl(
  process.env.DATABASE_URL,
  'DATABASE_URL'
);
if (process.env.DIRECT_DATABASE_URL) {
  const directName = ownedDatabaseUrl(
    process.env.DIRECT_DATABASE_URL,
    'DIRECT_DATABASE_URL'
  );
  if (directName !== DATABASE_NAME)
    throw new Error(
      'DIRECT_DATABASE_URL must point to the same disposable database'
    );
}

// Ownership is published only from a committed INSERT ... RETURNING: ids
// are recorded after the insert succeeds, never before. Cleanup deletes
// exactly these ids and refuses when a foreign row still references an
// owned parent.
const ownedUsers = new Set<string>();
const ownedPosts = new Set<string>();
const ownedComments = new Set<string>();
const ownedBlocks = new Set<string>();
const ownedMutes = new Set<string>();

async function viewerAuthHeaders(): Promise<Record<string, string>> {
  const token = await new SignJWT({ userId: STEWARD_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('steward')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.STEWARD_JWT_SECRET!));
  return { authorization: `Bearer ${token}` };
}

let owner: string;
let viewer: string;
let normal: string;
let blocked: string;
let muted: string;
let blocker: string;
let postNormal: string;
let postBlocked: string;
let postMuted: string;
let postBlocker: string;
let pcNormal: string;
let pcBlocked: string;
let pcMuted: string;
let pcBlocker: string;
let rPostNormal: string;
let rPostBlocked: string;
let rPostMuted: string;
let rPostBlocker: string;
let rPcNormal: string;
let rPcBlocked: string;
let rPcMuted: string;
let rPcBlocker: string;
let GET: typeof import('../../../apps/web/src/app/api/users/[userId]/posts/route').GET;

async function fetchReplies(headers?: Record<string, string>) {
  const request = new NextRequest(
    `http://localhost/api/users/${owner}/posts?type=replies&limit=100`,
    { headers }
  );
  const response = await GET(request, {
    params: Promise.resolve({ userId: owner }),
  });
  const body = (await response.json().catch(() => null)) as
    | RepliesResponse
    | { error?: unknown }
    | null;
  return { status: response.status, body };
}

function item(body: RepliesResponse | { error?: unknown } | null, id: string) {
  const found = (body as RepliesResponse)?.items?.find((row) => row.id === id);
  if (!found) throw new Error(`reply ${id} missing from response`);
  return found;
}

beforeAll(async () => {
  const [connected] = await db.execute(sql`SELECT current_database() AS name`);
  if (connected?.name !== DATABASE_NAME)
    throw new Error('Connected database does not match DATABASE_URL');

  ({ GET } = await import(
    '../../../apps/web/src/app/api/users/[userId]/posts/route'
  ));

  const ids = await Promise.all(
    Array.from({ length: 22 }, () => generateSnowflakeId())
  );
  const nextId = () => {
    const id = ids.shift();
    if (id === undefined)
      throw new Error('Fixture ID allocation was incomplete');
    return id;
  };
  owner = nextId();
  viewer = nextId();
  normal = nextId();
  blocked = nextId();
  muted = nextId();
  blocker = nextId();
  postNormal = nextId();
  postBlocked = nextId();
  postMuted = nextId();
  postBlocker = nextId();
  pcNormal = nextId();
  pcBlocked = nextId();
  pcMuted = nextId();
  pcBlocker = nextId();
  rPostNormal = nextId();
  rPostBlocked = nextId();
  rPostMuted = nextId();
  rPostBlocker = nextId();
  rPcNormal = nextId();
  rPcBlocked = nextId();
  rPcMuted = nextId();
  rPcBlocker = nextId();

  const now = new Date();
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const earlier = new Date(now.getTime() - 3_600_000);

  const insertedUsers = await db
    .insert(users)
    .values([
      {
        id: owner,
        username: `f148-o-${owner}`,
        displayName: 'F148 Owner',
        updatedAt: now,
      },
      {
        id: viewer,
        username: `f148-v-${viewer}`,
        displayName: 'F148 Viewer',
        updatedAt: now,
      },
      {
        id: normal,
        username: `f148-n-${normal}`,
        displayName: 'F148 Normal',
        updatedAt: now,
      },
      {
        id: blocked,
        username: `f148-b-${blocked}`,
        displayName: 'F148 Blocked',
        updatedAt: now,
      },
      {
        id: muted,
        username: `f148-m-${muted}`,
        displayName: 'F148 Muted',
        updatedAt: now,
      },
      {
        id: blocker,
        username: `f148-r-${blocker}`,
        displayName: 'F148 Blocker',
        updatedAt: now,
      },
    ])
    .returning({ id: users.id });
  for (const row of insertedUsers) ownedUsers.add(row.id);
  await db
    .update(users)
    .set({ stewardId: STEWARD_ID })
    .where(sql`${users.id} = ${viewer}`);

  const insertedPosts = await db
    .insert(posts)
    .values([
      {
        id: postNormal,
        content: 'f148 post by normal author',
        authorId: normal,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: postBlocked,
        content: 'f148 post by blocked author',
        authorId: blocked,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: postMuted,
        content: 'f148 post by muted author',
        authorId: muted,
        timestamp: earlier,
        createdAt: earlier,
      },
      {
        id: postBlocker,
        content: 'f148 post by blocking author',
        authorId: blocker,
        timestamp: earlier,
        createdAt: earlier,
      },
    ])
    .returning({ id: posts.id });
  for (const row of insertedPosts) ownedPosts.add(row.id);

  // Parent comments on the normal post, one per author class.
  const insertedParents = await db
    .insert(comments)
    .values([
      {
        id: pcNormal,
        content: 'f148 parent comment by normal author',
        postId: postNormal,
        authorId: normal,
        parentCommentId: null,
        createdAt: at(-500),
        updatedAt: at(-500),
        deletedAt: null,
      },
      {
        id: pcBlocked,
        content: 'f148 parent comment by blocked author',
        postId: postNormal,
        authorId: blocked,
        parentCommentId: null,
        createdAt: at(-490),
        updatedAt: at(-490),
        deletedAt: null,
      },
      {
        id: pcMuted,
        content: 'f148 parent comment by muted author',
        postId: postNormal,
        authorId: muted,
        parentCommentId: null,
        createdAt: at(-480),
        updatedAt: at(-480),
        deletedAt: null,
      },
      {
        id: pcBlocker,
        content: 'f148 parent comment by blocking author',
        postId: postNormal,
        authorId: blocker,
        parentCommentId: null,
        createdAt: at(-470),
        updatedAt: at(-470),
        deletedAt: null,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedParents) ownedComments.add(row.id);

  // The profile owner's replies: one per parent-post author class, one per
  // parent-comment author class, plus one soft-deleted reply (control).
  const replyRows = [
    {
      id: rPostNormal,
      content: 'f148 reply on normal post',
      postId: postNormal,
      parentCommentId: null as string | null,
      createdAt: at(-100),
      deletedAt: null as Date | null,
    },
    {
      id: rPostBlocked,
      content: 'f148 reply on blocked-author post',
      postId: postBlocked,
      parentCommentId: null,
      createdAt: at(-110),
      deletedAt: null,
    },
    {
      id: rPostMuted,
      content: 'f148 reply on muted-author post',
      postId: postMuted,
      parentCommentId: null,
      createdAt: at(-120),
      deletedAt: null,
    },
    {
      id: rPostBlocker,
      content: 'f148 reply on blocking-author post',
      postId: postBlocker,
      parentCommentId: null,
      createdAt: at(-130),
      deletedAt: null,
    },
    {
      id: rPcNormal,
      content: 'f148 reply under normal parent comment',
      postId: postNormal,
      parentCommentId: pcNormal,
      createdAt: at(-140),
      deletedAt: null,
    },
    {
      id: rPcBlocked,
      content: 'f148 reply under blocked parent comment',
      postId: postNormal,
      parentCommentId: pcBlocked,
      createdAt: at(-150),
      deletedAt: null,
    },
    {
      id: rPcMuted,
      content: 'f148 reply under muted parent comment',
      postId: postNormal,
      parentCommentId: pcMuted,
      createdAt: at(-160),
      deletedAt: null,
    },
    {
      id: rPcBlocker,
      content: 'f148 reply under blocking parent comment',
      postId: postNormal,
      parentCommentId: pcBlocker,
      createdAt: at(-170),
      deletedAt: null,
    },
  ];
  const deletedReplyId = await generateSnowflakeId();
  const insertedReplies = await db
    .insert(comments)
    .values([
      ...replyRows.map((row) => ({
        id: row.id,
        content: row.content,
        postId: row.postId,
        authorId: owner,
        parentCommentId: row.parentCommentId,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
        deletedAt: row.deletedAt,
      })),
      {
        id: deletedReplyId,
        content: 'f148 deleted reply by owner',
        postId: postNormal,
        authorId: owner,
        parentCommentId: null,
        createdAt: at(-180),
        updatedAt: at(-180),
        deletedAt: now,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedReplies) ownedComments.add(row.id);

  // Children of the reply on the normal post: one visible to everyone, one
  // by the blocked author (counted for anonymous, never for the viewer),
  // one soft-deleted (counted for nobody).
  const [childNormal, childBlocked, childDeleted] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const insertedChildren = await db
    .insert(comments)
    .values([
      {
        id: childNormal,
        content: 'f148 child by normal author',
        postId: postNormal,
        authorId: normal,
        parentCommentId: rPostNormal,
        createdAt: at(-90),
        updatedAt: at(-90),
        deletedAt: null,
      },
      {
        id: childBlocked,
        content: 'f148 child by blocked author',
        postId: postNormal,
        authorId: blocked,
        parentCommentId: rPostNormal,
        createdAt: at(-80),
        updatedAt: at(-80),
        deletedAt: null,
      },
      {
        id: childDeleted,
        content: 'f148 deleted child',
        postId: postNormal,
        authorId: normal,
        parentCommentId: rPostNormal,
        createdAt: at(-70),
        updatedAt: at(-70),
        deletedAt: now,
      },
    ])
    .returning({ id: comments.id });
  for (const row of insertedChildren) ownedComments.add(row.id);

  const [blockRowA, blockRowB, muteRow] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ]);
  const insertedBlocks = await db
    .insert(userBlocks)
    .values([
      { id: blockRowA, blockerId: viewer, blockedId: blocked },
      { id: blockRowB, blockerId: blocker, blockedId: viewer },
    ])
    .returning({ id: userBlocks.id });
  for (const row of insertedBlocks) ownedBlocks.add(row.id);
  const insertedMutes = await db
    .insert(userMutes)
    .values([{ id: muteRow, muterId: viewer, mutedId: muted }])
    .returning({ id: userMutes.id });
  for (const row of insertedMutes) ownedMutes.add(row.id);
});

async function cleanupOwned(): Promise<void> {
  if (
    ownedUsers.size === 0 &&
    ownedPosts.size === 0 &&
    ownedComments.size === 0 &&
    ownedBlocks.size === 0 &&
    ownedMutes.size === 0
  )
    return;
  await db.transaction(async (tx) => {
    const userIds = [...ownedUsers];
    const postIds = [...ownedPosts];
    const commentIds = [...ownedComments];
    const blockIds = [...ownedBlocks];
    const muteIds = [...ownedMutes];
    if (userIds.length > 0) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, userIds))
        .for('update');
    }
    const foreign: string[] = [];
    if (postIds.length > 0) {
      await tx
        .select({ id: posts.id })
        .from(posts)
        .where(inArray(posts.id, postIds))
        .for('update');
      // The manual clue migration is present in localnet and may be absent in CI.
      const [clueTable] = await tx.execute<{ present: boolean }>(
        sql`SELECT pg_catalog.to_regclass('public."NpcMarketClue"') IS NOT NULL AS present`
      );
      if (clueTable?.present) {
        const [clue] = await tx
          .select({ questionId: npcMarketClues.questionId })
          .from(npcMarketClues)
          .where(inArray(npcMarketClues.postId, postIds))
          .limit(1);
        if (clue) foreign.push('NpcMarketClue.postId');
      }
    }
    if (userIds.length > 0) {
      // Physical destructive paths: deleting an owned user cascades these
      // rows away (GameOnboarding/UserPnLSnapshot/Whitelist) or nulls the
      // reference (Whitelist.grantedBy, WhitelistConfig.updatedBy) —
      // baseline migration 0000, constraints ..._User_id_fk.
      const [onboarding, snapshots, whitelistRows, grantedRows, configRows] =
        await Promise.all([
          tx
            .select({ id: gameOnboarding.id })
            .from(gameOnboarding)
            .where(inArray(gameOnboarding.userId, userIds))
            .limit(1),
          tx
            .select({ id: userPnLSnapshots.id })
            .from(userPnLSnapshots)
            .where(inArray(userPnLSnapshots.userId, userIds))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.userId, userIds))
            .limit(1),
          tx
            .select({ id: whitelist.id })
            .from(whitelist)
            .where(inArray(whitelist.grantedBy, userIds))
            .limit(1),
          tx
            .select({ id: whitelistConfig.id })
            .from(whitelistConfig)
            .where(inArray(whitelistConfig.updatedBy, userIds))
            .limit(1),
        ]);
      if (onboarding.length > 0) foreign.push('GameOnboarding');
      if (snapshots.length > 0) foreign.push('UserPnLSnapshot');
      if (whitelistRows.length > 0) foreign.push('Whitelist');
      if (grantedRows.length > 0) foreign.push('Whitelist.grantedBy');
      if (configRows.length > 0) foreign.push('WhitelistConfig.updatedBy');
    }
    // Logical foreign children: rows that reference an owned parent or
    // author but were never acquired by this run. Deleting the parent
    // would erase or orphan them, so refuse instead.
    if (postIds.length > 0 || commentIds.length > 0 || userIds.length > 0) {
      const rows = await tx
        .select({ id: comments.id })
        .from(comments)
        .where(
          and(
            or(
              ...(postIds.length > 0
                ? [inArray(comments.postId, postIds)]
                : []),
              ...(commentIds.length > 0
                ? [inArray(comments.parentCommentId, commentIds)]
                : []),
              ...(userIds.length > 0
                ? [inArray(comments.authorId, userIds)]
                : [])
            ),
            ...(commentIds.length > 0
              ? [notInArray(comments.id, commentIds)]
              : [])
          )
        )
        .limit(1);
      if (rows.length > 0) foreign.push('Comment');
    }
    if (userIds.length > 0 || commentIds.length > 0) {
      const rows = await tx
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            or(
              ...(userIds.length > 0 ? [inArray(posts.authorId, userIds)] : []),
              ...(commentIds.length > 0
                ? [inArray(posts.parentCommentId, commentIds)]
                : [])
            ),
            ...(postIds.length > 0 ? [notInArray(posts.id, postIds)] : [])
          )
        )
        .limit(1);
      if (rows.length > 0) foreign.push('Post');
    }
    if (userIds.length > 0) {
      const [foreignBlocks, foreignMutes] = await Promise.all([
        tx
          .select({ id: userBlocks.id })
          .from(userBlocks)
          .where(
            and(
              or(
                inArray(userBlocks.blockerId, userIds),
                inArray(userBlocks.blockedId, userIds)
              ),
              ...(blockIds.length > 0
                ? [notInArray(userBlocks.id, blockIds)]
                : [])
            )
          )
          .limit(1),
        tx
          .select({ id: userMutes.id })
          .from(userMutes)
          .where(
            and(
              or(
                inArray(userMutes.muterId, userIds),
                inArray(userMutes.mutedId, userIds)
              ),
              ...(muteIds.length > 0 ? [notInArray(userMutes.id, muteIds)] : [])
            )
          )
          .limit(1),
      ]);
      if (foreignBlocks.length > 0) foreign.push('UserBlock');
      if (foreignMutes.length > 0) foreign.push('UserMute');
    }
    if (foreign.length > 0)
      throw new Error(
        `cleanup refused: foreign ${foreign.join(', ')} rows still reference owned fixture rows`
      );
    // Child-first deletes, exactly the acquired ids.
    if (blockIds.length > 0)
      await tx.delete(userBlocks).where(inArray(userBlocks.id, blockIds));
    if (muteIds.length > 0)
      await tx.delete(userMutes).where(inArray(userMutes.id, muteIds));
    if (commentIds.length > 0)
      await tx.delete(comments).where(inArray(comments.id, commentIds));
    if (postIds.length > 0)
      await tx.delete(posts).where(inArray(posts.id, postIds));
    if (userIds.length > 0)
      await tx.delete(users).where(inArray(users.id, userIds));
  });
}

afterAll(async () => {
  await cleanupOwned();
});

describe('profile replies viewer moderation', () => {
  it('anonymous reads stay unfiltered (control)', async () => {
    const { status, body } = await fetchReplies();
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    expect(res.total).toBe(8);
    expect(res.items).toHaveLength(8);
    expect(item(res, rPostBlocked).post?.content).toBe(
      'f148 post by blocked author'
    );
    expect(item(res, rPcBlocked).parentComment?.content).toBe(
      'f148 parent comment by blocked author'
    );
    expect(item(res, rPostNormal).replyCount).toBe(2);
  });

  it('hides embedded parent posts by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    // The owner's own replies are the page target: all stay listed and the
    // total still counts every visible reply.
    expect(res.total).toBe(8);
    expect(res.items).toHaveLength(8);
    expect(item(res, rPostNormal).post?.id).toBe(postNormal);
    expect(item(res, rPostBlocked).post).toBeNull();
    expect(item(res, rPostMuted).post).toBeNull();
    expect(item(res, rPostBlocker).post).toBeNull();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('f148 post by blocked author');
    expect(serialized).not.toContain('f148 post by muted author');
    expect(serialized).not.toContain('f148 post by blocking author');
  });

  it('hides embedded parent comments by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    expect(item(res, rPcNormal).parentComment?.id).toBe(pcNormal);
    expect(item(res, rPcBlocked).parentComment).toBeNull();
    expect(item(res, rPcMuted).parentComment).toBeNull();
    expect(item(res, rPcBlocker).parentComment).toBeNull();
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('f148 parent comment by blocked author');
    expect(serialized).not.toContain('f148 parent comment by muted author');
    expect(serialized).not.toContain('f148 parent comment by blocking author');
  });

  it('does not count child replies by authors the viewer must not see', async () => {
    const { status, body } = await fetchReplies(await viewerAuthHeaders());
    expect(status).toBe(200);
    const res = body as RepliesResponse;
    // Visible children of rPostNormal for the viewer: only the normal
    // author's (the blocked author's is never counted, the deleted one
    // is counted for nobody).
    expect(item(res, rPostNormal).replyCount).toBe(1);
  });

  it('a rejected batch insert registers no ownership and preserves foreign rows', async () => {
    // A pre-existing user plus a relationship attached to it: neither is
    // owned by this run, so a failed setup must leave both untouched.
    // The relationship uses two throwaway users, never the fixture viewer,
    // so it cannot change the viewer's moderation set.
    const canaryId = await generateSnowflakeId();
    const bystanderId = await generateSnowflakeId();
    const freshId = await generateSnowflakeId();
    const canaryBlockId = await generateSnowflakeId();
    let controlUsers: { id: string }[] = [];
    let controlBlocks: { id: string }[] = [];
    try {
      controlUsers = await db
        .insert(users)
        .values([
          {
            id: canaryId,
            username: `f148-canary-${canaryId}`,
            displayName: 'F148 Canary',
            updatedAt: new Date(),
          },
          {
            id: bystanderId,
            username: `f148-bystander-${bystanderId}`,
            displayName: 'F148 Bystander',
            updatedAt: new Date(),
          },
        ])
        .returning({ id: users.id });
      controlBlocks = await db
        .insert(userBlocks)
        .values([
          { id: canaryBlockId, blockerId: canaryId, blockedId: bystanderId },
        ])
        .returning({ id: userBlocks.id });
      let failure: unknown;
      try {
        await db.insert(users).values([
          {
            id: canaryId,
            username: `f148-collide-${canaryId}`,
            displayName: 'F148 Collide',
            updatedAt: new Date(),
          },
          {
            id: freshId,
            username: `f148-fresh-${freshId}`,
            displayName: 'F148 Fresh',
            updatedAt: new Date(),
          },
        ]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      // The actual PostgreSQL constraint cause, not just "something threw":
      // drizzle wraps the driver error, so the code lives on .cause.
      expect((failure as { cause?: { code?: unknown } }).cause?.code).toBe(
        '23505'
      );
      expect(ownedUsers.has(canaryId)).toBe(false);
      expect(ownedUsers.has(freshId)).toBe(false);
      const [canaryStillThere] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, canaryId));
      expect(canaryStillThere?.id).toBe(canaryId);
      const [freshStillThere] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, freshId));
      expect(freshStillThere).toBeUndefined();
      const [blockStillThere] = await db
        .select({ id: userBlocks.id })
        .from(userBlocks)
        .where(eq(userBlocks.id, canaryBlockId));
      expect(blockStillThere?.id).toBe(canaryBlockId);
    } finally {
      for (const row of controlUsers) ownedUsers.add(row.id);
      for (const row of controlBlocks) ownedBlocks.add(row.id);
    }
  });
});
