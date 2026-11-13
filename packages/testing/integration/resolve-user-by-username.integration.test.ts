/**
 * PRD §§8.1/12, MVP Phase 1: retain the intended DM recipient when resolving
 * a case-insensitive username; require an explicit user ID for ambiguity.
 * These are real-database resolver and fixture-safety cases, not proof of
 * SEND_MESSAGE delivery. Actual authorized message/client acceptance is separate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  and,
  dbWrite as db,
  eq,
  follows,
  gameOnboarding,
  or,
  sql,
  userBlocks,
  userPnLSnapshots,
  users,
  whitelist,
  whitelistConfig,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { resolveUserByUsername } from '../../agents/src/autonomous/utils/context-gatherers';

// Raw PostgreSQL text preserves timestamp precision and every returned field.
type CapturedRow = { id: string; canonical: string };
function ownership() {
  return {
    users: new Map<string, CapturedRow>(),
    gameOnboarding: new Map<string, CapturedRow>(),
    userPnLSnapshots: new Map<string, CapturedRow>(),
    whitelist: new Map<string, CapturedRow>(),
    whitelistConfig: new Map<string, CapturedRow>(),
  };
}
type Ownership = ReturnType<typeof ownership>;
const owned = ownership();
let userId: string;
let username: string;
let unknownUsername: string;

async function insertUser(
  values: Array<typeof users.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(users)
    .values(values)
    .returning({
      id: users.id,
      canonical: sql<string>`to_jsonb(${users})::text`,
    });
  for (const row of rows) receipt.users.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete User RETURNING');
  return rows;
}

async function insertGameOnboarding(
  values: Array<typeof gameOnboarding.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(gameOnboarding)
    .values(values)
    .returning({
      id: gameOnboarding.id,
      canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
    });
  for (const row of rows) receipt.gameOnboarding.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete GameOnboarding RETURNING');
  return rows;
}

async function insertUserPnLSnapshot(
  values: Array<typeof userPnLSnapshots.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(userPnLSnapshots)
    .values(values)
    .returning({
      id: userPnLSnapshots.id,
      canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
    });
  for (const row of rows) receipt.userPnLSnapshots.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete UserPnLSnapshot RETURNING');
  return rows;
}

async function insertWhitelist(
  values: Array<typeof whitelist.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(whitelist)
    .values(values)
    .returning({
      id: whitelist.id,
      canonical: sql<string>`to_jsonb(${whitelist})::text`,
    });
  for (const row of rows) receipt.whitelist.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete Whitelist RETURNING');
  return rows;
}

async function insertWhitelistConfig(
  values: Array<typeof whitelistConfig.$inferInsert>,
  receipt = owned
) {
  const rows = await db
    .insert(whitelistConfig)
    .values(values)
    .returning({
      id: whitelistConfig.id,
      canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
    });
  for (const row of rows) receipt.whitelistConfig.set(row.id, row);
  if (rows.length !== values.length)
    throw new Error('Incomplete WhitelistConfig RETURNING');
  return rows;
}

async function createUser(receipt = owned): Promise<string> {
  const id = await generateSnowflakeId();
  await insertUser(
    [{ id, username: `resolve_${id}`, updatedAt: new Date() }],
    receipt
  );
  return id;
}

async function cleanup(receipt: Ownership) {
  for (const row of receipt.gameOnboarding.values()) {
    await db
      .delete(gameOnboarding)
      .where(
        and(
          eq(gameOnboarding.id, row.id),
          sql`to_jsonb(${gameOnboarding}) = to_jsonb(jsonb_populate_record(NULL::"GameOnboarding", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: gameOnboarding.id,
        canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
      })
      .from(gameOnboarding)
      .where(eq(gameOnboarding.id, row.id));
    if (remaining.length)
      throw new Error(`Owned GameOnboarding remains: ${row.id}`);
    receipt.gameOnboarding.delete(row.id);
  }
  for (const row of receipt.userPnLSnapshots.values()) {
    await db
      .delete(userPnLSnapshots)
      .where(
        and(
          eq(userPnLSnapshots.id, row.id),
          sql`to_jsonb(${userPnLSnapshots}) = to_jsonb(jsonb_populate_record(NULL::"UserPnLSnapshot", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: userPnLSnapshots.id,
        canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
      })
      .from(userPnLSnapshots)
      .where(eq(userPnLSnapshots.id, row.id));
    if (remaining.length)
      throw new Error(`Owned UserPnLSnapshot remains: ${row.id}`);
    receipt.userPnLSnapshots.delete(row.id);
  }
  for (const row of receipt.whitelist.values()) {
    await db
      .delete(whitelist)
      .where(
        and(
          eq(whitelist.id, row.id),
          sql`to_jsonb(${whitelist}) = to_jsonb(jsonb_populate_record(NULL::"Whitelist", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: whitelist.id,
        canonical: sql<string>`to_jsonb(${whitelist})::text`,
      })
      .from(whitelist)
      .where(eq(whitelist.id, row.id));
    if (remaining.length) throw new Error(`Owned Whitelist remains: ${row.id}`);
    receipt.whitelist.delete(row.id);
  }
  for (const row of receipt.whitelistConfig.values()) {
    await db
      .delete(whitelistConfig)
      .where(
        and(
          eq(whitelistConfig.id, row.id),
          sql`to_jsonb(${whitelistConfig}) = to_jsonb(jsonb_populate_record(NULL::"WhitelistConfig", ${row.canonical}::text::jsonb))`
        )
      );
    const remaining = await db
      .select({
        id: whitelistConfig.id,
        canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
      })
      .from(whitelistConfig)
      .where(eq(whitelistConfig.id, row.id));
    if (remaining.length)
      throw new Error(`Owned WhitelistConfig remains: ${row.id}`);
    receipt.whitelistConfig.delete(row.id);
  }
  for (const row of receipt.users.values()) {
    await db
      .delete(users)
      .where(
        and(
          eq(users.id, row.id),
          sql`to_jsonb(${users}) = to_jsonb(jsonb_populate_record(NULL::"User", ${row.canonical}::text::jsonb))`,
          sql`NOT EXISTS (SELECT 1 FROM ${gameOnboarding} WHERE ${gameOnboarding.userId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${userPnLSnapshots} WHERE ${userPnLSnapshots.userId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${whitelist} WHERE ${whitelist.userId} = ${row.id} OR ${whitelist.grantedBy} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${whitelistConfig} WHERE ${whitelistConfig.updatedBy} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${follows} WHERE ${follows.followerId} = ${row.id} OR ${follows.followingId} = ${row.id})`,
          sql`NOT EXISTS (SELECT 1 FROM ${userBlocks} WHERE ${userBlocks.blockerId} = ${row.id} OR ${userBlocks.blockedId} = ${row.id})`
        )
      );
    const remaining = await db
      .select({
        id: users.id,
        canonical: sql<string>`to_jsonb(${users})::text`,
      })
      .from(users)
      .where(eq(users.id, row.id));
    if (remaining.length) throw new Error(`Owned User remains: ${row.id}`);
    receipt.users.delete(row.id);
  }
}
describe('resolveUserByUsername', () => {
  beforeAll(async () => {
    const id = await generateSnowflakeId();
    username = `CaseUser_${id}`;
    unknownUsername = `MissingUser_${id}`;
    const conflicts = await db
      .select({ id: users.id })
      .from(users)
      .where(
        or(
          sql`lower(${users.username}) = ${username.toLowerCase()}`,
          sql`lower(${users.username}) = ${unknownUsername.toLowerCase()}`
        )
      )
      .limit(1);
    if (conflicts.length)
      throw new Error('Fixture names already exist; preserve unrelated users');
    const rows = await insertUser([
      { id, username, isActor: false, updatedAt: new Date() },
    ]);
    if (!rows[0]) throw new Error('Missing acquired fixture User');
    userId = rows[0].id;
  });

  afterAll(async () => {
    await cleanup(owned);
  });

  it('resolves a mixed-case username as stored', async () => {
    expect(await resolveUserByUsername(username)).toBe(userId);
  });
  it('resolves a mixed-case username in all-lowercase form', async () => {
    expect(await resolveUserByUsername(username.toLowerCase())).toBe(userId);
  });
  it('resolves a mixed-case username in all-uppercase form', async () => {
    expect(await resolveUserByUsername(username.toUpperCase())).toBe(userId);
  });
  it('resolves a mixed-case username with a leading @', async () => {
    expect(await resolveUserByUsername(`@${username}`)).toBe(userId);
  });
  it('returns null for an unknown username', async () => {
    expect(await resolveUserByUsername(unknownUsername)).toBeNull();
  });

  it('rejects ambiguous case variants instead of choosing a recipient', async () => {
    const token = await generateSnowflakeId();
    const lower = `ambiguous_${token}`;
    await insertUser([
      {
        id: await generateSnowflakeId(),
        username: lower,
        updatedAt: new Date(),
      },
      {
        id: await generateSnowflakeId(),
        username: lower.toUpperCase(),
        updatedAt: new Date(),
      },
    ]);
    const matches = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = ${lower}`)
      .limit(3);
    expect(matches).toHaveLength(2);
    for (const input of [lower, lower.toUpperCase(), `@${lower}`]) {
      await expect(resolveUserByUsername(input)).rejects.toThrow(
        `Ambiguous username: ${lower}; use a user ID`
      );
    }
  });

  it('preserves a colliding User after partial fixture setup fails', async () => {
    const control = ownership();
    const partial = ownership();
    try {
      const id = await createUser(control);
      const row = control.users.get(id);
      if (!row) throw new Error('Missing acquired collision control');
      await createUser(partial);
      await expect(
        insertUser(
          [
            {
              id,
              username: `different_${await generateSnowflakeId()}`,
              updatedAt: new Date(),
            },
          ],
          partial
        )
      ).rejects.toMatchObject({
        cause: { code: '23505', constraint_name: 'User_pkey' },
      });
      expect(partial.users.size).toBe(1);
      await cleanup(partial);
      expect(
        await db
          .select({
            id: users.id,
            canonical: sql<string>`to_jsonb(${users})::text`,
          })
          .from(users)
          .where(eq(users.id, id))
      ).toEqual([row]);
    } finally {
      await cleanup(partial);
      await cleanup(control);
    }
  });

  it('refuses User cleanup while foreign destructive references remain', async () => {
    const subjects = Array.from({ length: 5 }, () => ownership());
    const foreign = ownership();
    try {
      const ids: string[] = [];
      for (const subject of subjects) ids.push(await createUser(subject));
      const [onboardingId, pnlId, whitelistedId, grantorId, configId] = ids;
      if (!onboardingId || !pnlId || !whitelistedId || !grantorId || !configId)
        throw new Error('Missing foreign-reference subjects');
      const now = new Date();
      await insertGameOnboarding(
        [
          {
            id: await generateSnowflakeId(),
            userId: onboardingId,
            updatedAt: now,
          },
        ],
        foreign
      );
      await insertUserPnLSnapshot(
        [
          {
            id: await generateSnowflakeId(),
            userId: pnlId,
            snapshotAt: now,
            createdAt: now,
          },
        ],
        foreign
      );
      await insertWhitelist(
        [
          {
            id: await generateSnowflakeId(),
            userId: whitelistedId,
            grantedBy: grantorId,
            source: 'admin_manual',
            grantedAt: now,
          },
        ],
        foreign
      );
      await insertWhitelistConfig(
        [
          {
            id: await generateSnowflakeId(),
            updatedBy: configId,
            updatedAt: now,
          },
        ],
        foreign
      );
      const before = {
        onboarding: await db
          .select({
            id: gameOnboarding.id,
            canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
          })
          .from(gameOnboarding)
          .where(eq(gameOnboarding.userId, onboardingId)),
        pnl: await db
          .select({
            id: userPnLSnapshots.id,
            canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
          })
          .from(userPnLSnapshots)
          .where(eq(userPnLSnapshots.userId, pnlId)),
        whitelist: await db
          .select({
            id: whitelist.id,
            canonical: sql<string>`to_jsonb(${whitelist})::text`,
          })
          .from(whitelist)
          .where(eq(whitelist.userId, whitelistedId)),
        configs: await db
          .select({
            id: whitelistConfig.id,
            canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
          })
          .from(whitelistConfig)
          .where(eq(whitelistConfig.updatedBy, configId)),
      };
      for (const subject of subjects) {
        await expect(cleanup(subject)).rejects.toThrow('Owned User remains');
        const row = [...subject.users.values()][0];
        if (!row) throw new Error('Lost refused User receipt');
        expect(
          await db
            .select({
              id: users.id,
              canonical: sql<string>`to_jsonb(${users})::text`,
            })
            .from(users)
            .where(eq(users.id, row.id))
        ).toEqual([row]);
        expect({
          onboarding: await db
            .select({
              id: gameOnboarding.id,
              canonical: sql<string>`to_jsonb(${gameOnboarding})::text`,
            })
            .from(gameOnboarding)
            .where(eq(gameOnboarding.userId, onboardingId)),
          pnl: await db
            .select({
              id: userPnLSnapshots.id,
              canonical: sql<string>`to_jsonb(${userPnLSnapshots})::text`,
            })
            .from(userPnLSnapshots)
            .where(eq(userPnLSnapshots.userId, pnlId)),
          whitelist: await db
            .select({
              id: whitelist.id,
              canonical: sql<string>`to_jsonb(${whitelist})::text`,
            })
            .from(whitelist)
            .where(eq(whitelist.userId, whitelistedId)),
          configs: await db
            .select({
              id: whitelistConfig.id,
              canonical: sql<string>`to_jsonb(${whitelistConfig})::text`,
            })
            .from(whitelistConfig)
            .where(eq(whitelistConfig.updatedBy, configId)),
        }).toEqual(before);
      }
    } finally {
      await cleanup(foreign);
      for (const subject of subjects) await cleanup(subject);
    }
  });
});
