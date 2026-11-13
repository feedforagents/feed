/**
 * Post challenges must count only posts that still exist.
 *
 * A post deleted by its author (soft delete — `Post.deletedAt` is set by
 * DELETE /api/posts/[id]) is not a post anywhere else in the product:
 * feed and profile reads filter `deletedAt IS NULL`, and the comment
 * challenge resolvers in the same service already exclude deleted
 * comments. The post challenge resolvers must apply the same rule, or a
 * user whose posts are all deleted still completes "create a post"
 * challenges and collects the reward.
 *
 * Challenge selection rotates deterministically by period, so this test
 * exercises whichever post challenge is active in the run period
 * (daily_create_post or weekly_three_posts) and returns early when
 * neither is active.
 *
 * Requires DATABASE_URL pointing at a disposable database with schema applied.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { checkProgress, getUserChallenges } from '@feed/api';
import {
  db,
  eq,
  pointsTransactions,
  posts,
  userChallengeProgress,
  users,
} from '@feed/db';
import { generateSnowflakeId } from '@feed/shared';

interface ActivePostChallenge {
  id: string;
  threshold: number;
  pointsReward: number;
  pool: 'daily' | 'weekly';
}

const POST_CHALLENGE_IDS = ['daily_create_post', 'weekly_three_posts'];

let activeDef: ActivePostChallenge | null = null;
const createdUsers: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const id = await generateSnowflakeId();
  createdUsers.push(id);
  await db.insert(users).values({
    id,
    username: `chp${tag}_${id.slice(-8)}`,
    isActor: false,
    reputationPoints: 0,
    updatedAt: new Date(),
  });
  return id;
}

async function makePost(authorId: string, deleted: boolean): Promise<void> {
  const id = await generateSnowflakeId();
  await db.insert(posts).values({
    id,
    content: 'challenge post progress test',
    authorId,
    timestamp: new Date(),
  });
  if (deleted) {
    // Mirror DELETE /api/posts/[id]: a soft delete via deletedAt.
    await db
      .update(posts)
      .set({ deletedAt: new Date() })
      .where(eq(posts.id, id));
  }
}

async function displayedProgress(
  userId: string,
  def: ActivePostChallenge
): Promise<number> {
  const res = await getUserChallenges(userId);
  const list =
    def.pool === 'daily' ? res.daily.challenges : res.weekly.challenges;
  return list.find((c) => c.id === def.id)?.progress ?? -1;
}

async function progressRow(userId: string, challengeId: string) {
  const rows = await db
    .select()
    .from(userChallengeProgress)
    .where(eq(userChallengeProgress.userId, userId));
  return rows.find((r) => r.challengeId === challengeId);
}

describe('challenge post progress counts only live posts', () => {
  beforeAll(async () => {
    // Find the post challenge active in this run's period, if any.
    const scout = await makeUser('scout');
    const res = await getUserChallenges(scout);
    for (const c of [...res.daily.challenges, ...res.weekly.challenges]) {
      if (POST_CHALLENGE_IDS.includes(c.id)) {
        activeDef = {
          id: c.id,
          threshold: c.threshold,
          pointsReward: c.pointsReward,
          pool: res.daily.challenges.some((d) => d.id === c.id)
            ? 'daily'
            : 'weekly',
        };
        break;
      }
    }
  });

  afterAll(async () => {
    for (const uid of createdUsers) {
      await db.delete(posts).where(eq(posts.authorId, uid));
      await db
        .delete(userChallengeProgress)
        .where(eq(userChallengeProgress.userId, uid));
      await db
        .delete(pointsTransactions)
        .where(eq(pointsTransactions.userId, uid));
      await db.delete(users).where(eq(users.id, uid));
    }
  });

  it('a user whose posts are all deleted shows 0 progress and cannot complete', async () => {
    if (!activeDef) return;
    const uid = await makeUser('del');
    for (let i = 0; i < activeDef.threshold; i++) {
      await makePost(uid, true);
    }

    expect(await displayedProgress(uid, activeDef)).toBe(0);

    await checkProgress(uid, { type: 'post_created' }, { failOnError: true });
    const row = await progressRow(uid, activeDef.id);
    expect(row?.completed ?? 0).toBe(0);

    const [u] = await db
      .select({ reputationPoints: users.reputationPoints })
      .from(users)
      .where(eq(users.id, uid));
    expect(u?.reputationPoints).toBe(0);
  });

  it('deleted posts do not top up live posts toward the threshold', async () => {
    if (!activeDef) return;
    const uid = await makeUser('mix');
    for (let i = 0; i < activeDef.threshold; i++) {
      await makePost(uid, true);
    }
    await makePost(uid, false);

    expect(await displayedProgress(uid, activeDef)).toBe(1);

    await checkProgress(uid, { type: 'post_created' }, { failOnError: true });
    const row = await progressRow(uid, activeDef.id);
    expect(row?.completed ?? 0).toBe(0);
  });

  it('a user with enough live posts still completes and is rewarded', async () => {
    if (!activeDef) return;
    const uid = await makeUser('live');
    for (let i = 0; i < activeDef.threshold; i++) {
      await makePost(uid, false);
    }

    expect(await displayedProgress(uid, activeDef)).toBe(activeDef.threshold);

    await checkProgress(uid, { type: 'post_created' }, { failOnError: true });
    const row = await progressRow(uid, activeDef.id);
    expect(row?.completed).toBe(1);
    expect(row?.pointsAwarded).toBe(activeDef.pointsReward);

    const [u] = await db
      .select({ reputationPoints: users.reputationPoints })
      .from(users)
      .where(eq(users.id, uid));
    expect(u?.reputationPoints).toBe(activeDef.pointsReward);
  });
});
