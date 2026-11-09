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
    await service.limit(`token:${requestRateKey(request)}`, 300);
    return oauthResponse(await service.exchange(await formParameters(request)));
  });
}
