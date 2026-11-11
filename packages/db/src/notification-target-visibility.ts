/**
 * Notification Target Visibility
 *
 * The web notification list (GET /api/notifications) applies a canonical
 * target rule: a notification whose postId names a post that no longer
 * exists or is soft-deleted is hidden, and likewise for a commentId naming
 * a comment. Null or empty targets are unlinked notifications and stay
 * visible. The web unread count shares the same condition, so a hidden
 * notification is never counted either.
 *
 * The Prisma-style client used by the MCP tool handlers and the A2A
 * executor cannot express that existence check inside a notification
 * query. This helper resolves the equivalent sets for one user — the
 * distinct targets their notifications point at, minus the targets still
 * alive — and returns a where fragment that excludes the dead targets.
 * Callers spread the fragment into their list and count queries so the
 * exclusion happens before any limit is taken.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db';
import { comments, notifications, posts } from './schema';

export type NotificationTargetWhere = {
  AND: Array<{ OR: Array<Record<string, unknown>> }>;
};

export async function buildNotificationTargetWhere(
  userId: string
): Promise<NotificationTargetWhere | Record<string, never>> {
  const rows = await db
    .selectDistinct({
      postId: notifications.postId,
      commentId: notifications.commentId,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  const postIds = new Set<string>();
  const commentIds = new Set<string>();
  for (const row of rows) {
    // Empty-string targets are unlinked, like null (the web rule).
    if (row.postId) postIds.add(row.postId);
    if (row.commentId) commentIds.add(row.commentId);
  }

  const deadPostIds = await deadIds(postIds, 'post');
  const deadCommentIds = await deadIds(commentIds, 'comment');

  const and: NotificationTargetWhere['AND'] = [];
  if (deadPostIds.length > 0) {
    and.push({
      OR: [{ postId: null }, { postId: { notIn: deadPostIds } }],
    });
  }
  if (deadCommentIds.length > 0) {
    and.push({
      OR: [{ commentId: null }, { commentId: { notIn: deadCommentIds } }],
    });
  }

  return and.length > 0 ? { AND: and } : {};
}

async function deadIds(
  ids: Set<string>,
  kind: 'post' | 'comment'
): Promise<string[]> {
  if (ids.size === 0) return [];
  const idList = [...ids];
  const alive =
    kind === 'post'
      ? await db
          .select({ id: posts.id })
          .from(posts)
          .where(and(inArray(posts.id, idList), isNull(posts.deletedAt)))
      : await db
          .select({ id: comments.id })
          .from(comments)
          .where(and(inArray(comments.id, idList), isNull(comments.deletedAt)));
  const aliveIds = new Set(alive.map((row) => row.id));
  return idList.filter((id) => !aliveIds.has(id));
}
