import { hasBlocked, hasMuted } from '@feed/db';

/** Public anonymous browsing stays available. A verified viewer's own
 * block/mute choices and authors who blocked them apply to personalized reads. */
export async function canViewerReadAuthor(
  viewerId: string | undefined,
  authorId: string
): Promise<boolean> {
  if (!viewerId) return true;
  const excluded = await Promise.all([
    hasBlocked(viewerId, authorId),
    hasBlocked(authorId, viewerId),
    hasMuted(viewerId, authorId),
  ]);
  return !excluded.some(Boolean);
}
