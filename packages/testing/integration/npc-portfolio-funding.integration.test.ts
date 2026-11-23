/**
 * NPC portfolio funding: open perp positions must report mark P&L less
 * accrued funding, in the portfolio aggregates, in the listed positions,
 * and in the leaderboard fallback metrics.
 *
 * The stored PerpPosition.unrealizedPnL is price-only: funding accrues into
 * fundingPaid (PerpMarketService funding step) and is only settled into
 * realizedPnL at close. The perp trades route already nets it for open
 * positions (staging c1bd8a80: "Open perps report stored mark P&L less
 * accrued funding"), and so do the wallet PnL history, the trading
 * performance service, and the A2A feed executor — but
 * NPCInvestmentManager.getPortfolioMetrics, the leaderboard fallback
 * builder, and the NPC portfolio route's own positions list all still
 * report the raw stored value. An NPC holding an open perp that paid $40
 * of funding shows $40 too much unrealized P&L (and total value, and
 * leaderboard ROI) on its portfolio page.
 *
 * The only stub is the `server-only` marker package; the route, the metrics
 * service, and every database query run for real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

import {
	actorState,
	db,
	eq,
	gameOnboarding,
	inArray,
	perpPositions,
	poolPositions,
	pools,
	userPnLSnapshots,
	users,
	whitelist,
	whitelistConfig,
} from "@feed/db";
import { buildFallbackMetricsByPool, NPCInvestmentManager } from "@feed/engine";
import { generateSnowflakeId } from "@feed/shared";
import { NextRequest } from "next/server";

type PortfolioResponse = {
	success: boolean;
	portfolio: {
		totalValue: number;
		unrealizedPnL: number;
		realizedPnL: number;
		positionCount: number;
	};
	positions: Array<{
		id: string;
		marketType: string;
		ticker: string | null;
		marketId: string | null;
		side: string;
		size: number;
		unrealizedPnL: number;
	}>;
};

let GET: typeof import("../../../apps/web/src/app/api/npc/[actorId]/portfolio/route").GET;

// A snowflake id, so the route's identifier classification resolves it as a
// user id (the production shape for NPC user rows).
let actorId: string;
let predictionPositionId: string;
let perpPositionId: string;
let closedPerpPositionId: string;
let closedPoolPositionId: string;
// One documentation-range IPv6 per fixture, so this file's requests do not
// share CI's anonymous rate-limit bucket with unrelated route tests (the
// limiter stays enabled — see the 429 note on fetchPortfolio).
// 1662 is unused by the sibling fixtures (1656, 1660, 1661).
let clientIp: string;

// Ownership ledger: only rows this file actually inserted — proven by each
// INSERT's RETURNING clause — may be deleted in afterAll.
const owned = {
	user: false,
	actorState: false,
	pool: false,
	poolPositionIds: [] as string[],
	perpPositionIds: [] as string[],
};

async function fetchPortfolio() {
	const request = new NextRequest(
		new Request(`http://localhost/api/npc/${actorId}/portfolio`, {
			headers: { "x-forwarded-for": clientIp },
		}),
	);
	const response = await GET(request, {
		params: Promise.resolve({ actorId }),
	});
	const body = (await response.json().catch(() => null)) as
		| PortfolioResponse
		| { error?: unknown }
		| null;
	return { status: response.status, body };
}

beforeAll(async () => {
	({ GET } = await import(
		"../../../apps/web/src/app/api/npc/[actorId]/portfolio/route"
	));

	[
		actorId,
		predictionPositionId,
		perpPositionId,
		closedPerpPositionId,
		closedPoolPositionId,
	] = await Promise.all([
		generateSnowflakeId(),
		generateSnowflakeId(),
		generateSnowflakeId(),
		generateSnowflakeId(),
		generateSnowflakeId(),
	]);

	const hexGroups = BigInt(actorId)
		.toString(16)
		.padStart(16, "0")
		.match(/.{4}/g);
	if (!hexGroups) {
		throw new Error("unreachable: actor id hex grouping");
	}
	clientIp = `2001:db8:1662:0:${hexGroups.join(":")}`;

	const now = new Date();
	const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60_000);
	const oneHourAgo = new Date(now.getTime() - 60 * 60_000);

	// Collision control: refuse to run — and therefore to clean anything up —
	// if any fixture id already exists.
	const [
		existingUsers,
		existingActorStates,
		existingPools,
		existingPoolPositions,
		existingPerpPositions,
	] = await Promise.all([
		db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.id, actorId))
			.limit(1),
		db
			.select({ id: actorState.id })
			.from(actorState)
			.where(eq(actorState.id, actorId))
			.limit(1),
		db
			.select({ id: pools.id })
			.from(pools)
			.where(eq(pools.id, actorId))
			.limit(1),
		db
			.select({ id: poolPositions.id })
			.from(poolPositions)
			.where(
				inArray(poolPositions.id, [predictionPositionId, closedPoolPositionId]),
			)
			.limit(1),
		db
			.select({ id: perpPositions.id })
			.from(perpPositions)
			.where(inArray(perpPositions.id, [perpPositionId, closedPerpPositionId]))
			.limit(1),
	]);
	if (
		existingUsers.length > 0 ||
		existingActorStates.length > 0 ||
		existingPools.length > 0 ||
		existingPoolPositions.length > 0 ||
		existingPerpPositions.length > 0
	) {
		throw new Error(
			`fixture collision for actor ${actorId}: fixture ids already exist; refusing to overwrite pre-existing data`,
		);
	}

	const insertedUser = await db
		.insert(users)
		.values({
			id: actorId,
			username: `f43npc-${actorId}`,
			displayName: "F43 Portfolio Funding NPC",
			isActor: true,
			updatedAt: now,
		})
		.returning({ id: users.id });
	owned.user = insertedUser.length > 0;

	const insertedActorState = await db
		.insert(actorState)
		.values({
			id: actorId,
			tradingBalance: "10000",
			reputationPoints: 1000,
			hasPool: true,
			updatedAt: now,
		})
		.returning({ id: actorState.id });
	owned.actorState = insertedActorState.length > 0;

	const insertedPool = await db
		.insert(pools)
		.values({
			id: actorId,
			npcActorId: actorId,
			name: "F43 Portfolio Funding Pool",
			totalValue: "10000",
			totalDeposits: "10000",
			availableBalance: "10000",
			lifetimePnL: "0",
			performanceFeeRate: 0.05,
			totalFeesCollected: "0",
			isActive: true,
			status: "ACTIVE",
			updatedAt: now,
		})
		.returning({ id: pools.id });
	owned.pool = insertedPool.length > 0;

	// One open prediction position, unrealized +40 (no funding: untouched).
	const insertedPrediction = await db
		.insert(poolPositions)
		.values({
			id: predictionPositionId,
			poolId: actorId,
			marketType: "prediction",
			marketId: "f43-market-1",
			side: "YES",
			size: 200,
			entryPrice: 0.5,
			currentPrice: 0.6,
			unrealizedPnL: 40,
			openedAt: twoHoursAgo,
			closedAt: null,
			updatedAt: now,
		})
		.returning({ id: poolPositions.id });
	owned.poolPositionIds.push(...insertedPrediction.map((row) => row.id));

	// One open perp position: stored mark P&L +500, accrued funding paid 40,
	// so the net open P&L is +460.
	const insertedPerp = await db
		.insert(perpPositions)
		.values({
			id: perpPositionId,
			userId: actorId,
			ticker: "NVDAI",
			organizationId: "f43-org",
			side: "long",
			size: 5000,
			leverage: 5,
			entryPrice: 100,
			currentPrice: 110,
			liquidationPrice: 80,
			unrealizedPnL: 500,
			unrealizedPnLPercent: 10,
			fundingPaid: 40,
			openedAt: oneHourAgo,
			lastUpdated: now,
			closedAt: null,
		})
		.returning({ id: perpPositions.id });
	owned.perpPositionIds.push(...insertedPerp.map((row) => row.id));

	// Guard: a closed perp settles funding into realizedPnL at close, so its
	// realized value must be reported untouched.
	const insertedClosedPerp = await db
		.insert(perpPositions)
		.values({
			id: closedPerpPositionId,
			userId: actorId,
			ticker: "NVDAI",
			organizationId: "f43-org",
			side: "long",
			size: 3000,
			leverage: 5,
			entryPrice: 90,
			currentPrice: 95,
			liquidationPrice: 70,
			unrealizedPnL: 0,
			unrealizedPnLPercent: 0,
			fundingPaid: 40,
			openedAt: twoHoursAgo,
			lastUpdated: now,
			closedAt: oneHourAgo,
			realizedPnL: 250,
		})
		.returning({ id: perpPositions.id });
	owned.perpPositionIds.push(...insertedClosedPerp.map((row) => row.id));

	const insertedClosedPool = await db
		.insert(poolPositions)
		.values({
			id: closedPoolPositionId,
			poolId: actorId,
			marketType: "prediction",
			marketId: "f43-market-2",
			side: "NO",
			size: 100,
			entryPrice: 0.4,
			currentPrice: 0.4,
			unrealizedPnL: 0,
			openedAt: twoHoursAgo,
			closedAt: oneHourAgo,
			realizedPnL: -30,
			updatedAt: now,
		})
		.returning({ id: poolPositions.id });
	owned.poolPositionIds.push(...insertedClosedPool.map((row) => row.id));
});

/**
 * Delete only rows this file proved it inserted (RETURNING ids above),
 * positions before their owner rows. Same foreign-row refusal discipline
 * as the sibling npc-portfolio-perp-positions fixture.
 */
async function cleanupOwnedFixtures(): Promise<void> {
	await db.transaction(async (tx) => {
		if (owned.user) {
			const [lockedUser] = await tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.id, actorId))
				.limit(1)
				.for("update");
			if (lockedUser) {
				const [
					foreignOnboarding,
					foreignSnapshot,
					foreignWhitelist,
					foreignWhitelistGranter,
					foreignWhitelistConfigUpdater,
				] = await Promise.all([
					tx
						.select({
							id: gameOnboarding.id,
							userId: gameOnboarding.userId,
						})
						.from(gameOnboarding)
						.where(eq(gameOnboarding.userId, actorId))
						.limit(1),
					tx
						.select({
							id: userPnLSnapshots.id,
							userId: userPnLSnapshots.userId,
						})
						.from(userPnLSnapshots)
						.where(eq(userPnLSnapshots.userId, actorId))
						.limit(1),
					tx
						.select({ id: whitelist.id, userId: whitelist.userId })
						.from(whitelist)
						.where(eq(whitelist.userId, actorId))
						.limit(1),
					tx
						.select({ id: whitelist.id, grantedBy: whitelist.grantedBy })
						.from(whitelist)
						.where(eq(whitelist.grantedBy, actorId))
						.limit(1),
					tx
						.select({
							id: whitelistConfig.id,
							updatedBy: whitelistConfig.updatedBy,
						})
						.from(whitelistConfig)
						.where(eq(whitelistConfig.updatedBy, actorId))
						.limit(1),
				]);
				const foreign =
					foreignOnboarding[0] !== undefined
						? { label: "GameOnboarding", ...foreignOnboarding[0] }
						: foreignSnapshot[0] !== undefined
							? { label: "UserPnLSnapshot", ...foreignSnapshot[0] }
							: foreignWhitelist[0] !== undefined
								? { label: "Whitelist", ...foreignWhitelist[0] }
								: foreignWhitelistGranter[0] !== undefined
									? {
											label: "Whitelist.grantedBy",
											id: foreignWhitelistGranter[0].id,
											userId: foreignWhitelistGranter[0].grantedBy,
										}
									: foreignWhitelistConfigUpdater[0] !== undefined
										? {
												label: "WhitelistConfig.updatedBy",
												id: foreignWhitelistConfigUpdater[0].id,
												userId: foreignWhitelistConfigUpdater[0].updatedBy,
											}
										: null;
				if (foreign) {
					throw new Error(
						`cleanup refused: ${foreign.label} ${foreign.id} still references owned user ${foreign.userId}`,
					);
				}
			}
		}
		if (owned.poolPositionIds.length > 0) {
			await tx
				.delete(poolPositions)
				.where(inArray(poolPositions.id, owned.poolPositionIds));
		}
		if (owned.perpPositionIds.length > 0) {
			await tx
				.delete(perpPositions)
				.where(inArray(perpPositions.id, owned.perpPositionIds));
		}
		if (owned.pool) {
			await tx.delete(pools).where(eq(pools.id, actorId));
		}
		if (owned.actorState) {
			await tx.delete(actorState).where(eq(actorState.id, actorId));
		}
		if (owned.user) {
			await tx.delete(users).where(eq(users.id, actorId));
		}
	});
}

afterAll(async () => {
	await cleanupOwnedFixtures();
});

describe("NPC portfolio funding: open perp P&L nets accrued funding", () => {
	it("nets fundingPaid from the portfolio aggregates", async () => {
		const metrics = await NPCInvestmentManager.getPortfolioMetrics(actorId);

		// Unrealized: 40 (prediction) + (500 - 40) (open perp) = 500.
		expect(metrics.unrealizedPnL).toBeCloseTo(500, 6);
		// Total value: 10000 balance + (200 + 5000/5) invested + 500 = 11700.
		expect(metrics.totalValue).toBeCloseTo(11700, 6);
		// Realized is untouched: 250 (closed perp) + (-30) (closed pool) = 220.
		expect(metrics.realizedPnL).toBeCloseTo(220, 6);
		expect(metrics.positionCount).toBe(2);
	});

	it("nets fundingPaid in the listed positions, matching the aggregates", async () => {
		const { status, body } = await fetchPortfolio();
		expect(status).toBe(200);
		const res = body as PortfolioResponse;

		expect(res.portfolio.unrealizedPnL).toBeCloseTo(500, 6);
		expect(res.portfolio.totalValue).toBeCloseTo(11700, 6);

		const perp = res.positions.find((p) => p.id === perpPositionId);
		expect(perp).toBeDefined();
		expect(perp?.unrealizedPnL).toBeCloseTo(460, 6);

		const listedUnrealized = res.positions.reduce(
			(sum, p) => sum + p.unrealizedPnL,
			0,
		);
		expect(listedUnrealized).toBeCloseTo(res.portfolio.unrealizedPnL, 6);
	});

	it("nets fundingPaid in the leaderboard fallback metrics", () => {
		const byPool = buildFallbackMetricsByPool(
			[{ id: actorId }],
			[{ id: actorId, tradingBalance: "10000" }],
			[
				{
					id: predictionPositionId,
					poolId: actorId,
					marketType: "prediction",
					size: 200,
					leverage: null,
					unrealizedPnL: 40,
					realizedPnL: null,
					closedAt: null,
				},
				{
					id: closedPoolPositionId,
					poolId: actorId,
					marketType: "prediction",
					size: 100,
					leverage: null,
					unrealizedPnL: 0,
					realizedPnL: -30,
					closedAt: new Date(),
				},
			],
			[
				{
					id: perpPositionId,
					userId: actorId,
					size: 5000,
					leverage: 5,
					unrealizedPnL: 500,
					realizedPnL: null,
					fundingPaid: 40,
					closedAt: null,
				},
				{
					id: closedPerpPositionId,
					userId: actorId,
					size: 3000,
					leverage: 5,
					unrealizedPnL: 0,
					realizedPnL: 250,
					fundingPaid: 40,
					closedAt: new Date(),
				},
			],
		);

		const metrics = byPool.get(actorId);
		expect(metrics).toBeDefined();
		expect(metrics?.unrealizedPnL).toBeCloseTo(500, 6);
		expect(metrics?.realizedPnL).toBeCloseTo(220, 6);
		expect(metrics?.totalValue).toBeCloseTo(11700, 6);
		expect(metrics?.positionCount).toBe(2);
	});
});
