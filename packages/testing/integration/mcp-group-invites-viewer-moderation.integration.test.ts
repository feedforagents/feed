/** PRD §§8.1 and 12, MVP Phases 3 and 5: invite visibility follows viewer moderation. */
import { expect, test } from 'bun:test';
import {
  runIsolatedSubMarketCases,
  verifySubMarketChildLease,
} from './helpers/sub-market-isolation';

const moderatedCase =
  'MCP hides invites from blocked, muted and blocked-by inviters';
const unrelatedCase = 'MCP returns all invites for an unrelated viewer';

if (!process.env.FEED_SUB_MARKET_CHILD) {
  test('checks MCP invite visibility in a leased database', async () => {
    await runIsolatedSubMarketCases({
      name: 'mcp-group-invite-visibility',
      file: 'packages/testing/integration/mcp-group-invites-viewer-moderation.integration.test.ts',
      cases: [moderatedCase, unrelatedCase],
    });
  }, 300_000);
} else {
  await verifySubMarketChildLease();
  const { db, groupInvites, groups, userBlocks, userMutes, users } =
    await import('@feed/db');
  const { generateSnowflakeId } = await import('@feed/shared');
  const { executeGetGroupInvites } = await import(
    '../../mcp/src/handlers/tool-handlers'
  );

  const [
    viewerId,
    unrelatedViewerId,
    ordinaryInviterId,
    blockedInviterId,
    mutedInviterId,
    blockingInviterId,
  ] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ] as const);
  const inviterIds = [
    ordinaryInviterId,
    blockedInviterId,
    mutedInviterId,
    blockingInviterId,
  ];

  async function groupForInviter(inviterId: string) {
    const [groupId, viewerInviteId, unrelatedInviteId] = await Promise.all([
      generateSnowflakeId(),
      generateSnowflakeId(),
      generateSnowflakeId(),
    ] as const);
    return { inviterId, groupId, viewerInviteId, unrelatedInviteId };
  }

  const allowed = await groupForInviter(ordinaryInviterId);
  const invitations = [
    allowed,
    ...(await Promise.all(inviterIds.slice(1).map(groupForInviter))),
  ];
  const [viewerBlockId, blockedById, muteId] = await Promise.all([
    generateSnowflakeId(),
    generateSnowflakeId(),
    generateSnowflakeId(),
  ] as const);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(users).values(
      [viewerId, unrelatedViewerId, ...inviterIds].map((id) => ({
        id,
        username: `invite-list-${id}`,
        updatedAt: now,
      }))
    );
    await tx.insert(userBlocks).values([
      { id: viewerBlockId, blockerId: viewerId, blockedId: blockedInviterId },
      { id: blockedById, blockerId: blockingInviterId, blockedId: viewerId },
    ]);
    await tx.insert(userMutes).values({
      id: muteId,
      muterId: viewerId,
      mutedId: mutedInviterId,
    });
    await tx.insert(groups).values(
      invitations.map(({ groupId, inviterId }) => ({
        id: groupId,
        name: `Invite fixture ${groupId}`,
        type: 'user' as const,
        ownerId: inviterId,
        createdById: inviterId,
        updatedAt: now,
      }))
    );
    await tx.insert(groupInvites).values(
      invitations.flatMap(
        ({ groupId, inviterId, viewerInviteId, unrelatedInviteId }) => [
          {
            id: viewerInviteId,
            groupId,
            invitedUserId: viewerId,
            invitedBy: inviterId,
            status: 'pending' as const,
            invitedAt: now,
          },
          {
            id: unrelatedInviteId,
            groupId,
            invitedUserId: unrelatedViewerId,
            invitedBy: inviterId,
            status: 'pending' as const,
            invitedAt: now,
          },
        ]
      )
    );
  });

  async function inviteIdsFor(userId: string) {
    const { invites } = await executeGetGroupInvites(
      { agentId: 'agent', userId },
      {}
    );
    return invites.map(({ id }) => id).sort();
  }

  test(moderatedCase, async () => {
    expect(await inviteIdsFor(viewerId)).toEqual([allowed.viewerInviteId]);
  });

  test(unrelatedCase, async () => {
    expect(await inviteIdsFor(unrelatedViewerId)).toEqual(
      invitations.map(({ unrelatedInviteId }) => unrelatedInviteId).sort()
    );
  });
}
