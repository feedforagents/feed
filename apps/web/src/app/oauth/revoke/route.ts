import { clientIdSchema, OAuthError } from '@feed/mcp';
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
    const clientId = clientIdSchema.safeParse(input.client_id);
    if (!input.token || input.token.length > 200 || !clientId.success)
      throw new OAuthError('invalid_request');
    await service.revokeToken(input.token, clientId.data);
    return oauthResponse({});
  });
}
