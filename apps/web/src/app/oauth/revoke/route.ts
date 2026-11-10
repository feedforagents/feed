import { OAuthError } from '@feed/mcp';
import type { NextRequest } from 'next/server';
import {
  formParameters,
  oauthBoundary,
  oauthResponse,
  oauthService,
  requestRateKey,
} from '@/lib/auth/feed-oauth';
export async function POST(request: NextRequest) {
  return oauthBoundary(async () => {
    const service = oauthService();
    await service.limit(`revoke:${requestRateKey(request)}`, 120);
    const input = await formParameters(request);
    if (
      !input.token ||
      input.token.length > 200 ||
      !input.client_id ||
      input.client_id.length > 100
    )
      throw new OAuthError('invalid_request');
    await service.revokeToken(input.token, input.client_id);
    return oauthResponse({});
  });
}
