import type { NextRequest } from 'next/server';
import {
  jsonObject,
  oauthBoundary,
  oauthResponse,
  oauthService,
  requestRateKey,
} from '@/lib/auth/feed-oauth';
export async function POST(request: NextRequest) {
  return oauthBoundary(async () => {
    const service = oauthService();
    await service.limit('register:global', 1000);
    await service.limit(`register:${requestRateKey(request)}`, 20);
    return oauthResponse(
      await service.register(await jsonObject(request)),
      201
    );
  });
}
