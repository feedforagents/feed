import { serveFeedMcp } from '@feed/mcp';
import { FEED_ABOUT, FEED_HOW_TO_PLAY } from '@feed/shared';
import type { NextRequest } from 'next/server';
import { oauthBoundary, oauthService } from '@/lib/auth/feed-oauth';
import {
  GET as legacyGet,
  POST as legacyPost,
} from '@/lib/auth/legacy-mcp-route';
export const dynamic = 'force-dynamic';
function isLegacyKeyRequest(request: NextRequest): boolean {
  return (
    request.headers.has('x-feed-api-key') ||
    /^Bearer bab_live_[a-f0-9]{64}$/.test(
      request.headers.get('authorization') ?? ''
    )
  );
}
export async function POST(request: NextRequest) {
  if (isLegacyKeyRequest(request)) return legacyPost(request);
  return oauthBoundary(() =>
    serveFeedMcp(request, oauthService(), {
      about: FEED_ABOUT,
      howToPlay: FEED_HOW_TO_PLAY,
    })
  );
}
export async function GET(request: NextRequest) {
  if (isLegacyKeyRequest(request)) return legacyGet(request);
  return new Response(null, {
    status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
  });
}
