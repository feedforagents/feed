import { OAuthError } from '@feed/mcp';
import type { NextRequest } from 'next/server';
import {
  browserAccount,
  jsonObject,
  oauthBoundary,
  oauthResponse,
  oauthService,
  requireBrowserOrigin,
} from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
  return oauthBoundary(async () =>
    oauthResponse({
      grants: await oauthService().listGrants(await browserAccount(request)),
    })
  );
}
export async function DELETE(request: NextRequest) {
  return oauthBoundary(async () => {
    requireBrowserOrigin(request);
    const body = await jsonObject(request);
    if (typeof body.grantId !== 'string' || body.grantId.length > 100)
      throw new OAuthError('invalid_request');
    await oauthService().revokeGrant(
      await browserAccount(request),
      body.grantId
    );
    return oauthResponse({});
  });
}
