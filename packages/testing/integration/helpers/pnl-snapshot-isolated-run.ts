// Isolated real-producer run. Only invoked by
// wallet-pnl-perp-funding.integration.test.ts, which spawns it via
// `bun test` in a child process whose DATABASE_URL points at a freshly
// created, migrated, exclusively owned database. The child never touches
// the shared test database: it seeds only the rows described by
// PNL_SNAPSHOT_RUN_JSON, runs the real global producer
// (snapshotAllUserPnlMetrics), asserts the persisted rows, and exits.
// The parent drops the whole database afterwards, so no row created here
// ever needs per-row cleanup — and no outside row can be deleted by a
// before/after diff, because there is no outside row in this database.
import { expect, mock, test } from 'bun:test';
import { db, eq, userPnLSnapshots, users } from '@feed/db';

// This Next.js build guard has no database/runtime behavior.
mock.module('server-only', () => ({}));
const { getHourBoundary, snapshotAllUserPnlMetrics } = await import(
  '../../../../apps/web/src/lib/wallet/pnlHistory'
);

interface IsolatedRunInput {
  ownerId: string;
  ownerLifetimePnL: string;
  expectedOwnerCurrentPnL: number;
  bystanderWithRowId: string;
  bystanderWithRowLifetimePnL: string;
  bystanderWithoutRowId: string;
  bystanderWithoutRowLifetimePnL: string;
  snapshotAt: string;
}

function assertDisposableDatabaseUrl(value: string | undefined): string {
  if (!value)
    throw new Error('DATABASE_URL is required for the isolated snapshot run');
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
    !/(?:^|[_-])(test|testing|verification)(?:[_-]|$)/i.test(databaseName)
  ) {
    throw new Error(
      'DATABASE_URL must point to a local test or verification database'
    );
  }
  return databaseName;
}

const rawInput = process.env.PNL_SNAPSHOT_RUN_JSON;
if (!rawInput)
  throw new Error('PNL_SNAPSHOT_RUN_JSON is required for the isolated run');
const input = JSON.parse(rawInput) as IsolatedRunInput;
for (const field of [
  'ownerId',
  'ownerLifetimePnL',
  'bystanderWithRowId',
  'bystanderWithRowLifetimePnL',
  'bystanderWithoutRowId',
  'bystanderWithoutRowLifetimePnL',
  'snapshotAt',
] as const) {
  if (!input[field]) throw new Error(`PNL_SNAPSHOT_RUN_JSON misses ${field}`);
}

test('isolated snapshot producer persists post-close metrics and touches only fixture rows', async () => {
  const databaseName = assertDisposableDatabaseUrl(process.env.DATABASE_URL);
  const snapshotAt = new Date(input.snapshotAt);
  const hourBoundary = getHourBoundary(snapshotAt);

  // This database must contain only what this run seeds: refuse to run
  // against a database that already has snapshot rows for this hour.
  const preexisting = await db
    .select()
    .from(userPnLSnapshots)
    .where(eq(userPnLSnapshots.snapshotAt, hourBoundary));
  expect(preexisting).toEqual([]);

  const seededAt = new Date();
  for (const [id, lifetimePnL] of [
    [input.ownerId, input.ownerLifetimePnL],
    [input.bystanderWithRowId, input.bystanderWithRowLifetimePnL],
    [input.bystanderWithoutRowId, input.bystanderWithoutRowLifetimePnL],
  ] as const) {
    const [row] = await db
      .insert(users)
      .values({
        id,
        username: `pnl-flow-isolated-${id}`,
        virtualBalance: '100000',
        totalDeposited: '100000',
        lifetimePnL,
        updatedAt: seededAt,
      })
      .returning({ id: users.id });
    if (!row) throw new Error(`seeding user ${id} returned no row`);
  }
  // The bystander with a pre-existing row keeps exactly this row: the
  // producer's on-conflict-do-nothing insert must leave it alone.
  await db.insert(userPnLSnapshots).values({
    id: `${input.bystanderWithRowId}:${hourBoundary.toISOString()}:pnl`,
    userId: input.bystanderWithRowId,
    snapshotAt: hourBoundary,
    lifetimePnL: 42,
    unrealizedPnL: 0,
    currentPnL: 42,
  });

  const inserted = await snapshotAllUserPnlMetrics(snapshotAt);
  // Three candidates, one pre-existing row: only the owner and the
  // bystander without a row gain one.
  expect(inserted).toBe(2);

  const rows = await db
    .select()
    .from(userPnLSnapshots)
    .where(eq(userPnLSnapshots.snapshotAt, hourBoundary));
  const byUserId = new Map(rows.map((row) => [row.userId, row]));
  expect([...byUserId.keys()].sort()).toEqual(
    [
      input.bystanderWithRowId,
      input.bystanderWithoutRowId,
      input.ownerId,
    ].sort()
  );

  // The persisted hourly snapshot carries the same post-close metrics.
  const [ownerRow] = await db
    .select()
    .from(userPnLSnapshots)
    .where(eq(userPnLSnapshots.userId, input.ownerId));
  expect(ownerRow).toBeDefined();
  expect(Number(ownerRow?.currentPnL)).toBeCloseTo(
    input.expectedOwnerCurrentPnL,
    8
  );
  expect(Number(ownerRow?.unrealizedPnL)).toBe(0);

  // The global producer really reaches unrelated users: the bystander
  // without a pre-existing row gains one, while the bystander's
  // pre-existing row is left alone by the on-conflict-do-nothing insert.
  const [createdRow] = await db
    .select()
    .from(userPnLSnapshots)
    .where(eq(userPnLSnapshots.userId, input.bystanderWithoutRowId));
  expect(createdRow).toBeDefined();
  const [keptRow] = await db
    .select()
    .from(userPnLSnapshots)
    .where(eq(userPnLSnapshots.userId, input.bystanderWithRowId));
  expect(keptRow).toBeDefined();
  expect(Number(keptRow?.currentPnL)).toBe(42);
  expect(Number(keptRow?.unrealizedPnL)).toBe(0);

  console.log(JSON.stringify({ ok: true, database: databaseName, inserted }));
});
