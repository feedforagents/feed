'use client';

export const dynamic = 'force-dynamic';

import { ArrowLeft, Newspaper } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { MoreArticlesWidget } from '@/components/articles/MoreArticlesWidget';
import { Response } from '@/components/chat/Response';
import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton } from '@/components/shared/Skeleton';
import { Button } from '@/components/ui/button';
import { apiUrl } from '@/utils/api-url';

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

interface ArticlePost {
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
  imageUrl: string | null;
  authorId: string;
  authorName: string;
  authorUsername: string | null;
  authorProfileImageUrl: string | null;
  timestamp: string;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'error'; message: string }
  | { status: 'ready'; article: ArticlePost };

const ARTICLE_BODY_CLASS =
  'mb-6 max-w-none text-foreground/90 [&_a]:text-primary [&_a]:underline hover:[&_a]:text-primary/80 [&_blockquote]:my-4 sm:[&_blockquote]:my-6 [&_blockquote]:border-primary [&_blockquote]:border-l-4 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_em]:italic [&_h1]:mt-6 sm:[&_h1]:mt-8 [&_h1]:mb-3 sm:[&_h1]:mb-4 [&_h1]:font-bold [&_h1]:text-xl sm:[&_h1]:text-2xl [&_h2]:mt-5 sm:[&_h2]:mt-6 [&_h2]:mb-2 sm:[&_h2]:mb-3 [&_h2]:font-semibold [&_h2]:text-lg sm:[&_h2]:text-xl [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:font-medium [&_h3]:text-base sm:[&_h3]:text-lg [&_hr]:my-6 sm:[&_hr]:my-8 [&_hr]:border-border [&_li]:my-1.5 sm:[&_li]:my-2 [&_li]:text-base [&_li]:leading-relaxed [&_ol]:my-3 sm:[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-5 sm:[&_ol]:pl-6 [&_p]:mb-5 sm:[&_p]:mb-6 [&_p]:text-base [&_p]:leading-relaxed sm:[&_p]:text-lg [&_pre]:my-3 sm:[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 sm:[&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-bold [&_ul]:my-3 sm:[&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-5 sm:[&_ul]:pl-6';

export default function ArticlePage({ params }: ArticlePageProps) {
  const { id: articleId } = use(params);
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey intentionally re-triggers the fetch
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });

    const loadArticle = async () => {
      // News and resolution proofs share the article reader.
      const response = await fetch(
        apiUrl(`/api/posts/${encodeURIComponent(articleId)}`),
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;

      if (response.status === 404) {
        setState({ status: 'not-found' });
        return;
      }

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: result?.error?.message || 'Failed to load article',
        });
        return;
      }

      const result = (await response.json()) as { data: ArticlePost };
      if (controller.signal.aborted) return;

      if (result.data.type !== 'article' && result.data.type !== 'proof') {
        router.replace(`/post/${encodeURIComponent(articleId)}`);
        return;
      }

      setState({ status: 'ready', article: result.data });
    };

    loadArticle().catch((err: Error) => {
      if (controller.signal.aborted) return;
      setState({
        status: 'error',
        message: err.message || 'Failed to load article',
      });
    });

    return () => controller.abort();
  }, [articleId, router, reloadKey]);

  if (state.status === 'loading') {
    return (
      <PageContainer noPadding className="flex w-full flex-col">
        <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
          <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
            <div className="sticky top-0 z-10 shrink-0 bg-background shadow-sm">
              <div className="px-6 py-4">
                <div className="flex items-center gap-4">
                  <div className="h-9 w-9 rounded-full bg-muted" />
                  <Skeleton className="h-6 w-20" />
                </div>
              </div>
            </div>
            <div className="flex-1 bg-background">
              <div className="w-full lg:mx-auto lg:max-w-[700px]">
                <div className="space-y-4 px-4 py-6">
                  <Skeleton className="h-8 w-3/4" />
                  <Skeleton className="h-64 w-full" />
                  <Skeleton className="h-32 w-full" />
                </div>
              </div>
            </div>
          </div>
          <div className="hidden w-96 flex-none xl:flex" />
        </div>
      </PageContainer>
    );
  }

  if (state.status !== 'ready') {
    const notFound = state.status === 'not-found';
    return (
      <PageContainer noPadding className="flex w-full flex-col">
        <div className="relative flex min-h-dvh flex-1 md:min-h-screen">
          <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
            <div className="flex flex-1 flex-col items-center justify-center bg-background">
              <div className="text-center">
                <h1 className="mb-2 font-bold text-2xl">
                  {notFound ? 'Article Not Found' : "Couldn't load article"}
                </h1>
                <p className="mb-4 text-muted-foreground">
                  {notFound
                    ? 'The article you are looking for does not exist.'
                    : state.message}
                </p>
                <div className="flex justify-center gap-2">
                  {!notFound && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setReloadKey((key) => key + 1)}
                    >
                      Try again
                    </Button>
                  )}
                  <Button type="button" onClick={() => router.push('/feed')}>
                    Back to Feed
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <div className="hidden w-96 flex-none xl:flex" />
        </div>
      </PageContainer>
    );
  }

  const { article } = state;
  const publishedDate = new Date(article.timestamp);
  const articleBody = article.fullContent || article.content;

  return (
    <PageContainer noPadding className="flex w-full flex-col">
      <div className="relative flex min-h-dvh flex-1 flex-col md:min-h-screen xl:flex-row">
        <div className="flex min-w-0 flex-1 flex-col border-border lg:border-r lg:border-l">
          {/* Top bar with back button */}
          <div className="sticky top-0 z-10 shrink-0 border-border border-b bg-background lg:border-b-0 lg:shadow-sm">
            <div className="flex items-center gap-4 px-4 py-3 lg:px-6 lg:py-4">
              <button
                type="button"
                onClick={() => router.back()}
                aria-label="Go back"
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ArrowLeft size={20} />
              </button>
              <div className="flex items-center gap-2">
                <Newspaper className="h-5 w-5 text-primary" />
                <h1 className="font-semibold text-lg">Article</h1>
              </div>
            </div>
          </div>

          <div className="flex-1 bg-background">
            <div className="w-full lg:mx-auto lg:max-w-[700px]">
              <article className="px-4 py-4 sm:px-6 sm:py-6">
                {article.imageUrl && (
                  <div className="relative mb-4 aspect-video w-full overflow-hidden rounded-lg sm:mb-6">
                    <Image
                      src={article.imageUrl}
                      alt={article.articleTitle || 'Article cover'}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 800px"
                      priority
                    />
                  </div>
                )}

                <h1 className="mb-4 font-bold text-2xl text-foreground leading-tight sm:text-3xl lg:text-4xl">
                  {article.articleTitle}
                </h1>

                <div className="mb-4 flex flex-wrap items-center gap-2 text-muted-foreground text-sm sm:mb-6 sm:gap-3">
                  <span className="font-semibold text-primary">
                    {article.authorName}
                  </span>
                  {article.byline && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{article.byline}</span>
                    </>
                  )}
                  <span aria-hidden="true">·</span>
                  <time dateTime={publishedDate.toISOString()}>
                    {publishedDate.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </time>
                </div>

                <Response className={ARTICLE_BODY_CLASS}>
                  {articleBody}
                </Response>
              </article>
            </div>
          </div>
        </div>

        {/* More Articles: below the article on small screens, sidebar on xl */}
        <aside className="flex w-full flex-col border-border border-t px-4 pt-6 pb-24 sm:px-6 xl:w-96 xl:flex-none xl:border-t-0 xl:px-4 xl:py-6">
          <MoreArticlesWidget currentArticleId={articleId} limit={5} />
        </aside>
      </div>
    </PageContainer>
  );
}
