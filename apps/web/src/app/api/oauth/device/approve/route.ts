import { withErrorHandling } from '@feed/api';
import { deviceApprovalSchema, FeedDeviceService, OAuthError } from '@feed/mcp';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  APPROVAL_COOKIE,
  browserAccount,
  browserBinding,
  jsonObject,
  newBrowserBinding,
  oauthBoundary,
  oauthResponse,
  oauthService,
  requestRateKey,
  requireBrowserOrigin,
} from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
async function verifyLimit(request: NextRequest) {
  const service = oauthService();
  await service.limit('device-verify:global', 2000);
  await service.limit(`device-verify-ip:${requestRateKey(request)}`, 30);
}
export const GET = withErrorHandling(async (request: NextRequest) =>
  oauthBoundary(async () => {
    const userId = await browserAccount(request);
    await verifyLimit(request);
    const binding = newBrowserBinding(request);
    const service = oauthService();
    let response: NextResponse;
    try {
      const info = await new FeedDeviceService(service).info(
        request.nextUrl.searchParams.get('user_code') ?? '',
        binding,
        userId
      );
      response = NextResponse.json(info, {
        headers: {
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      });
    } catch (error) {
      if (
        !(error instanceof OAuthError) ||
        !['profile_required', 'profile_incomplete'].includes(error.code)
      )
        throw error;
      response = NextResponse.json(
        { error: error.code },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } }
      );
    }
    response.cookies.set(APPROVAL_COOKIE, binding, {
      httpOnly: true,
      secure: service.origin.startsWith('https:'),
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    return response;
  })
);
export const POST = withErrorHandling(async (request: NextRequest) =>
  oauthBoundary(async () => {
    requireBrowserOrigin(request);
    const userId = await browserAccount(request);
    await verifyLimit(request);
    const parsed = deviceApprovalSchema.safeParse(await jsonObject(request));
    if (!parsed.success) throw new OAuthError('invalid_request');
    const { userCode, action, scopes } = parsed.data;
    return oauthResponse(
      await new FeedDeviceService(oauthService()).approve(
        userCode,
        browserBinding(request),
        userId,
        action,
        scopes
      )
    );
  })
);
