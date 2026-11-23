import { type DrizzleClient, db, eq, getStorageMode, users } from '@feed/db';
import { logger } from '@feed/shared';
import { CACHE_KEYS, invalidateCachePattern } from '../cache/cache-service';

type LeaderboardIdentity = Pick<
  typeof users.$inferSelect,
  'username' | 'displayName' | 'profileImageUrl'
>;

export async function updateProfileWithLeaderboardInvalidation<
  Result extends LeaderboardIdentity | undefined,
>(
  userId: string,
  fields: Partial<LeaderboardIdentity>,
  update: (client: DrizzleClient) => Promise<Result>
): Promise<Result> {
  if (
    getStorageMode() !== 'postgres' ||
    (fields.username === undefined &&
      fields.displayName === undefined &&
      fields.profileImageUrl === undefined)
  ) {
    return update(db);
  }

  // Compare against the row this write actually replaces, even for concurrent edits.
  const { before, after } = await db.$transaction(async (tx) => {
    const [before] = await tx
      .select({
        username: users.username,
        displayName: users.displayName,
        profileImageUrl: users.profileImageUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return { before, after: await update(tx) };
  });

  if (
    before &&
    after &&
    (before.username !== after.username ||
      before.displayName !== after.displayName ||
      before.profileImageUrl !== after.profileImageUrl)
  ) {
    try {
      await invalidateCachePattern('*', {
        namespace: CACHE_KEYS.LEADERBOARD_PERSONAL,
        scanCount: 1000,
      });
    } catch (error) {
      // The profile is already committed. Failed cache writes expire on the usual TTL.
      logger.warn(
        'Failed to invalidate leaderboard after profile update',
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Profile'
      );
    }
  }

  return after;
}
