import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  },
  configurable: true,
});

type MockFetch = (input: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

const commentsPayload = {
  data: {
    comments: [
      {
        id: 'comment-1',
        content: 'Hello world',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: 'user-1',
        userName: 'Alice',
        userUsername: 'alice',
        userAvatar: null,
        parentCommentId: null,
        likeCount: 0,
        isLiked: false,
        replies: [],
      },
    ],
  },
};

const mockFetch = mock<MockFetch>(() => json(commentsPayload));

// @ts-expect-error - test mock
globalThis.fetch = mockFetch;

const { useInteractionStore } = await import('@/stores/interactionStore');

const seedPost = () =>
  useInteractionStore.setState({
    postInteractions: new Map([
      [
        'post-1',
        {
          postId: 'post-1',
          likeCount: 5,
          commentCount: 2,
          shareCount: 1,
          isLiked: false,
          isShared: false,
        },
      ],
    ]),
  });

beforeEach(() => {
  storage.clear();
  useInteractionStore.getState().resetStore();
  mockFetch.mockClear();
  mockFetch.mockImplementation(() => json(commentsPayload));
});

afterEach(() => {
  useInteractionStore.getState().resetStore();
  storage.clear();
});

describe('interactionStore.loadComments', () => {
  test('returns comments and clears the loading state on success', async () => {
    const comments = await useInteractionStore
      .getState()
      .loadComments('post-success');

    expect(comments).toHaveLength(1);
    expect(comments[0]?.id).toBe('comment-1');
    const state = useInteractionStore.getState();
    expect(state.loadingStates.has('load-comments-post-success')).toBe(false);
    expect(state.errors.has('load-comments-post-success')).toBe(false);
  });

  test('stores the server error message on a non-OK response', async () => {
    mockFetch.mockImplementationOnce(() =>
      json({ error: { code: 'NOT_FOUND', message: 'Post not found' } }, 404)
    );

    const comments = await useInteractionStore
      .getState()
      .loadComments('post-missing');

    expect(comments).toEqual([]);
    const state = useInteractionStore.getState();
    expect(state.loadingStates.has('load-comments-post-missing')).toBe(false);
    expect(state.errors.get('load-comments-post-missing')).toEqual({
      code: 'NOT_FOUND',
      message: 'Post not found',
    });
  });

  test('returns an empty list and clears loading when fetch rejects', async () => {
    mockFetch.mockImplementation(() =>
      Promise.reject(new TypeError('fetch failed'))
    );

    const comments = await useInteractionStore
      .getState()
      .loadComments('post-network');

    expect(comments).toEqual([]);
    const state = useInteractionStore.getState();
    expect(state.loadingStates.has('load-comments-post-network')).toBe(false);
    expect(state.errors.get('load-comments-post-network')?.code).toBe(
      'NETWORK_ERROR'
    );
  });
});

describe('interactionStore mutations', () => {
  test('toggleLike commits the server counts on success', async () => {
    seedPost();
    mockFetch.mockImplementationOnce(() =>
      json({ data: { likeCount: 9, isLiked: true } })
    );

    const ok = await useInteractionStore.getState().toggleLike('post-1');

    expect(ok).toBe(true);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.likeCount).toBe(9);
    expect(post?.isLiked).toBe(true);
  });

  test('toggleLike rolls back on a 500 and does not retry the write', async () => {
    seedPost();
    mockFetch.mockImplementation(() => json({ error: 'boom' }, 500));

    const ok = await useInteractionStore.getState().toggleLike('post-1');

    expect(ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const state = useInteractionStore.getState();
    const post = state.postInteractions.get('post-1');
    expect(post?.likeCount).toBe(5);
    expect(post?.isLiked).toBe(false);
    expect(state.loadingStates.has('post-1')).toBe(false);
    expect(state.errors.get('post-1')?.message).toBe('boom');
  });

  test('a failed share does not clobber a concurrent successful like', async () => {
    seedPost();
    let resolveShare: (value: Response) => void = () => {};
    mockFetch.mockImplementation((url) =>
      url.includes('/share')
        ? new Promise<Response>((resolve) => {
            resolveShare = resolve;
          })
        : json({ data: { likeCount: 6, isLiked: true } })
    );

    const share = useInteractionStore.getState().toggleShare('post-1');
    await useInteractionStore.getState().toggleLike('post-1');
    resolveShare(
      new Response(JSON.stringify({ error: 'nope' }), { status: 500 })
    );
    expect(await share).toBeNull();

    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.likeCount).toBe(6);
    expect(post?.isLiked).toBe(true);
    expect(post?.shareCount).toBe(1);
    expect(post?.isShared).toBe(false);
  });

  test('addComment returns null and keeps the count on 401', async () => {
    seedPost();
    mockFetch.mockImplementation(() => json({ error: 'Unauthorized' }, 401));

    const comment = await useInteractionStore
      .getState()
      .addComment('post-1', 'hi');

    expect(comment).toBeNull();
    const state = useInteractionStore.getState();
    expect(state.postInteractions.get('post-1')?.commentCount).toBe(2);
    expect(state.errors.get('comment-post-1-root')?.code).toBe('UNAUTHORIZED');
  });

  test('deleteComment drops the count by the comment and its deleted replies', async () => {
    useInteractionStore.setState({
      postInteractions: new Map([
        [
          'post-1',
          {
            postId: 'post-1',
            likeCount: 5,
            commentCount: 5,
            shareCount: 1,
            isLiked: false,
            isShared: false,
          },
        ],
      ]),
    });
    // DELETE /api/comments/[id] removes the comment and its replies and
    // reports how many replies went with it (top-level body field).
    mockFetch.mockImplementationOnce(() =>
      json({
        message: 'Comment deleted successfully',
        deletedCommentId: 'comment-1',
        deletedRepliesCount: 2,
      })
    );
    // The store reconciles the header count with GET /api/posts/[id]
    // after the DELETE; here the server agrees with the optimistic value.
    mockFetch.mockImplementationOnce(() => json({ commentCount: 2 }));

    const ok = await useInteractionStore
      .getState()
      .deleteComment('comment-1', 'post-1');

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.commentCount).toBe(2);
  });

  test('deleteComment trusts the server count when a reply was hidden', async () => {
    useInteractionStore.setState({
      postInteractions: new Map([
        [
          'post-1',
          {
            postId: 'post-1',
            likeCount: 5,
            commentCount: 5,
            shareCount: 1,
            isLiked: false,
            isShared: false,
          },
        ],
      ]),
    });
    // DELETE counts every direct reply, including one the header never
    // showed (soft-deleted by moderation, or by a blocked/muted author),
    // so the optimistic 5 - 1 - 2 = 2 overshoots the visible list.
    mockFetch.mockImplementationOnce(() =>
      json({
        message: 'Comment deleted successfully',
        deletedCommentId: 'comment-1',
        deletedRepliesCount: 2,
      })
    );
    // GET /api/posts/[id] only counts comments the list can show.
    mockFetch.mockImplementationOnce(() => json({ commentCount: 1 }));

    const ok = await useInteractionStore
      .getState()
      .deleteComment('comment-1', 'post-1');

    expect(ok).toBe(true);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.commentCount).toBe(1);
  });

  test('deleteComment keeps the optimistic count when the refetch fails', async () => {
    useInteractionStore.setState({
      postInteractions: new Map([
        [
          'post-1',
          {
            postId: 'post-1',
            likeCount: 5,
            commentCount: 5,
            shareCount: 1,
            isLiked: false,
            isShared: false,
          },
        ],
      ]),
    });
    mockFetch.mockImplementationOnce(() =>
      json({
        message: 'Comment deleted successfully',
        deletedCommentId: 'comment-1',
        deletedRepliesCount: 2,
      })
    );
    mockFetch.mockImplementationOnce(() => json({ error: 'boom' }, 500));

    const ok = await useInteractionStore
      .getState()
      .deleteComment('comment-1', 'post-1');

    expect(ok).toBe(true);
    const state = useInteractionStore.getState();
    expect(state.postInteractions.get('post-1')?.commentCount).toBe(2);
    expect(state.errors.has('delete-comment-comment-1')).toBe(false);
  });

  test('deleteComment drops the count by one when there are no replies', async () => {
    seedPost();
    mockFetch.mockImplementationOnce(() =>
      json({
        message: 'Comment deleted successfully',
        deletedCommentId: 'comment-1',
        deletedRepliesCount: 0,
      })
    );

    const ok = await useInteractionStore
      .getState()
      .deleteComment('comment-1', 'post-1');

    expect(ok).toBe(true);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.commentCount).toBe(1);
  });

  test('deleteComment never drops the count below zero', async () => {
    useInteractionStore.setState({
      postInteractions: new Map([
        [
          'post-1',
          {
            postId: 'post-1',
            likeCount: 5,
            commentCount: 1,
            shareCount: 1,
            isLiked: false,
            isShared: false,
          },
        ],
      ]),
    });
    mockFetch.mockImplementationOnce(() =>
      json({
        message: 'Comment deleted successfully',
        deletedCommentId: 'comment-1',
        deletedRepliesCount: 2,
      })
    );

    const ok = await useInteractionStore
      .getState()
      .deleteComment('comment-1', 'post-1');

    expect(ok).toBe(true);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.commentCount).toBe(0);
  });
});

describe('interactionStore.syncPostInteraction', () => {
  const server = {
    postId: 'post-1',
    likeCount: 3,
    commentCount: 1,
    shareCount: 0,
    isLiked: true,
    isShared: false,
  };

  test('applies server flags even when counts are unchanged', () => {
    seedPost();
    useInteractionStore.getState().syncPostInteraction({
      ...server,
      likeCount: 5,
      commentCount: 2,
      shareCount: 1,
    });
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.isLiked).toBe(true);
  });

  test('does not overwrite while a mutation is in flight', () => {
    seedPost();
    useInteractionStore.getState().setLoading('post-1', true);
    useInteractionStore.getState().syncPostInteraction(server);
    const post = useInteractionStore.getState().postInteractions.get('post-1');
    expect(post?.likeCount).toBe(5);
    expect(post?.isLiked).toBe(false);
  });
});
