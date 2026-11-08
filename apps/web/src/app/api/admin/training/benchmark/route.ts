/** Read-only historical benchmark summaries. */

import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import { benchmarkService } from '@feed/training';
import type { NextRequest } from 'next/server';

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  // Get benchmark summary
  const summary = await benchmarkService.getBenchmarkSummary();

  return successResponse({
    success: true,
    summary,
  });
});
