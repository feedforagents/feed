/// <reference path="../../../apps/web/src/global.d.ts" />
/**
 * Post detail page must reconcile the persisted post-like state with the
 * server when the post loads — the same defect #1775 fixed for comments.
 *
 * The interaction store is persisted (localStorage) and LikeButton renders
 * the store entry over the server-provided props. On the feed list,
 * InteractionBar reconciles the entry through syncPostInteraction, so a
 * reload there is already correct. But `/post/[id]` seeded the store by
 * hand and *preserved* the persisted `isLiked`/`isShared` over the fresh
 * API payload — and its subscribe mirror then copied those stale flags
 * into the post state, so InteractionBar received the poisoned values
 * and its sync became a no-op. The button froze at toggle-time values
 * for good: other people's likes never showed up, and if the viewer's
 * like record changed anywhere else, the next click sent the wrong
 * toggle method (DELETE for a like that no longer exists) and the server
 * rejected it with 404, so the displayed state could never be corrected
 * from that browser.
 *
 * These tests render the real page component (PostCard and the comment
 * section are stubbed — they are not the code under test) against a
 * mocked `GET /api/posts/[id]` and drive the real interaction store.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

// Happy-DOM globals must exist before react-dom is imported.
const happyWindow = new Window({ url: 'http://localhost:3000/' });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    Object.defineProperty(globalThis, key, {
      value: (happyWindow as unknown as Record<string, unknown>)[key],
      configurable: true,
    });
  }
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type MockFetch = (input: string, init?: RequestInit) => Promise<Response>;

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );

interface ServerPost {
  id: string;
  type: string;
  content: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isShared: boolean;
  isRepost?: boolean;
  isQuote?: boolean;
  quoteComment?: string | null;
  originalPostId?: string | null;
}

const serverPost = (overrides: Partial<ServerPost> = {}): ServerPost => ({
  id: 'post-1',
  type: 'post',
  content: 'Hello world',
  authorId: 'author-1',
  authorName: 'Alice',
  timestamp: new Date().toISOString(),
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  isLiked: false,
  isShared: false,
  ...overrides,
});

let serverPayload: ServerPost = serverPost();
const fetchCalls: Array<{ url: string; method: string }> = [];

const mockFetch = mock<MockFetch>((input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  fetchCalls.push({ url, method });
  if (url.includes('/like')) {
    if (method === 'DELETE') {
      // The real server rejects an unlike with no like row (404).
      return json({ error: { message: 'Like not found' } }, 404);
    }
    return json({ data: { likeCount: 10, isLiked: true } });
  }
  return json({ data: serverPayload });
});

// @ts-expect-error - test mock
globalThis.fetch = mockFetch;

// Stub the heavy children: they are not the code under test. PostCard is
// stubbed so the test can read the exact `post` state the page hands it.
let capturedPost: Record<string, unknown> | null = null;
mock.module('@/components/posts/PostCard', () => ({
  PostCard: (props: { post?: Record<string, unknown> }) => {
    capturedPost = props.post ?? null;
    return null;
  },
}));
mock.module('@/components/feed/FeedCommentSection', () => ({
  FeedCommentSection: () => null,
}));
const routerStub = { back: () => {}, push: () => {}, replace: () => {} };
mock.module('next/navigation', () => ({
  // Must be a stable identity: the page's load effect depends on `router`,
  // and a fresh object per render would re-run the fetch forever.
  useRouter: () => routerStub,
}));
mock.module('next/dynamic', () => ({
  default: () => () => null,
}));

const { act, Suspense } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useInteractionStore } = await import('@/stores/interactionStore');
const { default: PostPage } = await import('@/app/post/[id]/page');

const seedPost = (
  postId: string,
  likeCount: number,
  isLiked: boolean,
  isShared = false
): void => {
  const next = new Map(useInteractionStore.getState().postInteractions);
  next.set(postId, {
    postId,
    likeCount,
    commentCount: 0,
    shareCount: 0,
    isLiked,
    isShared,
  });
  useInteractionStore.setState({ postInteractions: next });
};

const renderPostPage = async (postId: string) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <PostPage params={Promise.resolve({ id: postId })} />
      </Suspense>
    );
  });
  // Flush the fetch promise chain (response.json + setState + mirror).
  await act(async () => {});
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
};

beforeEach(() => {
  happyWindow.localStorage.clear();
  useInteractionStore.getState().resetStore();
  mockFetch.mockClear();
  fetchCalls.length = 0;
  capturedPost = null;
  serverPayload = serverPost();
});

afterEach(async () => {
  useInteractionStore.getState().resetStore();
  happyWindow.localStorage.clear();
});

describe('post detail page like sync on load', () => {
  test('reconciles a stale persisted entry with the server values', async () => {
    // Left behind by an earlier toggle (and persisted across reloads):
    // the viewer had liked the post when its count was 6.
    seedPost('post-1', 6, true);
    // Since then the viewer's like was removed elsewhere and three more
    // people liked the post: the server now reports 9 / not liked.
    serverPayload = serverPost({ likeCount: 9, isLiked: false });

    const page = await renderPostPage('post-1');
    try {
      const entry = useInteractionStore
        .getState()
        .postInteractions.get('post-1');
      expect(entry?.likeCount).toBe(9);
      expect(entry?.isLiked).toBe(false);
      // The post state handed to PostCard must carry the server values
      // too — on the base the subscribe mirror overwrote it with the
      // stale flags before InteractionBar ever saw the payload.
      expect(capturedPost?.likeCount).toBe(9);
      expect(capturedPost?.isLiked).toBe(false);
    } finally {
      await page.unmount();
    }
  });

  test('applies the server liked flag even when the count is unchanged', async () => {
    seedPost('post-1', 5, false);
    serverPayload = serverPost({ likeCount: 5, isLiked: true });

    const page = await renderPostPage('post-1');
    try {
      const entry = useInteractionStore
        .getState()
        .postInteractions.get('post-1');
      expect(entry?.likeCount).toBe(5);
      expect(entry?.isLiked).toBe(true);
      expect(capturedPost?.isLiked).toBe(true);
    } finally {
      await page.unmount();
    }
  });

  test('a toggle after load acts on the synced state (POST, not DELETE)', async () => {
    // Stale entry claims the viewer already liked the post, but the
    // server (and the record) say they have not. Acting on the stale
    // flag would send DELETE and fail with like-not-found.
    seedPost('post-1', 6, true);
    serverPayload = serverPost({ likeCount: 9, isLiked: false });

    const page = await renderPostPage('post-1');
    try {
      let ok = false;
      await act(async () => {
        ok = await useInteractionStore.getState().toggleLike('post-1');
      });

      expect(ok).toBe(true);
      const likeCall = fetchCalls.find((c) => c.url.includes('/like'));
      expect(likeCall?.method).toBe('POST');
      const entry = useInteractionStore
        .getState()
        .postInteractions.get('post-1');
      expect(entry?.likeCount).toBe(10);
      expect(entry?.isLiked).toBe(true);
    } finally {
      await page.unmount();
    }
  });

  test('does not overwrite a post whose toggle is in flight', async () => {
    seedPost('post-1', 6, true);
    useInteractionStore.getState().setLoading('post-1', true);
    serverPayload = serverPost({ likeCount: 9, isLiked: false });

    const page = await renderPostPage('post-1');
    try {
      const entry = useInteractionStore
        .getState()
        .postInteractions.get('post-1');
      expect(entry?.likeCount).toBe(6);
      expect(entry?.isLiked).toBe(true);
    } finally {
      await page.unmount();
    }
  });

  test('a quote post does not overwrite the original post entry', async () => {
    // The original post has its own entry (50 / not liked).
    seedPost('post-orig', 50, false);
    // The quote's own entry is stale (liked at count 1).
    seedPost('post-1', 1, true);
    serverPayload = serverPost({
      likeCount: 3,
      isLiked: false,
      isRepost: true,
      isQuote: true,
      quoteComment: 'my take',
      originalPostId: 'post-orig',
    });

    const page = await renderPostPage('post-1');
    try {
      const original = useInteractionStore
        .getState()
        .postInteractions.get('post-orig');
      expect(original?.likeCount).toBe(50);
      expect(original?.isLiked).toBe(false);
      const quote = useInteractionStore
        .getState()
        .postInteractions.get('post-1');
      expect(quote?.likeCount).toBe(3);
      expect(quote?.isLiked).toBe(false);
      expect(capturedPost?.likeCount).toBe(3);
      expect(capturedPost?.isLiked).toBe(false);
    } finally {
      await page.unmount();
    }
  });
});
