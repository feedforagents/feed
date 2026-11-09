import { dbWrite, eq, users } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { logger, toISO, toISOOrNull } from '@feed/shared';
import { cachedDb } from '../cache';
import { findUserByIdentifier } from '../users';
import { canViewerReadAuthor } from './public-read-visibility';

export type ProfileStats = {
  positions: number;
  comments: number;
  reactions: number;
  followers: number;
  following: number;
  posts: number;
};

const EMPTY_PROFILE_STATS: ProfileStats = {
  positions: 0,
  comments: 0,
  reactions: 0,
  followers: 0,
  following: 0,
  posts: 0,
};

export async function getOptionalProfileStats(
  userId: string,
  context: string
): Promise<ProfileStats> {
  try {
    const stats = await cachedDb.getUserProfileStats(userId);
    if (!stats) {
      logger.warn(
        'Profile stats unavailable; returning zero fallback',
        { userId },
        context
      );
      return EMPTY_PROFILE_STATS;
    }

    return stats;
  } catch (error) {
    logger.error(
      'Failed to fetch profile stats; returning zero fallback',
      {
        userId,
        error: error instanceof Error ? error.message : String(error),
      },
      context
    );
    return EMPTY_PROFILE_STATS;
  }
}

async function findVisibleUser(identifier: string, viewerId?: string) {
  const user = await findUserByIdentifier(identifier);
  return {
    user,
    excluded: user
      ? !(await canViewerReadAuthor(viewerId, user.id, user.isTest))
      : false,
  };
}

export async function getPublicUserProfile(
  identifier: string,
  viewerId?: string
) {
  const { user: dbUser, excluded } = await findVisibleUser(
    identifier,
    viewerId
  );
  if (!dbUser || excluded) return null;

  // Get cached profile stats (followers, following, posts, etc.)
  const stats = await getOptionalProfileStats(
    dbUser.id,
    'GET /api/users/[userId]/profile'
  );

  logger.info(
    'User profile fetched successfully',
    { userId: identifier, statsAvailable: Boolean(stats) },
    'GET /api/users/[userId]/profile'
  );

  return {
    id: dbUser.id,
    // Respect the owner's public visibility settings for linked identities.
    walletAddress: dbUser.showWalletPublic ? dbUser.walletAddress : null,
    username: dbUser.username,
    displayName: dbUser.displayName,
    bio: dbUser.bio,
    profileImageUrl: dbUser.profileImageUrl,
    coverImageUrl: dbUser.coverImageUrl,
    isActor: dbUser.isActor,
    isAgent: dbUser.isAgent,
    managedBy: dbUser.managedBy,
    profileComplete: dbUser.profileComplete,
    hasUsername: dbUser.hasUsername,
    hasBio: dbUser.hasBio,
    hasProfileImage: dbUser.hasProfileImage,
    nftTokenId: dbUser.nftTokenId,
    virtualBalance: Number(dbUser.virtualBalance ?? 0),
    lifetimePnL: Number(dbUser.lifetimePnL ?? 0),
    reputationPoints: dbUser.reputationPoints,
    earnedPoints: dbUser.earnedPoints,
    invitePoints: dbUser.invitePoints,
    bonusPoints: dbUser.bonusPoints,
    referralCount: dbUser.referralCount,
    referralCode: dbUser.referralCode,
    hasTwitter: dbUser.hasTwitter,
    twitterUsername: dbUser.showTwitterPublic ? dbUser.twitterUsername : null,
    usernameChangedAt: toISOOrNull(dbUser.usernameChangedAt),
    createdAt: toISO(dbUser.createdAt),
    stats,
  };
}

/** Explicit agent projection. Linked identities, credentials, internal flags,
 * incentives, and hidden character configuration never enter this DTO. */
export async function getPublicProfile(identifier: string, viewerId?: string) {
  const { user, excluded } = await findVisibleUser(identifier, viewerId);
  if (excluded) return null;
  const account = async (profile: NonNullable<typeof user>) => {
    // A just-updated viewer preference must not be read from a lagging replica.
    const [viewer] = viewerId
      ? await dbWrite
          .select({ mode: users.uiMode })
          .from(users)
          .where(eq(users.id, viewerId))
          .limit(1)
      : [];
    return {
      kind: profile.isActor ? 'character' : 'account',
      id: profile.id,
      handle: profile.username,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.profileImageUrl,
      ...(viewer?.mode === 'social'
        ? {}
        : {
            points: Number(profile.virtualBalance ?? 0),
            lifetimePnL: Number(profile.lifetimePnL ?? 0),
            currency: 'virtual points with no cash value',
          }),
    };
  };
  if (user && !user.isActor) return account(user);
  const lower = identifier.toLowerCase();
  const organization = StaticDataRegistry.getAllOrganizations().find(
    (org) => org.id === identifier || org.name.toLowerCase() === lower
  );
  if (organization) {
    if (!(await canViewerReadAuthor(viewerId, organization.id))) return null;
    return {
      kind: 'organization',
      id: organization.id,
      handle: organization.id,
      displayName: organization.name,
      bio: organization.description,
      avatarUrl: organization.imageUrl ?? null,
    };
  }
  const actor =
    StaticDataRegistry.getActor(identifier) ??
    StaticDataRegistry.getAllActors().find(
      (candidate) => candidate.name.toLowerCase() === lower
    );
  if (actor) {
    if (
      actor.isTest ||
      actor.id.startsWith('test-') ||
      !(await canViewerReadAuthor(viewerId, actor.id))
    )
      return null;
    return {
      kind: 'character',
      id: actor.id,
      handle: actor.username ?? actor.id,
      displayName: actor.name,
      bio: actor.profileDescription ?? actor.description ?? null,
      avatarUrl: actor.profileImageUrl ?? null,
    };
  }
  return user ? account(user) : null;
}
