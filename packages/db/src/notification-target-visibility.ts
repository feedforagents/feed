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
 * Apply the target checks inside each list or count statement. PostgreSQL
 * evaluates existence in that statement's snapshot and returns the requested
 * page or exact unread count without transferring the user's target history.
 * The scalar subqueries match primary keys, allowing the limited page to
 * look up each target without building a hash of all live posts or comments.
 */

import type { SQL } from 'drizzle-orm';
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db } from './db';
import { comments, notifications, posts } from './schema';

export function notificationTargetVisibilityCondition(): SQL {
  return and(
    or(
      isNull(notifications.postId),
      eq(notifications.postId, ''),
      isNotNull(
        sql`(${db
          .select({ id: posts.id })
          .from(posts)
          .where(
            and(eq(posts.id, notifications.postId), isNull(posts.deletedAt))
          )})`
      )
    ),
    or(
      isNull(notifications.commentId),
      eq(notifications.commentId, ''),
      isNotNull(
        sql`(${db
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              eq(comments.id, notifications.commentId),
              isNull(comments.deletedAt)
            )
          )})`
      )
    )
  ) as SQL;
}
