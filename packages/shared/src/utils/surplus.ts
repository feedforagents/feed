/** One OpenAI-compatible inference endpoint for Feed's server-side callers. */
export function getSurplusConfig() {
  const apiKey = process.env.SURPLUS_API_KEY;
  if (!apiKey) return undefined;
  const contextTokens = process.env.SURPLUS_CONTEXT_TOKENS
    ? Number(process.env.SURPLUS_CONTEXT_TOKENS)
    : undefined;
  if (
    contextTokens !== undefined &&
    (!Number.isSafeInteger(contextTokens) || contextTokens <= 0)
  ) {
    throw new Error('SURPLUS_CONTEXT_TOKENS must be a positive integer');
  }
  return {
    apiKey,
    contextTokens,
    baseURL: (
      process.env.SURPLUS_BASE_URL || 'https://api.surplusintelligence.ai/v1'
    ).replace(/\/$/, ''),
    model: process.env.SURPLUS_MODEL || 'gpt-4o-mini',
  };
}
