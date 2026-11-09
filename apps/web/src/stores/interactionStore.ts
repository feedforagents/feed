/**
 * Interaction Store - Manages social interactions with optimistic updates
 * Handles: likes, comments and shares.
 *
 * Mutations never throw: on failure they roll back their own optimistic
 * change, record an error under the operation's key, and report the outcome
 * (boolean / null) so callers only run success side effects on success.
 * Writes are never retried automatically.
 */

import type {
  CommentData,
  CommentInteraction,
  CommentWithReplies,
  InteractionError,
  PostInteraction,
} from '@feed/shared';
import { extractErrorMessage } from '@feed/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { readApiErrorMessage } from '@/utils/api-error';
import { apiFetch } from '@/utils/api-fetch';

interface RepostPost {
  id: string;
  originalPostId: string;
  userId: string;
  createdAt: number;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername?: string;
  authorProfileImageUrl?: string;
  timestamp: string;
  isRepost: boolean;
  originalAuthorId?: string | null;
  originalAuthorName?: string | null;
  originalAuthorUsername?: string | null;
  originalAuthorProfileImageUrl?: string | null;
  originalContent?: string | null;
  quoteComment?: string | null;
}

interface ShareResult {
  shareCount: number;
  isShared: boolean;
  repostPost?: RepostPost;
}

interface InteractionStoreState {
  // State maps
  postInteractions: Map<string, PostInteraction>;
  commentInteractions: Map<string, CommentInteraction>;

  // Loading states
  loadingStates: Map<string, boolean>;

  // Error states
  errors: Map<string, InteractionError>;
}

interface InteractionStoreActions {
  confirmDesiredLike: (
    targetId: string,
    targetType: 'post' | 'comment',
    likeCount: number
  ) => void;
  // Like actions — resolve true when the server committed the toggle
  toggleLike: (postId: string) => Promise<boolean>;
  toggleCommentLike: (commentId: string) => Promise<boolean>;

  // Comment actions
  addComment: (
    postId: string,
    content: string,
    parentId?: string
  ) => Promise<CommentData | null>;
  editComment: (commentId: string, content: string) => Promise<boolean>;
  deleteComment: (commentId: string, postId?: string) => Promise<boolean>;
  loadComments: (postId: string) => Promise<CommentWithReplies[]>;

  // Share actions — resolve null when the toggle failed
  toggleShare: (
    postId: string,
    comment?: string
  ) => Promise<ShareResult | null>;

  /**
   * Merge authoritative server interaction data for a post. Skipped while a
   * mutation for that post is in flight (its own result is authoritative).
   */
  syncPostInteraction: (interaction: PostInteraction) => void;

  // Utility actions
  clearError: (id: string) => void;
  resetStore: () => void;
  getPostInteraction: (postId: string) => PostInteraction | null;
  getCommentInteraction: (commentId: string) => CommentInteraction | null;
  setLoading: (id: string, loading: boolean) => void;
  setError: (id: string, error: InteractionError) => void;
}

type InteractionStore = InteractionStoreState & InteractionStoreActions;

// Persisted state type (only serializable parts)
type PersistedInteractionState = {
  postInteractions: Array<[string, PostInteraction]>;
  commentInteractions: Array<[string, CommentInteraction]>;
};

class InteractionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'InteractionRequestError';
  }
}

/**
 * Single attempt, authenticated JSON request. Throws InteractionRequestError
 * for network failures and non-2xx responses (with the server's message).
 */
async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch (error) {
    throw new InteractionRequestError(extractErrorMessage(error), null);
  }
  if (!response.ok) {
    throw new InteractionRequestError(
      await readApiErrorMessage(response, 'Request failed'),
      response.status
    );
  }
  return (await response.json()) as T;
}

function toInteractionError(error: unknown): InteractionError {
  if (error instanceof InteractionRequestError) {
    return {
      code:
        error.status === null
          ? 'NETWORK_ERROR'
          : error.status === 401
            ? 'UNAUTHORIZED'
            : error.status === 404
              ? 'NOT_FOUND'
              : 'UNKNOWN',
      message: error.message,
    };
  }
  return { code: 'UNKNOWN', message: extractErrorMessage(error) };
}

const emptyPostInteraction = (postId: string): PostInteraction => ({
  postId,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  isLiked: false,
  isShared: false,
});

const emptyCommentInteraction = (commentId: string): CommentInteraction => ({
  commentId,
  likeCount: 0,
  replyCount: 0,
  isLiked: false,
});

export const useInteractionStore = create<InteractionStore>()(
  persist(
    (set, get) => {
      /** Merge fields into the *current* post interaction (never a stale snapshot). */
      const patchPost = (postId: string, patch: Partial<PostInteraction>) =>
        set((state) => {
          const current =
            state.postInteractions.get(postId) ?? emptyPostInteraction(postId);
          return {
            postInteractions: new Map(state.postInteractions).set(postId, {
              ...current,
              ...patch,
            }),
          };
        });

      const patchComment = (
        commentId: string,
        patch: Partial<CommentInteraction>
      ) =>
        set((state) => {
          const current =
            state.commentInteractions.get(commentId) ??
            emptyCommentInteraction(commentId);
          return {
            commentInteractions: new Map(state.commentInteractions).set(
              commentId,
              { ...current, ...patch }
            ),
          };
        });

      /** Run a request with loading/error bookkeeping under `key`. */
      const run = async <T>(
        key: string,
        request: () => Promise<T>
      ): Promise<{ ok: true; value: T } | { ok: false }> => {
        const { setLoading, setError, clearError } = get();
        setLoading(key, true);
        try {
          const value = await request();
          clearError(key);
          return { ok: true, value };
        } catch (error) {
          setError(key, toInteractionError(error));
          return { ok: false };
        } finally {
          setLoading(key, false);
        }
      };

      return {
        confirmDesiredLike: (targetId, targetType, likeCount) => {
          if (targetType === 'post')
            patchPost(targetId, { isLiked: true, likeCount });
          else patchComment(targetId, { isLiked: true, likeCount });
        },
        // Initial state
        postInteractions: new Map(),
        commentInteractions: new Map(),
        loadingStates: new Map(),
        errors: new Map(),

        syncPostInteraction: (interaction: PostInteraction) => {
          const { postId } = interaction;
          if (get().loadingStates.get(postId)) return;
          if (get().loadingStates.get(`share-${postId}`)) return;
          const current = get().postInteractions.get(postId);
          if (
            current &&
            current.likeCount === interaction.likeCount &&
            current.commentCount === interaction.commentCount &&
            current.shareCount === interaction.shareCount &&
            current.isLiked === interaction.isLiked &&
            current.isShared === interaction.isShared
          ) {
            return;
          }
          patchPost(postId, interaction);
        },

        toggleLike: async (postId: string) => {
          const current =
            get().postInteractions.get(postId) ?? emptyPostInteraction(postId);
          const wasLiked = current.isLiked;
          patchPost(postId, {
            isLiked: !wasLiked,
            likeCount: Math.max(0, current.likeCount + (wasLiked ? -1 : 1)),
          });

          const result = await run(postId, () =>
            requestJson<{ data: { likeCount: number; isLiked: boolean } }>(
              `/api/posts/${encodeURIComponent(postId)}/like`,
              { method: wasLiked ? 'DELETE' : 'POST' }
            )
          );
          if (!result.ok) {
            patchPost(postId, {
              isLiked: current.isLiked,
              likeCount: current.likeCount,
            });
            return false;
          }
          patchPost(postId, {
            likeCount: result.value.data.likeCount,
            isLiked: result.value.data.isLiked,
          });
          return true;
        },

        toggleCommentLike: async (commentId: string) => {
          const current =
            get().commentInteractions.get(commentId) ??
            emptyCommentInteraction(commentId);
          const wasLiked = current.isLiked;
          patchComment(commentId, {
            isLiked: !wasLiked,
            likeCount: Math.max(0, current.likeCount + (wasLiked ? -1 : 1)),
          });

          const result = await run(commentId, () =>
            requestJson<{ data: { likeCount: number; isLiked: boolean } }>(
              `/api/comments/${encodeURIComponent(commentId)}/like`,
              { method: wasLiked ? 'DELETE' : 'POST' }
            )
          );
          if (!result.ok) {
            patchComment(commentId, {
              isLiked: current.isLiked,
              likeCount: current.likeCount,
            });
            return false;
          }
          patchComment(commentId, {
            likeCount: result.value.data.likeCount,
            isLiked: result.value.data.isLiked,
          });
          return true;
        },

        addComment: async (
          postId: string,
          content: string,
          parentId?: string
        ) => {
          const result = await run(
            `comment-${postId}-${parentId || 'root'}`,
            () =>
              requestJson<CommentData>(
                `/api/posts/${encodeURIComponent(postId)}/comments`,
                {
                  method: 'POST',
                  body: JSON.stringify({ content, parentCommentId: parentId }),
                }
              )
          );
          if (!result.ok) return null;

          if (!parentId) {
            const current = get().postInteractions.get(postId);
            if (current) {
              patchPost(postId, { commentCount: current.commentCount + 1 });
            }
          }
          return result.value;
        },

        editComment: async (commentId: string, content: string) => {
          const result = await run(`edit-comment-${commentId}`, () =>
            requestJson(`/api/comments/${encodeURIComponent(commentId)}`, {
              method: 'PATCH',
              body: JSON.stringify({ content }),
            })
          );
          return result.ok;
        },

        deleteComment: async (commentId: string, postId?: string) => {
          const result = await run(`delete-comment-${commentId}`, () =>
            requestJson(`/api/comments/${encodeURIComponent(commentId)}`, {
              method: 'DELETE',
            })
          );
          if (!result.ok) return false;

          if (postId) {
            const current = get().postInteractions.get(postId);
            if (current && current.commentCount > 0) {
              patchPost(postId, { commentCount: current.commentCount - 1 });
            }
          }
          return true;
        },

        loadComments: async (postId: string) => {
          const result = await run(`load-comments-${postId}`, () =>
            requestJson<{ data?: { comments?: CommentWithReplies[] } }>(
              `/api/posts/${encodeURIComponent(postId)}/comments`
            )
          );
          if (!result.ok) return [];
          const comments = result.value.data?.comments;
          if (!Array.isArray(comments)) {
            get().setError(`load-comments-${postId}`, {
              code: 'UNKNOWN',
              message: 'Unable to load comments right now.',
            });
            return [];
          }
          return comments;
        },

        toggleShare: async (postId: string, comment?: string) => {
          const current =
            get().postInteractions.get(postId) ?? emptyPostInteraction(postId);
          const wasShared = current.isShared;
          patchPost(postId, {
            isShared: !wasShared,
            shareCount: Math.max(0, current.shareCount + (wasShared ? -1 : 1)),
          });

          const method = wasShared ? 'DELETE' : 'POST';
          const result = await run(`share-${postId}`, () =>
            requestJson<{ data: ShareResult }>(
              `/api/posts/${encodeURIComponent(postId)}/share`,
              {
                method,
                ...(method === 'POST' && {
                  body: JSON.stringify(comment ? { comment } : {}),
                }),
              }
            )
          );
          if (!result.ok) {
            patchPost(postId, {
              isShared: current.isShared,
              shareCount: current.shareCount,
            });
            return null;
          }
          patchPost(postId, {
            shareCount: result.value.data.shareCount,
            isShared: result.value.data.isShared,
          });
          // Includes repostPost for optimistic UI
          return result.value.data;
        },

        // Utility actions
        clearError: (id: string) => {
          set((state) => {
            const newErrors = new Map(state.errors);
            newErrors.delete(id);
            return { errors: newErrors };
          });
        },

        resetStore: () => {
          set({
            postInteractions: new Map(),
            commentInteractions: new Map(),
            loadingStates: new Map(),
            errors: new Map(),
          });
        },

        getPostInteraction: (postId: string) => {
          return get().postInteractions.get(postId) || null;
        },

        getCommentInteraction: (commentId: string) => {
          return get().commentInteractions.get(commentId) || null;
        },

        setLoading: (id: string, loading: boolean) => {
          set((state) => {
            const newLoadingStates = new Map(state.loadingStates);
            if (loading) {
              newLoadingStates.set(id, true);
            } else {
              newLoadingStates.delete(id);
            }
            return { loadingStates: newLoadingStates };
          });
        },

        setError: (id: string, error: InteractionError) => {
          set((state) => ({
            errors: new Map(state.errors).set(id, error),
          }));
        },
      };
    },
    {
      name: 'feed-interactions',
      // Custom serialization for Maps and Sets
      partialize: (state: InteractionStore): PersistedInteractionState => ({
        postInteractions: Array.from(state.postInteractions.entries()),
        commentInteractions: Array.from(state.commentInteractions.entries()),
      }),
      // Custom deserialization to convert arrays back to Maps and Sets
      merge: (persistedState: unknown, currentState: InteractionStore) => {
        const persisted = (persistedState as
          | Partial<PersistedInteractionState>
          | null
          | undefined) || {
          postInteractions: undefined,
          commentInteractions: undefined,
        };

        return {
          ...currentState,
          postInteractions: new Map(persisted?.postInteractions || []),
          commentInteractions: new Map(persisted?.commentInteractions || []),
        };
      },
    }
  )
);
