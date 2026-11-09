import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  APPROVAL_COOKIE,
  newBrowserBinding,
  oauthBoundary,
  oauthService,
  requestRateKey,
  singleParameters,
} from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return oauthBoundary(async () => {
    const service = oauthService();
    await service.limit(`authorize:${requestRateKey(request)}`, 60);
    const binding = newBrowserBinding(request);
    const destination = await service.authorize(
      singleParameters(request.nextUrl.searchParams),
      binding
    );
    const response = NextResponse.redirect(destination);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.cookies.set(APPROVAL_COOKIE, binding, {
      httpOnly: true,
      secure: service.origin.startsWith('https:'),
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    return response;
  });
}
