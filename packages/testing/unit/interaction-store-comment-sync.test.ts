/**
 * Comment like state must reconcile with the server whenever the comment
 * list is (re)loaded, exactly like post interactions do through
 * syncPostInteraction.
 *
 * The interaction store is persisted (localStorage) and LikeButton renders
 * the store entry over the server-provided props. A comment the viewer once
 * toggled keeps a store entry forever; without a sync on load, its like
 * count and the viewer's own liked flag freeze at toggle time — other
 * people's likes never show up, and if the viewer's like record changes
 * anywhere else, the button keeps sending the wrong toggle method and the
 * server rejects it (ALREADY_LIKED / like-not-found), so the displayed
 * state can never be corrected from that browser.
 */
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

const comment = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
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
  ...overrides,
});

let serverComments: Array<Record<string, unknown>> = [];
const fetchCalls: Array<{ url: string; method: string }> = [];

const mockFetch = mock<MockFetch>((url, init) => {
  const method = init?.method ?? 'GET';
  fetchCalls.push({ url: String(url), method });
  if (String(url).includes('/comments/') && String(url).includes('/like')) {
    return json({ data: { likeCount: 10, isLiked: true } });
  }
  return json({ data: { comments: serverComments } });
});

// @ts-expect-error - test mock
globalThis.fetch = mockFetch;

const { useInteractionStore } = await import('@/stores/interactionStore');

const seedComment = (
  commentId: string,
  likeCount: number,
  isLiked: boolean
): void => {
  useInteractionStore.setState({
    commentInteractions: new Map([
      [commentId, { commentId, likeCount, replyCount: 0, isLiked }],
    ]),
  });
};

beforeEach(() => {
  storage.clear();
  useInteractionStore.getState().resetStore();
  mockFetch.mockClear();
  fetchCalls.length = 0;
  serverComments = [comment()];
});

afterEach(() => {
  useInteractionStore.getState().resetStore();
  storage.clear();
});

describe('interactionStore comment like sync on loadComments', () => {
  test('reconciles a stale persisted entry with the server values', async () => {
    // Left behind by an earlier toggle (and persisted across reloads):
    // the viewer had liked the comment when its count was 6.
    seedComment('comment-1', 6, true);
    // Since then the viewer's like was removed elsewhere and three more
    // people liked the comment: the server now reports 9 / not liked.
    serverComments = [comment({ likeCount: 9, isLiked: false })];

    await useInteractionStore.getState().loadComments('post-1');

    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('comment-1');
    expect(entry?.likeCount).toBe(9);
    expect(entry?.isLiked).toBe(false);
  });

  test('applies the server liked flag even when the count is unchanged', async () => {
    seedComment('comment-1', 5, false);
    serverComments = [comment({ likeCount: 5, isLiked: true })];

    await useInteractionStore.getState().loadComments('post-1');

    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('comment-1');
    expect(entry?.likeCount).toBe(5);
    expect(entry?.isLiked).toBe(true);
  });

  test('syncs nested replies as well as top-level comments', async () => {
    seedComment('reply-1', 1, false);
    serverComments = [
      comment({
        replies: [
          comment({
            id: 'reply-1',
            parentCommentId: 'comment-1',
            likeCount: 3,
            isLiked: true,
          }),
        ],
      }),
    ];

    await useInteractionStore.getState().loadComments('post-1');

    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('reply-1');
    expect(entry?.likeCount).toBe(3);
    expect(entry?.isLiked).toBe(true);
  });

  test('does not overwrite a comment whose toggle is in flight', async () => {
    seedComment('comment-1', 6, true);
    useInteractionStore.getState().setLoading('comment-1', true);
    serverComments = [comment({ likeCount: 9, isLiked: false })];

    await useInteractionStore.getState().loadComments('post-1');

    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('comment-1');
    expect(entry?.likeCount).toBe(6);
    expect(entry?.isLiked).toBe(true);
  });

  test('a toggle after load acts on the synced state (POST, not DELETE)', async () => {
    // Stale entry claims the viewer already liked the comment, but the
    // server (and the record) say they have not. Acting on the stale flag
    // would send DELETE and fail with like-not-found.
    seedComment('comment-1', 6, true);
    serverComments = [comment({ likeCount: 9, isLiked: false })];

    await useInteractionStore.getState().loadComments('post-1');
    const ok = await useInteractionStore
      .getState()
      .toggleCommentLike('comment-1');

    expect(ok).toBe(true);
    const likeCall = fetchCalls.find((c) => c.url.includes('/like'));
    expect(likeCall?.method).toBe('POST');
    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('comment-1');
    expect(entry?.likeCount).toBe(10);
    expect(entry?.isLiked).toBe(true);
  });

  test('does not let a reload issued during a toggle overwrite the confirmed like', async () => {
    // Deferred-response interleaving: the like starts, a comment reload
    // is issued while it is in flight (so its payload predates the
    // like), the like finishes and stores the confirmed state, then the
    // reload resolves. The reload must not overwrite the confirmed
    // mutation, or the next click would send POST again instead of DELETE.
    const deferred = <T>(): {
      promise: Promise<T>;
      resolve: (value: T) => void;
    } => {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    seedComment('comment-1', 9, false);
    serverComments = [comment({ likeCount: 9, isLiked: false })];

    const likeResponse = deferred<Response>();
    const loadResponse = deferred<Response>();
    mockFetch.mockImplementationOnce((url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
      return likeResponse.promise;
    });
    mockFetch.mockImplementationOnce((url, init) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? 'GET' });
      return loadResponse.promise;
    });

    const store = useInteractionStore.getState();
    const likePromise = store.toggleCommentLike('comment-1');
    const loadPromise = store.loadComments('post-1');

    // Let both requests reach the mocked fetch before resolving either.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchCalls.map((c) => c.method)).toEqual(['POST', 'GET']);

    likeResponse.resolve(
      await json({ data: { likeCount: 10, isLiked: true } })
    );
    expect(await likePromise).toBe(true);

    loadResponse.resolve(await json({ data: { comments: serverComments } }));
    await loadPromise;

    const entry = useInteractionStore
      .getState()
      .commentInteractions.get('comment-1');
    expect(entry?.likeCount).toBe(10);
    expect(entry?.isLiked).toBe(true);

    // The next click must act on the confirmed state: DELETE, not POST.
    await useInteractionStore.getState().toggleCommentLike('comment-1');
    const likeCalls = fetchCalls.filter((c) => c.url.includes('/like'));
    expect(likeCalls.at(-1)?.method).toBe('DELETE');
  });
});
