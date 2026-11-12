/**
 * Post Embed API
 *
 * @route GET /api/embed/post/[id] - Get post embed metadata
 * @access Public
 *
 * @description
 * Returns embed metadata for post sharing. Includes post content,
 * author info, interaction counts, and Open Graph data for rich link previews.
 *
 * @openapi
 * /api/embed/post/{id}:
 *   get:
 *     tags:
 *       - Embed
 *     summary: Get post embed metadata
 *     description: Returns embed metadata for post sharing (Open Graph)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Post ID
 *     responses:
 *       200:
 *         description: Embed metadata retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   example: post
 *                 version:
 *                   type: string
 *                   example: "1"
 *                 url:
 *                   type: string
 *                 title:
 *                   type: string
 *                 description:
 *                   type: string
 *                 author:
 *                   type: object
 *                   properties:
 *                     name:
 *                       type: string
 *                     username:
 *                       type: string
 *                       nullable: true
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     likeCount:
 *                       type: integer
 *                     commentCount:
 *                       type: integer
 *                     shareCount:
 *                       type: integer
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                 image:
 *                   type: string
 *       404:
 *         description: Post not found
 *
 * @example
 * ```typescript
 * const metadata = await fetch(`/api/embed/post/${postId}`)
 *   .then(r => r.json());
 * ```
 *
 */

import { withErrorHandling } from '@feed/api';
import { db } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { getBaseUrl, PostIdParamSchema, toISO } from '@feed/shared';
import { type NextRequest, NextResponse } from 'next/server';

export const GET = withErrorHandling(async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id: postId } = PostIdParamSchema.parse(await context.params);

  // Fetch post data
  const post = await db.post.findUnique({
    where: { id: postId },
    select: {
      id: true,
      content: true,
      type: true,
      articleTitle: true,
      authorId: true,
      timestamp: true,
      deletedAt: true,
    },
  });

  // Deleted and not-yet-published (scheduled) posts are not embeddable.
  if (!post || post.deletedAt || post.timestamp > new Date()) {
    return NextResponse.json({ error: 'Post not found' }, { status: 404 });
  }

  // Get interaction counts
  const [likeCount, commentRows, shareCount] = await Promise.all([
    db.reaction.count({ where: { postId, type: 'like' } }),
    db.comment.findMany({
      where: { postId, deletedAt: null },
      select: { id: true, parentCommentId: true },
    }),
    db.share.count({ where: { postId } }),
  ]);

  // Count only the comments the comment thread can actually show. That
  // thread omits replies whose parent is not visible (e.g. a parent
  // soft-deleted by moderation takes its whole subtree out of the tree),
  // so count the comments reachable from a top-level comment, mirroring
  // the tree rule in GET /api/posts/[id]/comments.
  const childrenByParent = new Map<string | null, string[]>();
  for (const row of commentRows) {
    const siblings = childrenByParent.get(row.parentCommentId);
    if (siblings) siblings.push(row.id);
    else childrenByParent.set(row.parentCommentId, [row.id]);
  }
  let commentCount = 0;
  const stack = [...(childrenByParent.get(null) ?? [])];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || visited.has(id)) continue;
    visited.add(id);
    commentCount += 1;
    stack.push(...(childrenByParent.get(id) ?? []));
  }

  // Get author info - could be User, Actor, or Organization
  let authorName = 'Unknown';
  let authorUsername: string | null = null;

  // Try to find user author
  const userAuthor = await db.user.findUnique({
    where: { id: post.authorId },
    select: { displayName: true, username: true },
  });

  if (userAuthor) {
    authorName = userAuthor.displayName || userAuthor.username || 'Unknown';
    authorUsername = userAuthor.username || null;
  } else {
    // Check for actor in static registry
    const actor = StaticDataRegistry.getActor(post.authorId);

    if (actor) {
      authorName = actor.name;
    } else {
      // Check for organization in static registry
      const org = StaticDataRegistry.getOrganization(post.authorId);

      if (org) {
        authorName = org.name;
      }
    }
  }

  const baseUrl = getBaseUrl();
  const postUrl = `${baseUrl}/post/${postId}`;

  // Truncate content for preview
  // Truncate by code points so surrogate pairs (emoji) are not split
  const codePoints = Array.from(post.content);
  const previewText =
    codePoints.length > 200
      ? `${codePoints.slice(0, 200).join('')}...`
      : post.content;

  const title =
    post.type === 'article' && post.articleTitle
      ? post.articleTitle
      : `${authorName} on Feed`;

  // Return embed metadata
  return NextResponse.json({
    type: 'post',
    version: '1',
    url: postUrl,
    title,
    description: previewText,
    author: {
      name: authorName,
      username: authorUsername,
    },
    metadata: {
      likeCount,
      commentCount,
      shareCount,
      timestamp: toISO(post.timestamp),
    },
    image: `${baseUrl}/assets/images/og-image.png`,
  });
});
