/**
 * resolveUserByUsername resolves usernames case-insensitively, like every
 * other username lookup in the codebase (signup, by-username route,
 * user-lookup, plugin-agent-core lookup-user).
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db, eq, users } from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';
import { resolveUserByUsername } from '../../agents/src/autonomous/utils/context-gatherers';

let userId: string;
let username: string;

describe('resolveUserByUsername', () => {
  beforeAll(async () => {
    userId = await generateSnowflakeId();
    username = `CaseUser_${userId.slice(-8)}`;
    await db.insert(users).values({
      id: userId,
      username,
      isActor: false,
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, userId));
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
    expect(await resolveUserByUsername('no-such-user-xyz')).toBeNull();
  });
});
