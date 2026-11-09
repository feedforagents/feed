import { z } from 'zod';
import type { PendingAction } from './pending-intent';

export const continuationProfileSchema = z.object({
  authenticated: z.literal(true),
  needsOnboarding: z.boolean(),
  user: z.object({
    id: z.string().min(1),
    username: z.string().min(1),
    profileComplete: z.literal(true),
    tosAcceptedAt: z.string().datetime(),
  }),
});

/** Desired-state requests only: cached toggles must never be used for continuation. */
export function desiredActionUrl(action: PendingAction): string | null {
  if (action.kind === 'like')
    return `/api/${action.targetType === 'post' ? 'posts' : 'comments'}/${encodeURIComponent(action.targetId)}/like`;
  if (action.kind === 'follow')
    return `/api/users/${encodeURIComponent(action.targetId)}/follow`;
  return null;
}
export function isAlreadyDesiredResponse(
  action: PendingAction,
  value: object
): boolean {
  // These routes intentionally omit machine codes in production. Match only their
  // existing public desired-state errors, never a generic 400 or validation error.
  const result = z
    .object({ error: z.string(), code: z.string().optional() })
    .safeParse(value);
  if (!result.success) return false;
  if (action.kind === 'like')
    return (
      result.data.error ===
      (action.targetType === 'post'
        ? 'Post already liked'
        : 'Comment already liked')
    );
  if (action.kind === 'follow')
    return (
      result.data.error === 'Already following this user' ||
      result.data.error === 'Already following this actor'
    );
  return false;
}
