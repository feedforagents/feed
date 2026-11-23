import {
  Actions,
  type AgentTickContext,
} from './templates/multi-step-decision';

type DecisionParameters = Record<string, unknown>;

const PLACEHOLDER_TOKENS = new Set([
  '',
  '0',
  'none',
  'null',
  'nil',
  'n/a',
  'na',
  'unknown',
  'undefined',
  'post',
  'comment',
  'chat',
  'user',
]);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeIdInput(value: unknown): string | undefined {
  const trimmed =
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'number' && Number.isSafeInteger(value)
        ? String(Math.trunc(value))
        : typeof value === 'bigint'
          ? value.toString()
          : '';
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeToken(trimmed);
  if (PLACEHOLDER_TOKENS.has(normalized)) {
    return undefined;
  }

  return trimmed;
}

function extractOrdinal(value: string): number | undefined {
  // Rendered context lists are short; long digit strings are IDs (snowflakes),
  // not ordinals.
  const direct = value.match(/^#?(\d{1,3})$/)?.[1];
  if (direct) {
    return Number.parseInt(direct, 10);
  }

  const indexed = value.match(
    /^(?:post|comment|chat|user)\s*#?\s*(\d{1,3})$/i
  )?.[1];
  if (indexed) {
    return Number.parseInt(indexed, 10);
  }

  return undefined;
}

function extractEmbeddedId(value: string): string | undefined {
  const explicitId =
    value.match(/\bid\s*:\s*([A-Za-z0-9_-]+)/i)?.[1] ??
    value.match(
      /\b(?:postId|commentId|chatId|userId|recipientId)\s*:\s*([A-Za-z0-9_-]+)/i
    )?.[1];
  return explicitId?.trim();
}

function resolveCandidateId<T extends { id: string }>(
  rawValue: unknown,
  candidates: T[]
): string | undefined {
  const normalizedInput = normalizeIdInput(rawValue);
  if (!normalizedInput) {
    return undefined;
  }

  const exact = candidates.find(
    (candidate) => candidate.id === normalizedInput
  );
  if (exact) {
    return exact.id;
  }

  const embeddedId = extractEmbeddedId(normalizedInput);
  if (embeddedId) {
    const embedded = candidates.find(
      (candidate) => candidate.id === embeddedId
    );
    if (embedded) {
      return embedded.id;
    }
  }

  const ordinal = extractOrdinal(normalizedInput);
  if (ordinal !== undefined) {
    return ordinal >= 1 && ordinal <= candidates.length
      ? candidates[ordinal - 1]?.id
      : undefined;
  }

  // An explicit, well-formed ID that is simply not in the rendered context is
  // passed through unchanged; the executing service authorizes the real
  // target. Free text is never repaired into an executable target.
  if (/^[A-Za-z0-9_-]+$/.test(normalizedInput) && /\d/.test(normalizedInput)) {
    return normalizedInput;
  }

  return undefined;
}

function dedupeRecentPostAuthors(
  context: AgentTickContext,
  agentUserId: string
): Array<{ id: string }> {
  const seen = new Set<string>();
  const authors: Array<{ id: string }> = [];

  for (const post of context.recentPosts) {
    if (post.authorId === agentUserId || seen.has(post.authorId)) {
      continue;
    }
    seen.add(post.authorId);
    authors.push({ id: post.authorId });
  }

  return authors;
}

export function normalizeSocialDecisionParameters(
  action: string,
  parameters: DecisionParameters,
  context: AgentTickContext,
  agentUserId: string
): DecisionParameters {
  const nextParameters: DecisionParameters = { ...parameters };
  const recentPosts = context.recentPosts.map((post) => ({ id: post.id }));
  const pendingReplies = context.pendingCommentReplies.map((reply) => ({
    id: reply.id,
    postId: reply.postId,
  }));
  const pendingChats = context.pendingChatMessages.map((message) => ({
    id: message.chatId,
  }));
  const groupChats =
    context.groupChats?.map((group) => ({
      id: group.id,
    })) ?? [];
  const recentAuthors = dedupeRecentPostAuthors(context, agentUserId);

  switch (action) {
    case Actions.COMMENT: {
      const resolvedPostId = resolveCandidateId(
        nextParameters.postId,
        recentPosts
      );

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      // Preserve malformed reply intent for validation. Only REPLY_COMMENT
      // may resolve a parent, so an invalid reply never becomes top-level.
      for (const field of ['commentId', 'parentCommentId']) {
        const parent = nextParameters[field];
        if (
          parent == null ||
          parent === 0 ||
          parent === 0n ||
          (typeof parent === 'string' &&
            PLACEHOLDER_TOKENS.has(normalizeToken(parent)))
        ) {
          delete nextParameters[field];
        }
      }

      return nextParameters;
    }

    case Actions.REPLY_COMMENT: {
      const resolvedCommentId = resolveCandidateId(
        nextParameters.commentId,
        pendingReplies
      );
      const target = resolvedCommentId
        ? pendingReplies.find((reply) => reply.id === resolvedCommentId)
        : undefined;

      if (target) {
        nextParameters.commentId = target.id;
        nextParameters.postId = target.postId;
      } else {
        delete nextParameters.commentId;
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.LIKE: {
      const resolvedPostId = resolveCandidateId(
        nextParameters.postId,
        recentPosts
      );

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.REPOST: {
      const resolvedPostId = resolveCandidateId(
        nextParameters.postId,
        recentPosts
      );

      if (resolvedPostId) {
        nextParameters.postId = resolvedPostId;
      } else {
        delete nextParameters.postId;
      }

      return nextParameters;
    }

    case Actions.FOLLOW:
    case Actions.UNFOLLOW: {
      const resolvedUserId = resolveCandidateId(
        nextParameters.userId,
        recentAuthors
      );

      if (resolvedUserId) {
        nextParameters.userId = resolvedUserId;
      } else {
        delete nextParameters.userId;
      }

      return nextParameters;
    }

    case Actions.DM: {
      const resolvedRecipientId = resolveCandidateId(
        nextParameters.recipientId,
        recentAuthors
      );

      if (resolvedRecipientId) {
        nextParameters.recipientId = resolvedRecipientId;
      } else {
        delete nextParameters.recipientId;
      }

      return nextParameters;
    }

    case Actions.REPLY_CHAT: {
      const resolvedChatId = resolveCandidateId(
        nextParameters.chatId,
        pendingChats
      );

      if (resolvedChatId) {
        nextParameters.chatId = resolvedChatId;
      } else {
        delete nextParameters.chatId;
      }

      return nextParameters;
    }

    case Actions.GROUP_MESSAGE: {
      const resolvedChatId = resolveCandidateId(
        nextParameters.chatId,
        groupChats
      );

      if (resolvedChatId) {
        nextParameters.chatId = resolvedChatId;
      } else {
        delete nextParameters.chatId;
      }

      return nextParameters;
    }

    default:
      return nextParameters;
  }
}
