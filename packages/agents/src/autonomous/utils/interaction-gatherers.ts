/**
 * Interaction Gathering Utilities
 *
 * Gathers pending interactions (comments, chat messages) with full context
 * for agent decision making.
 */

import {
  and,
  chatParticipants,
  chats,
  comments,
  db,
  desc,
  eq,
  groups,
  gte,
  inArray,
  isNull,
  lte,
  messages,
  ne,
  or,
  posts,
  users,
} from '@feed/db';
import type {
  PendingChatMessage,
  PendingCommentReply,
  PostInfo,
  ThreadMessage,
} from '../templates/multi-step-decision';

// =============================================================================
// Constants
// =============================================================================

const INTERACTION_WINDOW_HOURS = 24;
const MAX_THREAD_DEPTH = 10;
const MAX_COMMENTS_PER_QUERY = 500;

// =============================================================================
// Comment Reply Gathering
// =============================================================================

/**
 * Gather pending comment replies with full thread context
 */
export async function gatherPendingCommentReplies(
  agentUserId: string
): Promise<PendingCommentReply[]> {
  const interactions: PendingCommentReply[] = [];
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - INTERACTION_WINDOW_HOURS * 60 * 60 * 1000
  );

  // Get agent's recent posts
  const agentPosts = await db
    .select({ id: posts.id })
    .from(posts)
    .where(
      and(
        eq(posts.authorId, agentUserId),
        isNull(posts.deletedAt),
        gte(posts.createdAt, windowStart)
      )
    );
  const agentPostIds = new Set(agentPosts.map((p) => p.id));

  // Get posts where agent recently commented
  const agentCommentPosts = await db
    .selectDistinct({ postId: comments.postId })
    .from(comments)
    .where(
      and(
        eq(comments.authorId, agentUserId),
        gte(comments.createdAt, windowStart)
      )
    );
  const commentedPostIds = new Set(
    agentCommentPosts.map((c) => c.postId).filter((id) => !agentPostIds.has(id))
  );

  const relevantPostIds = [...agentPostIds, ...commentedPostIds];
  if (relevantPostIds.length === 0) return interactions;

  // Fetch all comments on relevant posts
  const allCommentsRaw = await db.query.comments.findMany({
    where: and(
      inArray(comments.postId, relevantPostIds),
      isNull(comments.deletedAt),
      lte(comments.createdAt, now)
    ),
    with: {
      author: {
        columns: { id: true, username: true, displayName: true },
      },
      post: {
        columns: { id: true, content: true, authorId: true, deletedAt: true },
        with: {
          User: {
            columns: { id: true, username: true, displayName: true },
          },
        },
      },
    },
    orderBy: [desc(comments.createdAt)],
    limit: MAX_COMMENTS_PER_QUERY,
  });

  // Build maps for efficient lookup
  type CommentWithRelations = (typeof allCommentsRaw)[number];
  const commentMap = new Map<string, CommentWithRelations>(
    allCommentsRaw.map((c) => [c.id, c])
  );
  const childrenMap = new Map<string, CommentWithRelations[]>();
  for (const comment of allCommentsRaw) {
    if (comment.parentCommentId) {
      const siblings = childrenMap.get(comment.parentCommentId) || [];
      siblings.push(comment);
      childrenMap.set(comment.parentCommentId, siblings);
    }
  }

  // Find comments needing response
  for (const comment of allCommentsRaw) {
    if (comment.authorId === agentUserId) continue;
    if (!comment.post) continue;
    if (comment.post.deletedAt) continue;
    if (comment.parentCommentId && !commentMap.has(comment.parentCommentId))
      continue;

    // Skip if agent already replied
    const replies = childrenMap.get(comment.id) || [];
    if (replies.some((r) => r.authorId === agentUserId)) continue;

    // Check if agent should respond
    const isOnAgentPost = agentPostIds.has(comment.postId);
    const agentInAncestors = hasAgentInAncestors(
      comment,
      commentMap,
      agentUserId
    );
    if (!isOnAgentPost && !agentInAncestors) continue;

    // Build thread context
    const thread = buildThreadFromBottom(comment, commentMap, agentUserId);

    // Build post info
    const postAuthor = comment.post.User;
    const isYourPost = comment.post.authorId === agentUserId;
    const post: PostInfo = {
      id: comment.post.id,
      content: comment.post.content,
      authorName: isYourPost
        ? 'You'
        : formatUserName(postAuthor?.displayName, postAuthor?.username),
      isYourPost,
    };

    // Format context for prompt
    const formattedContext = formatThreadForPrompt(post, thread);

    interactions.push({
      id: comment.id,
      postId: comment.postId,
      author: formatUserName(
        comment.author?.displayName,
        comment.author?.username
      ),
      content: comment.content,
      post,
      thread,
      formattedContext,
      timestamp: comment.createdAt,
    });
  }

  return interactions;
}

// =============================================================================
// Chat Message Gathering
// =============================================================================

/**
 * Gather pending chat messages (DMs and group chats) with conversation context
 */
export async function gatherPendingChatMessages(
  agentUserId: string
): Promise<PendingChatMessage[]> {
  const interactions: PendingChatMessage[] = [];
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - INTERACTION_WINDOW_HOURS * 60 * 60 * 1000
  );

  // Chats where the agent is still an active participant. Team chats
  // (group.type = 'team') are excluded: agents shouldn't auto-respond there.
  const agentChats = await db
    .select({
      chatId: chatParticipants.chatId,
      chat: chats,
    })
    .from(chatParticipants)
    .innerJoin(chats, eq(chatParticipants.chatId, chats.id))
    .leftJoin(groups, eq(chats.groupId, groups.id))
    .where(
      and(
        eq(chatParticipants.userId, agentUserId),
        eq(chatParticipants.isActive, true),
        or(isNull(groups.id), ne(groups.type, 'team'))
      )
    );
  if (agentChats.length === 0) return interactions;

  const chatIds = agentChats.map((c) => c.chatId);
  const chatMap = new Map(agentChats.map((c) => [c.chatId, c.chat]));

  // Batch fetch recent messages
  const allRecentMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        inArray(messages.chatId, chatIds),
        gte(messages.createdAt, windowStart),
        lte(messages.createdAt, now)
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(100);

  // Group by chat
  const messagesByChatId = new Map<
    string,
    (typeof allRecentMessages)[number][]
  >();
  for (const msg of allRecentMessages) {
    const existing = messagesByChatId.get(msg.chatId) || [];
    existing.push(msg);
    messagesByChatId.set(msg.chatId, existing);
  }

  // Collect sender IDs and fetch user info
  const allSenderIds = new Set<string>();
  for (const chatMessages of messagesByChatId.values()) {
    for (const msg of chatMessages) {
      if (msg.senderId !== agentUserId) {
        allSenderIds.add(msg.senderId);
      }
    }
  }

  const senderUserMap = new Map<
    string,
    { displayName: string | null; username: string | null }
  >();
  if (allSenderIds.size > 0) {
    const senderUsers = await db
      .select({
        id: users.id,
        displayName: users.displayName,
        username: users.username,
      })
      .from(users)
      .where(inArray(users.id, [...allSenderIds]));

    for (const user of senderUsers) {
      senderUserMap.set(user.id, {
        displayName: user.displayName,
        username: user.username,
      });
    }
  }

  const getUserName = (senderId: string): string => {
    const user = senderUserMap.get(senderId);
    return formatUserName(user?.displayName, user?.username);
  };

  // Process each chat
  for (const chatId of chatIds) {
    const chat = chatMap.get(chatId);
    if (!chat) continue;

    const chatMessages = messagesByChatId.get(chatId) || [];
    if (chatMessages.length === 0) continue;

    // Find latest message from someone other than agent
    const messagesFromOthers = chatMessages.filter(
      (m) => m.senderId !== agentUserId
    );
    if (messagesFromOthers.length === 0) continue;

    const latestFromOther = messagesFromOthers[0];
    if (!latestFromOther) continue;

    // Check if agent already responded (compare timestamps, not IDs which may
    // be text-based). A reply sharing the same timestamp counts as handled so
    // tied timestamps cannot trigger repeated replies.
    const agentMessages = chatMessages.filter(
      (m) => m.senderId === agentUserId
    );
    const agentLastMessage = agentMessages[0];
    if (
      agentLastMessage &&
      agentLastMessage.createdAt >= latestFromOther.createdAt
    ) {
      continue;
    }

    // Build conversation context
    const recentMessages = chatMessages;
    const contextMessages = recentMessages
      .slice()
      .reverse()
      .map((m) => ({
        speaker: m.senderId === agentUserId ? 'You' : getUserName(m.senderId),
        content: m.content,
      }));

    const chatType = chat.isGroup ? 'Group Chat' : 'Direct Message';
    const formattedContext = `${chatType}: ${chat.name || chatType}

Recent conversation:
${contextMessages.map((m) => `${m.speaker}: ${m.content}`).join('\n')}`;

    interactions.push({
      id: latestFromOther.id,
      chatId: chat.id,
      chatName: chat.name || chatType,
      isGroupChat: chat.isGroup ?? false,
      author: getUserName(latestFromOther.senderId),
      content: latestFromOther.content,
      recentMessages: contextMessages,
      formattedContext,
      timestamp: latestFromOther.createdAt,
    });
  }

  return interactions;
}

// =============================================================================
// Helper Functions
// =============================================================================

/** Format user name with both displayName and username when available */
function formatUserName(
  displayName: string | null | undefined,
  username: string | null | undefined
): string {
  if (displayName && username) {
    return `${displayName} (@${username})`;
  }
  return displayName || username || 'User';
}

/** Check if agent participated in ancestor comment chain */
export function hasAgentInAncestors(
  comment: { parentCommentId: string | null; authorId: string },
  commentMap: Map<string, { parentCommentId: string | null; authorId: string }>,
  agentUserId: string
): boolean {
  // Visited set bounds the walk: corrupt cyclic parent chains must not loop
  // forever.
  const visited = new Set<string>();
  let currentId = comment.parentCommentId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = commentMap.get(currentId);
    if (!parent) break;
    if (parent.authorId === agentUserId) return true;
    currentId = parent.parentCommentId;
  }
  return false;
}

/** Build thread by walking UP from target comment */
function buildThreadFromBottom(
  target: {
    id: string;
    parentCommentId: string | null;
    authorId: string;
    content: string;
    author?: { displayName: string | null; username: string | null } | null;
  },
  commentMap: Map<
    string,
    {
      id: string;
      parentCommentId: string | null;
      authorId: string;
      content: string;
      author?: { displayName: string | null; username: string | null } | null;
    }
  >,
  agentUserId: string
): ThreadMessage[] {
  const chain: (typeof target)[] = [target];
  let currentId = target.parentCommentId;

  while (currentId && chain.length < MAX_THREAD_DEPTH) {
    const parent = commentMap.get(currentId);
    if (!parent) break;
    chain.unshift(parent);
    currentId = parent.parentCommentId;
  }

  return chain.map((c, i) => ({
    authorName:
      c.authorId === agentUserId
        ? 'You'
        : formatUserName(c.author?.displayName, c.author?.username),
    content: c.content,
    isYou: c.authorId === agentUserId,
    depth: i,
  }));
}

/** Format thread for prompt display */
function formatThreadForPrompt(
  post: PostInfo,
  thread: ThreadMessage[]
): string {
  const postAuthorLabel = post.isYourPost ? 'You' : post.authorName;

  const threadLines = thread.map((msg, idx) => {
    const isLast = idx === thread.length - 1;
    const replyIndicator = isLast ? ' [REPLY TO THIS]' : '';
    const depthLabel = idx === 0 ? 'Comment' : `Reply (depth ${msg.depth})`;
    return `- ${depthLabel} by ${msg.authorName}: "${msg.content}"${replyIndicator}`;
  });

  return `POST by ${postAuthorLabel}:
"${post.content}"

THREAD:
${threadLines.join('\n')}`;
}
