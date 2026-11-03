/**
 * useToggleReaction Hook
 *
 * Shared hook for toggling emoji reactions on chat messages.
 * Used by useChatPage for DMs and group chats.
 *
 * Provides optimistic UI updates, SSE echo suppression, and automatic rollback on failure.
 */

import { useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { MessageReactionSummary } from '@/components/chats/types';
import { useAuthStore } from '@/stores/authStore';
import { apiFetch } from '@/utils/api-fetch';
import type { ChatMessage } from './useChatMessages';

/**
 * Compute the next reactions array after a local user toggles an emoji.
 * Exported so SSE handlers in useChatMessages can reuse the same logic.
 */
export function applyReactionDelta(
  existing: MessageReactionSummary[] | undefined,
  emoji: string,
  action: 'added' | 'removed',
  isMine: boolean
): MessageReactionSummary[] {
  const map = new Map<string, MessageReactionSummary>();
  for (const r of existing ?? []) map.set(r.emoji, { ...r });

  const prev = map.get(emoji);
  const prevCount = prev?.count ?? 0;
  const nextCount =
    action === 'added' ? prevCount + 1 : Math.max(0, prevCount - 1);

  if (nextCount <= 0) {
    map.delete(emoji);
  } else {
    map.set(emoji, {
      emoji,
      count: nextCount,
      reactedByMe: isMine ? action === 'added' : (prev?.reactedByMe ?? false),
    });
  }

  const out = [...map.values()];
  out.sort((a, b) => b.count - a.count);
  return out;
}

interface UseToggleReactionOptions {
  chatId: string | null;
  messages: ChatMessage[];
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  /** Suppresses our own SSE echo; returns a function that clears it. */
  markPendingReactionDelta: (delta: {
    messageId: string;
    emoji: string;
    action: 'added' | 'removed';
  }) => () => void;
}

/**
 * Returns a stable `toggleReaction(messageId, emoji, currentlyReactedByMe)` callback.
 */
export function useToggleReaction({
  chatId,
  messages,
  updateMessage,
  markPendingReactionDelta,
}: UseToggleReactionOptions) {
  const { user } = useAuthStore();
  // Latest messages, so a rollback applies to current reactions rather than
  // clobbering concurrent updates with a stale snapshot.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string, currentlyReactedByMe: boolean) => {
      if (!chatId || !user) return;

      const action: 'added' | 'removed' = currentlyReactedByMe
        ? 'removed'
        : 'added';
      const currentReactions = () =>
        messagesRef.current.find((m) => m.id === messageId)?.reactions;

      // Optimistic update + SSE echo suppression
      const clearPending = markPendingReactionDelta({
        messageId,
        emoji,
        action,
      });
      updateMessage(messageId, {
        reactions: applyReactionDelta(currentReactions(), emoji, action, true),
      });

      const rollback = () => {
        clearPending();
        updateMessage(messageId, {
          reactions: applyReactionDelta(
            currentReactions(),
            emoji,
            action === 'added' ? 'removed' : 'added',
            true
          ),
        });
        toast.error('Failed to update reaction');
      };

      const base = `/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`;
      let response: Response;
      try {
        response = await apiFetch(
          currentlyReactedByMe
            ? `${base}?emoji=${encodeURIComponent(emoji)}`
            : base,
          {
            method: currentlyReactedByMe ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: currentlyReactedByMe ? undefined : JSON.stringify({ emoji }),
          }
        );
      } catch {
        rollback();
        return;
      }

      if (!response.ok) {
        rollback();
        return;
      }

      const data = (await response.json().catch(() => null)) as {
        reactions?: MessageReactionSummary[];
      } | null;
      if (Array.isArray(data?.reactions)) {
        updateMessage(messageId, { reactions: data.reactions });
      }
    },
    [chatId, user, updateMessage, markPendingReactionDelta]
  );

  return toggleReaction;
}
