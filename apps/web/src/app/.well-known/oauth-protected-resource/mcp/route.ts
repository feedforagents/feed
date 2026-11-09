import { FEED_MCP_CAPABILITIES } from '@feed/mcp';
import { oauthResponse, oauthService } from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
export function GET() {
  const { origin, resource } = oauthService();
  return oauthResponse({
    resource,
    authorization_servers: [origin],
    scopes_supported: FEED_MCP_CAPABILITIES.scopes,
    bearer_methods_supported: ['header'],
  });
}
