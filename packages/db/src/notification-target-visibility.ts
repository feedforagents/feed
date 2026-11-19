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
 * This module exposes that same rule as a single Drizzle predicate so the
 * MCP tool handlers and the A2A executor can apply it inside their own
 * list/count queries. The predicate is a pair of correlated EXISTS checks,
 * evaluated by the database per candidate row: the list and the count each
 * read only the rows they return, bounded by the requested limit, and a
 * target deleted between the list and the count reads is excluded from
 * both. No notification history is materialized into the application —
 * an earlier version resolved every distinct target across a user's
 * lifetime into IN / NOT IN arrays, so one request for 11 notifications
 * read and transferred the whole target history.
 */

import type { SQL } from 'drizzle-orm';
import { and, eq, exists, isNull, or } from 'drizzle-orm';
import { db } from './db';
import { comments, notifications, posts } from './schema';

export function notificationTargetVisibilityCondition(): SQL {
  return and(
    or(
      isNull(notifications.postId),
      eq(notifications.postId, ''),
      exists(
        db
          .select({ id: posts.id })
          .from(posts)
          .where(
            and(eq(posts.id, notifications.postId), isNull(posts.deletedAt))
          )
      )
    ),
    or(
      isNull(notifications.commentId),
      eq(notifications.commentId, ''),
      exists(
        db
          .select({ id: comments.id })
          .from(comments)
          .where(
            and(
              eq(comments.id, notifications.commentId),
              isNull(comments.deletedAt)
            )
          )
      )
    )
  ) as SQL;
}
