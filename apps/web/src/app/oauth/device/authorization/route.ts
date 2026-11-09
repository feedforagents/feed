import { FeedDeviceService } from '@feed/mcp';
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
    await service.limit('device-start:global', 2000);
    await service.limit(`device-start-ip:${requestRateKey(request)}`, 20);
    const body = await formParameters(request);
    await service.limit(`device-start-client:${body.client_id ?? ''}`, 60);
    return oauthResponse(
      await new FeedDeviceService(service.origin).start(body)
    );
  });
}
