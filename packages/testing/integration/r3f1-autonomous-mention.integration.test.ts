/**
 * R3-F1: autonomous agent writes do not notify @mentioned users.
 *
 * Web posts/comments notify mentions (POST /api/posts, POST
 * /api/posts/[id]/comments: inline /@(\w+)/ parse + notifyMention), and
 * open #2048 extends the same rule to MCP and A2A writes. The autonomous
 * write paths — the ElizaOS plugin-agent-core CREATE_POST / CREATE_COMMENT
 * actions and DirectExecutors executeDirectPost / executeDirectComment —
 * insert the post/comment and never notify anyone named in the text, so a
 * user an agent mentions never learns about it.
 *
 * Base repro: each of the four real handlers is called with content that
 * names a real user via @username; the notifications table must hold one
 * 'mention' row for that user — on base it holds zero.
 */
import assert from "node:assert/strict";
import { afterAll, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { comments, db, eq, notifications, posts, users } = await import(
	"@feed/db"
);
const { generateSnowflakeId } = await import("@feed/shared");
const { notifyMention } = await import("@feed/api");
const { createPostAction } = await import(
	"../../agents/src/plugins/plugin-agent-core/src/actions/create-post"
);
const { createCommentAction } = await import(
	"../../agents/src/plugins/plugin-agent-core/src/actions/create-comment"
);
const { executeDirectComment, executeDirectPost } = await import(
	"../../agents/src/autonomous/DirectExecutors"
);

const suffix = (await generateSnowflakeId()).slice(-8);
const agentId = await generateSnowflakeId();
const victimId = await generateSnowflakeId();
const posterId = await generateSnowflakeId();
const targetPostId = await generateSnowflakeId();
const targetPostId2 = await generateSnowflakeId();
const agentUsername = `r3f1agent${suffix}`;
const victimUsername = `r3f1victim${suffix}`;

const createdPostIds: string[] = [];
const createdCommentIds: string[] = [];

await db.insert(users).values([
	{
		id: agentId,
		username: agentUsername,
		displayName: "R3F1 agent",
		updatedAt: new Date(),
	},
	{
		id: victimId,
		username: victimUsername,
		displayName: "R3F1 victim",
		updatedAt: new Date(),
	},
	{
		id: posterId,
		username: `r3f1poster${suffix}`,
		displayName: "R3F1 poster",
		updatedAt: new Date(),
	},
]);
await db.insert(posts).values([
	{
		id: targetPostId,
		authorId: posterId,
		content: "R3F1 comment target post",
		timestamp: new Date(Date.now() - 60_000),
	},
	{
		id: targetPostId2,
		authorId: posterId,
		content: "R3F1 comment target post 2",
		timestamp: new Date(Date.now() - 60_000),
	},
]);
createdPostIds.push(targetPostId, targetPostId2);

afterAll(async () => {
	await db.delete(notifications).where(eq(notifications.userId, victimId));
	for (const id of createdCommentIds) {
		await db.delete(comments).where(eq(comments.id, id));
	}
	for (const id of createdPostIds) {
		await db.delete(posts).where(eq(posts.id, id));
	}
	await db.delete(users).where(eq(users.id, agentId));
	await db.delete(users).where(eq(users.id, victimId));
	await db.delete(users).where(eq(users.id, posterId));
	await db.$disconnect();
});

async function mentionCount(): Promise<number> {
	const rows = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(eq(notifications.userId, victimId));
	return rows.length;
}

const mentionText = (label: string) =>
	`${label} @${victimUsername} take a look at this market`;

test("plugin CREATE_POST notifies a mentioned user", async () => {
	const before = await mentionCount();
	const content = mentionText("plugin-post");
	const result = await createPostAction.handler(
		{ agentId } as never,
		{} as never,
		{ data: { actionParams: { content } } } as never,
	);
	assert(result, "CREATE_POST handler returned nothing");
	expect(result.success).toBe(true);
	const postId = (result.data as { postId?: string } | undefined)?.postId;
	expect(postId).toBeDefined();
	if (postId) createdPostIds.push(postId);
	expect(await mentionCount()).toBe(before + 1);
});

test("plugin CREATE_COMMENT notifies a mentioned user", async () => {
	const before = await mentionCount();
	const content = mentionText("plugin-comment");
	const result = await createCommentAction.handler(
		{ agentId } as never,
		{} as never,
		{
			data: {
				actionParams: { postId: targetPostId, content },
			},
		} as never,
	);
	assert(result, "CREATE_COMMENT handler returned nothing");
	expect(result.success).toBe(true);
	const commentId = (result.data as { commentId?: string } | undefined)
		?.commentId;
	expect(commentId).toBeDefined();
	if (commentId) createdCommentIds.push(commentId);
	expect(await mentionCount()).toBe(before + 1);
});

test("executeDirectPost notifies a mentioned user", async () => {
	const before = await mentionCount();
	const content = mentionText("direct-post");
	const result = await executeDirectPost({ agentUserId: agentId, content });
	expect(result.success).toBe(true);
	expect(result.postId).toBeDefined();
	if (result.postId) createdPostIds.push(result.postId);
	expect(await mentionCount()).toBe(before + 1);
});

test("executeDirectComment notifies a mentioned user", async () => {
	const before = await mentionCount();
	const content = mentionText("direct-comment");
	const result = await executeDirectComment({
		agentUserId: agentId,
		postId: targetPostId2,
		content,
	});
	expect(result.success).toBe(true);
	expect(result.commentId).toBeDefined();
	if (result.commentId) createdCommentIds.push(result.commentId);
	expect(await mentionCount()).toBe(before + 1);
});

test("control: notifyMention itself writes a detectable row", async () => {
	const before = await mentionCount();
	await notifyMention(victimId, posterId, targetPostId);
	expect(await mentionCount()).toBe(before + 1);
});
