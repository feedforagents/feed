'use client';

export const dynamic = 'force-dynamic';

import { ArrowLeft, MessageCircle } from 'lucide-react';
import nextDynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { type ReactNode, use, useEffect, useState } from 'react';
import { FeedCommentSection } from '@/components/feed/FeedCommentSection';
import { PostCard } from '@/components/posts/PostCard';
import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton } from '@/components/shared/Skeleton';
import { usePendingIntent } from '@/hooks/usePendingIntent';
import { useInteractionStore } from '@/stores/interactionStore';
import { apiUrl } from '@/utils/api-url';

const WidgetSidebar = nextDynamic(
  () =>
    import('@/components/shared/WidgetSidebar').then((m) => ({
      default: m.WidgetSidebar,
    })),
  {
    ssr: false,
    loading: () => <div className="hidden w-96 flex-none xl:block" />,
  }
);

interface PostPageProps {
  params: Promise<{ id: string }>;
}

interface OriginalPostSummary {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  timestamp: string;
}

interface PostDetail {
  id: string;
  type: string;
  content: string;
  fullContent: string | null;
  articleTitle: string | null;
  byline: string | null;
  biasScore: number | null;
  sentiment: string | null;
  slant: string | null;
  category: string | null;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  timestamp: string;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  isLiked: boolean;
  isShared: boolean;
  isRepost: boolean;
  isQuote: boolean;
  quoteComment: string | null;
  originalPostId: string | null;
  originalPost: OriginalPostSummary | null;
}

/** Shape of `GET /api/posts/[id]` → `data` (fields used here). */
interface PostResponse {
  id: string;
  type?: string;
  content: string;
  fullContent?: string | null;
  articleTitle?: string | null;
  byline?: string | null;
  biasScore?: number | null;
  sentiment?: string | null;
  slant?: string | null;
  category?: string | null;
  authorId: string;
  authorName: string;
  authorUsername?: string | null;
  authorProfileImageUrl?: string | null;
  timestamp: string;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  isLiked?: boolean;
  isShared?: boolean;
  isRepost?: boolean;
  isQuote?: boolean;
  quoteComment?: string | null;
  originalPostId?: string | null;
  originalPost?: OriginalPostSummary | null;
}

export default function PostPage({ params }: PostPageProps) {
  const { id: postId } = use(params);
  const router = useRouter();
  const pending = usePendingIntent();
  const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);

  // Function to open comment modal when comment button is clicked
  useEffect(() => {
    if (
      pending.phase === 'review' &&
      pending.intent?.action.kind === 'reply' &&
      pending.intent.action.postId === postId &&
      !pending.intent.action.parentCommentId
    )
      setIsCommentModalOpen(true);
  }, [pending.phase, pending.intent, postId]);

  const handleCommentClick = () => {
    setIsCommentModalOpen(true);
  };

  // Back: go to previous page (e.g. quote post, profile); fallback to feed when no history (direct link / new tab)
  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/feed');
    }
  };

  const [post, setPost] = useState<PostDetail | null>(null);
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'not-found' | 'error'
  >('loading');
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey intentionally re-triggers the fetch
  useEffect(() => {
    const controller = new AbortController();
    setLoadState('loading');
    setPost(null);

    const loadPost = async () => {
      const response = await fetch(
        apiUrl(`/api/posts/${encodeURIComponent(postId)}`),
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        setLoadState('not-found');
        return;
      }
      if (!response.ok) {
        setLoadState('error');
        return;
      }

      const { data: postData } = (await response.json()) as {
        data: PostResponse;
      };
      if (controller.signal.aborted) return;

      // News and resolution proofs share the article reader.
      if (
        (postData.type === 'article' || postData.type === 'proof') &&
        postData.fullContent
      ) {
        router.replace(`/article/${encodeURIComponent(postId)}`);
        return;
      }

      setPost({
        id: postData.id,
        type: postData.type || 'post',
        content: postData.content,
        fullContent: postData.fullContent || null,
        articleTitle: postData.articleTitle || null,
        byline: postData.byline || null,
        biasScore: postData.biasScore ?? null,
        sentiment: postData.sentiment || null,
        slant: postData.slant || null,
        category: postData.category || null,
        authorId: postData.authorId,
        authorName: postData.authorName,
        authorUsername: postData.authorUsername || null,
        authorProfileImageUrl: postData.authorProfileImageUrl || null,
        timestamp: postData.timestamp,
        likeCount: postData.likeCount ?? 0,
        commentCount: postData.commentCount ?? 0,
        shareCount: postData.shareCount ?? 0,
        isLiked: postData.isLiked ?? false,
        isShared: postData.isShared ?? false,
        isRepost: postData.isRepost || false,
        isQuote: postData.isQuote || false,
        quoteComment: postData.quoteComment || null,
        originalPostId: postData.originalPostId || null,
        originalPost: postData.originalPost || null,
      });

      // Seed the interaction store with fresh API counts. Reposts are
      // tracked under the original post id (matches InteractionBar).
      const interactionPostId = postData.originalPostId || postId;
      const store = useInteractionStore.getState();
      const storeData = store.postInteractions.get(interactionPostId);
      const updatedInteractions = new Map(store.postInteractions);
      updatedInteractions.set(interactionPostId, {
        postId: interactionPostId,
        likeCount: postData.likeCount ?? 0,
        commentCount: postData.commentCount ?? 0,
        shareCount: postData.shareCount ?? 0,
        // Preserve existing isLiked/isShared from store, don't overwrite with API
        isLiked: storeData?.isLiked ?? postData.isLiked ?? false,
        isShared: storeData?.isShared ?? postData.isShared ?? false,
      });
      useInteractionStore.setState({ postInteractions: updatedInteractions });

      setLoadState('ready');
    };

    loadPost().catch(() => {
      if (controller.signal.aborted) return;
      setLoadState('error');
    });

    return () => controller.abort();
  }, [postId, router, reloadKey]);

  // Mirror interaction-store changes into the post. Must use the same id the
  // store is written under (original id for reposts).
  const interactionPostId = post?.originalPostId || postId;
  useEffect(() => {
    const unsubscribe = useInteractionStore.subscribe((state) => {
      const storeData = state.postInteractions.get(interactionPostId);
      if (!storeData) return;
      setPost((prev) => {
        if (!prev) return null;
        if (
          prev.likeCount === storeData.likeCount &&
          prev.commentCount === storeData.commentCount &&
          prev.shareCount === storeData.shareCount &&
          prev.isLiked === storeData.isLiked &&
          prev.isShared === storeData.isShared
        ) {
          return prev;
        }
        return {
          ...prev,
          likeCount: storeData.likeCount,
          commentCount: storeData.commentCount,
          shareCount: storeData.shareCount,
          isLiked: storeData.isLiked,
          isShared: storeData.isShared,
        };
      });
    });

    return () => unsubscribe();
  }, [interactionPostId]);

  const header = (
    <div className="sticky top-0 z-10 shrink-0 border-border border-b bg-background lg:border-b-0 lg:shadow-sm">
      <div className="flex items-center gap-4 px-4 py-3 lg:px-6 lg:py-4">
        <button
          type="button"
          onClick={handleBack}
          aria-label="Go back"
          className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" />
          <h1 className="font-semibold text-lg">Post</h1>
        </div>
      </div>
    </div>
  );

  let body: ReactNode;
  if (loadState === 'loading' || (loadState === 'ready' && !post)) {
    body = (
      <div className="space-y-4 sm:px-4 sm:py-6">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  } else if (loadState !== 'ready' || !post) {
    const notFound = loadState === 'not-found';
    body = (
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
        <h2 className="mb-2 font-bold text-2xl">
          {notFound ? 'Post Not Found' : "Couldn't load post"}
        </h2>
        <p className="mb-4 text-muted-foreground">
          {notFound
            ? 'The post you are looking for does not exist.'
            : 'Something went wrong. Please try again.'}
        </p>
        <div className="flex gap-2">
          {!notFound && (
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className="rounded-md border border-border px-4 py-2 transition-colors hover:bg-muted"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push('/feed')}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to Feed
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="border-border border-b">
          <PostCard
            post={post}
            showInteractions={true}
            isDetail
            onCommentClick={handleCommentClick}
          />
        </div>
        {/* Comments Section - Always visible below the post */}
        <FeedCommentSection postId={postId} postData={post} />
      </>
    );
  }

  // One responsive tree (header, post and comment section mount once).
  return (
    <PageContainer noPadding className="!overflow-visible flex w-full flex-col">
      <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          {header}
          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">{body}</div>
          </div>
        </div>

        {/* Widget sidebar - desktop only */}
        <WidgetSidebar showLatestNews={false} showMarkets={false} />
      </div>

      {/* Comment Modal */}
      {isCommentModalOpen && post && (
        <FeedCommentSection
          postId={postId}
          postData={post}
          onClose={() => setIsCommentModalOpen(false)}
        />
      )}
    </PageContainer>
  );
}
