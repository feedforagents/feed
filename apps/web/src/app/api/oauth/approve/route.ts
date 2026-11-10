import { withErrorHandling } from '@feed/api';
import { approvalSchema, OAuthError } from '@feed/mcp';
import type { NextRequest } from 'next/server';
import {
  browserAccount,
  browserBinding,
  jsonObject,
  oauthBoundary,
  oauthResponse,
  oauthService,
  requireBrowserOrigin,
} from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
export const GET = withErrorHandling(async (request: NextRequest) => {
  return oauthBoundary(async () =>
    oauthResponse(
      await oauthService().approvalInfo(
        request.nextUrl.searchParams.get('request') ?? '',
        browserBinding(request),
        await browserAccount(request)
      )
    )
  );
});
export const POST = withErrorHandling(async (request: NextRequest) => {
  return oauthBoundary(async () => {
    requireBrowserOrigin(request);
    const input = approvalSchema.safeParse(await jsonObject(request));
    if (!input.success) throw new OAuthError('invalid_request');
    const userId = await browserAccount(request);
    const { requestId, action, scopes } = input.data;
    return oauthResponse(
      await oauthService().approve(
        requestId,
        browserBinding(request),
        userId,
        action,
        scopes
      )
    );
  });
});
