/** Compatibility exports for the API-key gate shared by A2A and MCP. */
export {
  A2A_API_KEY_HEADER,
  type ApiKeyAuthConfig,
  type AuthRequest,
  type AuthResult,
  clearApiKeyCache,
  getApiKeyCacheStats,
  getRequiredApiKey,
  getServerApiKey,
  invalidateCachedKey,
  invalidateCachedKeysForUser,
  isLocalHost,
  validateApiKey,
  validateApiKeyAsync,
  validateUserApiKey,
} from '@feed/api';
