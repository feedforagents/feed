import { hasBlocked, hasMuted } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';

/** Test authors are excluded from public reads. Verified viewers additionally
 * apply their own block/mute choices and authors who blocked them. */
export async function canViewerReadAuthor(
  viewerId: string | undefined,
  authorId: string,
  resolvedIsTest: boolean
): Promise<boolean> {
  if (
    authorId.startsWith('test-') ||
    StaticDataRegistry.getActor(authorId)?.isTest
  )
    return false;
  if (resolvedIsTest) return false;
  if (!viewerId) return true;
  const excluded = await Promise.all([
    hasBlocked(viewerId, authorId),
    hasBlocked(authorId, viewerId),
    hasMuted(viewerId, authorId),
  ]);
  return !excluded.some(Boolean);
}
