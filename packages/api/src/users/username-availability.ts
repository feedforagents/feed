/**
 * Username availability
 *
 * @description Shared rule for profile updates on every surface (website,
 * MCP, A2A): a user may not take a username that another user already holds
 * in any letter case, because username lookups resolve with lower(username).
 */

import { and, dbWrite, ne, users } from '@feed/db';
import { sql } from 'drizzle-orm';
import { BusinessLogicError } from '../errors';

/**
 * Throw `USERNAME_TAKEN` when a user other than `userId` holds `username`
 * case-insensitively. The user may still change the letter case of their own
 * username.
 *
 * Reads the primary (`dbWrite`) so a username taken moments ago is not missed
 * because of replica lag.
 *
 * @throws {BusinessLogicError} `USERNAME_TAKEN` if another user holds it
 */
export async function assertUsernameAvailable(
  username: string,
  userId: string
): Promise<void> {
  const [holder] = await dbWrite
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.username}) = lower(${username})`,
        ne(users.id, userId)
      )
    )
    .limit(1);

  if (holder) {
    throw new BusinessLogicError('Username is already taken', 'USERNAME_TAKEN');
  }
}
