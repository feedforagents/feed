import { errorResponse, requireAdmin, withErrorHandling } from '@feed/api';
import {
  and,
  dbWrite,
  eq,
  predictionResolutionWork,
  questions,
} from '@feed/db';
import type { NextRequest } from 'next/server';
import { matchingDueDraft, pendingReview } from '../../review-filters';

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => {
    await requireAdmin(request);
    if (process.env.DEPLOYMENT_ENV !== 'localnet') {
      return errorResponse('Proof draft not found', 'NOT_FOUND', 404);
    }
    const { id } = await context.params;

    const [current] = await dbWrite
      .select({ draft: predictionResolutionWork.draft })
      .from(questions)
      .innerJoin(predictionResolutionWork, matchingDueDraft(new Date()))
      .where(and(eq(questions.id, id), pendingReview))
      .limit(1);

    if (!current?.draft) {
      return errorResponse('Proof draft not found', 'NOT_FOUND', 404);
    }

    const { articleTitle, content, fullContent } = current.draft.post;
    const preview = [articleTitle, content, fullContent]
      .filter((part) => part?.trim())
      .join('\n\n');

    return new Response(preview, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
);
