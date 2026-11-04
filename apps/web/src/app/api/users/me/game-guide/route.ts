// POST /api/users/me/game-guide - Mark game guide as completed

import {
  authenticateWithDbUser,
  NotFoundError,
  successResponse,
  withErrorHandling,
} from '@feed/api';
import { db, eq, sql, users } from '@feed/db';
import { toISO } from '@feed/shared';
import type { NextRequest } from 'next/server';

export const POST = withErrorHandling(async (request: NextRequest) => {
  const authUser = await authenticateWithDbUser(request);
  const now = new Date();

  // Preserve the first completion time on retries/replays.
  const [updated] = await db
    .update(users)
    .set({
      gameGuideCompletedAt: sql`coalesce(${users.gameGuideCompletedAt}, ${now.toISOString()}::timestamp)`,
      updatedAt: now,
    })
    .where(eq(users.id, authUser.dbUserId))
    .returning({ gameGuideCompletedAt: users.gameGuideCompletedAt });

  if (!updated?.gameGuideCompletedAt) {
    throw new NotFoundError('User');
  }

  return successResponse({
    success: true,
    gameGuideCompletedAt: toISO(updated.gameGuideCompletedAt),
  });
});
