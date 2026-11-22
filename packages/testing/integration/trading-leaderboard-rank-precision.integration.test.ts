/**
 * PRD §9.4 / MVP Phase 6: profit-board list and own rank must agree on
 * netProfit DESC, stored createdAt ASC, id ASC, including microseconds.
 * Only pages containing this fixture's users are read; no top-window or
 * whole-world traversal is treated as a complete rank oracle.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { TradingLeaderboardService } from '@feed/api/services/trading-leaderboard-service';
import {
  and,
  asc,
  db,
  desc,
  eq,
  gameOnboarding,
  inArray,
  sql,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

setDefaultTimeout(60000);

// Configuration guard precedes every fixture write. Runtime additionally
// requires the maintainer's positively owned disposable parent database.
function ownedDatabaseUrl(value: string | undefined) {
  if (!value || !URL.canParse(value))
    throw new Error('Owned local test database required');
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/(test_db|feed_pr\d+)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Owned local test database required');
  return url;
}
const primaryDatabase = ownedDatabaseUrl(process.env.DATABASE_URL);
if (process.env.DIRECT_DATABASE_URL) {
  const direct = ownedDatabaseUrl(process.env.DIRECT_DATABASE_URL);
  if (
    direct.hostname !== primaryDatabase.hostname ||
    direct.port !== primaryDatabase.port ||
    direct.pathname !== primaryDatabase.pathname
  )
    throw new Error('Direct test database must match the primary endpoint');
}
if (process.env.DATABASE_READ_REPLICA_URL)
  throw new Error('Replica refused for owned fixture writes');

const PAGE_SIZE = 7;
type Receipt = { id: string; canonical: string };
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Rank = NonNullable<
  Awaited<ReturnType<typeof TradingLeaderboardService.getUserPosition>>
>;
const owned: Receipt[] = [];
const controls: Receipt[] = [];
const onboardingControls: Receipt[] = [];

function ids(rows: Receipt[]) {
  return rows.map((row) => row.id);
}

async function insertUser(
  tx: Transaction,
  pending: Receipt[],
  input: {
    id: string;
    prefix: string;
    lifetimePnL: string;
    createdAtLiteral: string;
  }
) {
  const returned = await tx
    .insert(users)
    .values({
      id: input.id,
      privyId: `did:privy:f133-${input.id}`,
      username: `${input.prefix}-${input.id}`,
      displayName: input.prefix,
      virtualBalance: '1000',
      totalDeposited: '1000',
      totalWithdrawn: '0',
      lifetimePnL: input.lifetimePnL,
      reputationPoints: 0,
      isActor: false,
      isAgent: false,
      profileComplete: true,
      createdAt: sql`${input.createdAtLiteral}::timestamp`,
      updatedAt: new Date(),
    })
    .returning({ id: users.id, canonical: sql<string>`to_jsonb("User")::text` })
    .execute();
  pending.push(...returned);
  if (returned.length !== 1 || returned[0]?.id !== input.id)
    throw new Error('User acquisition failed');
  return returned[0];
}

async function createUser(
  params: {
    prefix: string;
    lifetimePnL: string;
    createdAt?: Date;
    createdAtLiteral?: string;
  },
  registry = owned
): Promise<string> {
  const id = await generateSnowflakeId();
  const literal = params.createdAtLiteral ?? params.createdAt?.toISOString();
  if (!literal) throw new Error('Explicit fixture timestamp required');
  const pending: Receipt[] = [];
  await db.transaction(async (tx) => {
    await insertUser(tx, pending, { ...params, id, createdAtLiteral: literal });
  });
  // Publish complete RETURNING receipts only after the transaction commits.
  registry.push(...pending);
  return id;
}

const noForeignUserReferences = sql`
  NOT EXISTS(SELECT 1 FROM "GameOnboarding" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserPnLSnapshot" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Whitelist" x WHERE x."userId"="User".id OR x."grantedBy"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "WhitelistConfig" x WHERE x."updatedBy"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Post" x WHERE x."authorId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Comment" x WHERE x."authorId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Follow" x WHERE x."followerId"="User".id OR x."followingId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserBlock" x WHERE x."blockerId"="User".id OR x."blockedId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserMute" x WHERE x."muterId"="User".id OR x."mutedId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserSession" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserActivityLog" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserAgentConfig" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "UserApiKey" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Notification" x WHERE x."userId"="User".id OR x."actorId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "BalanceTransaction" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "Position" x WHERE x."userId"="User".id)
  AND NOT EXISTS(SELECT 1 FROM "PerpPosition" x WHERE x."userId"="User".id)
`;

async function cleanupOwnedUsers(registry = owned): Promise<void> {
  if (!registry.length) return;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids(registry)))
      .orderBy(asc(users.id))
      .for('update');
    if (locked.length !== registry.length)
      throw new Error('cleanup refused: acquired User missing');
    for (const row of registry) {
      const removed = await tx
        .delete(users)
        .where(
          and(
            eq(users.id, row.id),
            sql`to_jsonb("User")=${row.canonical}::text::jsonb`,
            noForeignUserReferences
          )
        )
        .returning({ id: users.id })
        .execute();
      if (removed.length !== 1 || removed[0]?.id !== row.id)
        throw new Error(
          'cleanup refused: User tuple changed or foreign reference exists'
        );
    }
  });
  registry.length = 0;
}

async function cleanupOnboardingControls() {
  if (!onboardingControls.length) return;
  await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: gameOnboarding.id })
      .from(gameOnboarding)
      .where(inArray(gameOnboarding.id, ids(onboardingControls)))
      .orderBy(asc(gameOnboarding.id))
      .for('update');
    if (locked.length !== onboardingControls.length)
      throw new Error('Control cleanup refused: onboarding missing');
    for (const row of onboardingControls) {
      const removed = await tx
        .delete(gameOnboarding)
        .where(
          and(
            eq(gameOnboarding.id, row.id),
            sql`to_jsonb("GameOnboarding")=${row.canonical}::text::jsonb`
          )
        )
        .returning({ id: gameOnboarding.id })
        .execute();
      if (removed.length !== 1)
        throw new Error('Control cleanup refused: onboarding changed');
    }
  });
  onboardingControls.length = 0;
}

async function physicalUsers(registry: Receipt[]) {
  if (!registry.length) return [];
  return db
    .select({ id: users.id, canonical: sql<string>`to_jsonb("User")::text` })
    .from(users)
    .where(inArray(users.id, ids(registry)))
    .orderBy(asc(users.id));
}

async function baselineCount() {
  return (await TradingLeaderboardService.getWalletLeaderboard(1, 1))
    .totalCount;
}

async function assertCohortConsistency(cohort: string[], baseline: number) {
  const count = baseline + cohort.length;
  expect(
    (await TradingLeaderboardService.getWalletLeaderboard(1, 1)).totalCount
  ).toBe(count);
  // These acquired users have no positions; their profit is lifetimePnL.
  // This independent, own-ID-only SQL preserves the full stored timestamp.
  const ordered = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, cohort))
    .orderBy(
      desc(sql`${users.lifetimePnL}::numeric`),
      asc(users.createdAt),
      asc(users.id)
    );
  expect(ordered.length).toBe(cohort.length);
  const positions: Rank[] = [];
  for (const id of cohort) {
    const position = await TradingLeaderboardService.getUserPosition(
      id,
      'wallet',
      PAGE_SIZE
    );
    expect(position).not.toBeNull();
    if (!position) throw new Error('Acquired user has no rank');
    expect(position.entry.id).toBe(id);
    expect(position.rank).toBeGreaterThan(0);
    expect(position.rank).toBeLessThanOrEqual(count);
    expect(position.page).toBe(Math.ceil(position.rank / PAGE_SIZE));
    expect(position.entry.netProfit).toBe(position.entry.lifetimePnL);
    positions.push(position);
  }
  const pages = [...new Set(positions.map((position) => position.page))].sort(
    (a, b) => a - b
  );
  const traversed: string[] = [];
  for (const page of pages) {
    const result = await TradingLeaderboardService.getWalletLeaderboard(
      page,
      PAGE_SIZE
    );
    expect(result.totalCount).toBe(count);
    for (const [index, entry] of result.users.entries()) {
      expect(entry.rank).toBe((page - 1) * PAGE_SIZE + index + 1);
      if (cohort.includes(entry.id)) traversed.push(entry.id);
    }
    for (const position of positions.filter((entry) => entry.page === page)) {
      // The separately executed list is the oracle for the reported rank.
      // Even an off-by-one rank within the same page must point at its own ID.
      const atRank = result.users[(position.rank - 1) % PAGE_SIZE];
      expect(atRank?.id).toBe(position.entry.id);
    }
  }
  expect(traversed).toEqual(ordered.map((row) => row.id));
  expect(new Set(traversed).size).toBe(cohort.length);
  return { positions, orderedIds: ordered.map((row) => row.id) };
}

afterAll(async () => {
  await cleanupOnboardingControls();
  await cleanupOwnedUsers(controls);
  await cleanupOwnedUsers();
});

describe('Trading leaderboard rank precision', () => {
  test('paged traversal reaches every fixture exactly once, in full-scan order', async () => {
    const baseline = await baselineCount();
    const cohort: string[] = [];
    const tieCreatedAt = new Date('2026-02-10T00:00:00.000Z');
    for (let i = 0; i < 8; i++)
      cohort.push(
        await createUser({
          prefix: 'f133-tie-exact',
          lifetimePnL: '4242.25',
          createdAt: tieCreatedAt,
        })
      );
    for (let i = 0; i < 15; i++)
      cohort.push(
        await createUser({
          prefix: 'f133-spread',
          lifetimePnL: (100 + i * 100).toFixed(2),
          createdAt: new Date(
            `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
          ),
        })
      );
    // Complete own-cohort order, not an assumed complete global top window.
    await assertCohortConsistency(cohort, baseline);
  });

  test('my-rank agrees with the list order for tied users', async () => {
    const baseline = await baselineCount();
    const cohort: string[] = [];
    for (let i = 0; i < 8; i++)
      cohort.push(
        await createUser({
          prefix: 'f133-myrank-tie',
          lifetimePnL: '5151.75',
          createdAt: new Date('2026-02-20T00:00:00.000Z'),
        })
      );
    expect(cohort.length).toBe(8);
    await assertCohortConsistency(cohort, baseline);
  });

  test('sub-millisecond createdAt ties: rank still agrees with list order', async () => {
    const baseline = await baselineCount();
    const a = await createUser({
      prefix: 'f133-us-a',
      lifetimePnL: '3131.50',
      createdAtLiteral: '2026-03-01 00:00:00.123456',
    });
    const b = await createUser({
      prefix: 'f133-us-b',
      lifetimePnL: '3131.50',
      createdAtLiteral: '2026-03-01 00:00:00.123200',
    });
    const { orderedIds, positions } = await assertCohortConsistency(
      [a, b],
      baseline
    );
    expect(orderedIds).toEqual([b, a]);
    const rankA = positions.find((position) => position.entry.id === a)?.rank;
    const rankB = positions.find((position) => position.entry.id === b)?.rank;
    expect(rankA).toBeDefined();
    expect(rankB).toBeDefined();
    if (rankA === undefined || rankB === undefined)
      throw new Error('Missing microsecond rank');
    expect(rankB).toBeLessThan(rankA);
  });
});

function isUserPrimaryKeyCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    'code' in error &&
    error.code === '23505' &&
    'constraint_name' in error &&
    error.constraint_name === 'User_pkey'
  )
    return true;
  return (
    'cause' in error &&
    error.cause !== error &&
    isUserPrimaryKeyCollision(error.cause)
  );
}

describe('fixture ownership', () => {
  test('cleanup refuses a user with a separately owned onboarding row', async () => {
    const controlId = await createUser(
      {
        prefix: 'f133-collision-control',
        lifetimePnL: '0',
        createdAt: new Date('2026-02-25T00:00:00.000Z'),
      },
      controls
    );
    const beforeControls = await physicalUsers(controls);
    const beforeOwned = await physicalUsers(owned);
    const partialId = await generateSnowflakeId();
    const pending: Receipt[] = [];
    await db
      .transaction(async (tx) => {
        await insertUser(tx, pending, {
          id: partialId,
          prefix: 'f133-partial',
          lifetimePnL: '0',
          createdAtLiteral: '2026-02-25 00:00:00',
        });
        await insertUser(tx, pending, {
          id: controlId,
          prefix: 'f133-pk-collision',
          lifetimePnL: '0',
          createdAtLiteral: '2026-02-25 00:00:00',
        });
      })
      .then(
        () => {
          throw new Error('Expected User primary-key collision');
        },
        (error: unknown) => {
          if (!isUserPrimaryKeyCollision(error)) throw error;
        }
      );
    // Pending physical receipts from the failed transaction were never adopted.
    expect(await physicalUsers(controls)).toEqual(beforeControls);
    expect(await physicalUsers(owned)).toEqual(beforeOwned);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, partialId))
    ).toEqual([]);

    const victimId = await createUser({
      prefix: 'f133-ownership-victim',
      lifetimePnL: '100.00',
      createdAt: new Date('2026-02-25T00:00:00.000Z'),
    });
    const pendingOnboarding = await db.transaction(async (tx) =>
      tx
        .insert(gameOnboarding)
        .values({ id: await generateSnowflakeId(), userId: victimId })
        .returning({
          id: gameOnboarding.id,
          canonical: sql<string>`to_jsonb("GameOnboarding")::text`,
        })
        .execute()
    );
    onboardingControls.push(...pendingOnboarding);
    if (pendingOnboarding.length !== 1)
      throw new Error('Onboarding control acquisition failed');
    try {
      const beforeRefusal = await physicalUsers(owned);
      await expect(cleanupOwnedUsers()).rejects.toThrow(/cleanup refused/);
      expect(await physicalUsers(owned)).toEqual(beforeRefusal);
      const onboarding = await db
        .select({
          id: gameOnboarding.id,
          canonical: sql<string>`to_jsonb("GameOnboarding")::text`,
        })
        .from(gameOnboarding)
        .where(inArray(gameOnboarding.id, ids(onboardingControls)))
        .orderBy(asc(gameOnboarding.id));
      expect(onboarding).toEqual(
        [...onboardingControls].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        )
      );
    } finally {
      await cleanupOnboardingControls();
      await cleanupOwnedUsers(controls);
    }
  });
});
