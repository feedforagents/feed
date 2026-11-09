import { DEVICE_GRANT_TYPE, FeedDeviceService } from '@feed/mcp';
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
    await service.limit('token-ingress:global', 15000);
    await service.limit(`token-ingress-ip:${requestRateKey(request)}`, 1500);
    const body = await formParameters(request);
    if (body.grant_type === DEVICE_GRANT_TYPE) {
      await service.limit('device-poll:global', 10000);
      await service.limit(`device-poll-ip:${requestRateKey(request)}`, 1000);
      await service.limit(`device-poll-client:${body.client_id ?? ''}`, 1000);
      const result = await new FeedDeviceService(service).poll(body);
      return oauthResponse(result, 'error' in result ? 400 : 200);
    }
    await service.limit(`token:${requestRateKey(request)}`, 300);
    return oauthResponse(await service.exchange(body));
  });
}
