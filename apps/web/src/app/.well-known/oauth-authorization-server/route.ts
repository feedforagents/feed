import { FEED_MCP_CAPABILITIES } from '@feed/mcp';
import { oauthResponse, oauthService } from '@/lib/auth/feed-oauth';
export const dynamic = 'force-dynamic';
export function GET() {
  const service = oauthService();
  const { origin } = service;
  return oauthResponse({
    issuer: origin,
    client_id_metadata_document_supported: service.cimdEnabled,
    device_authorization_endpoint: `${origin}/oauth/device/authorization`,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: FEED_MCP_CAPABILITIES.grantTypes,
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: FEED_MCP_CAPABILITIES.scopes,
    authorization_response_iss_parameter_supported: true,
  });
}
