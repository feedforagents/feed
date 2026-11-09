export type AgentEntryView = 'agent' | 'signin';
export const AGENT_INTRO_SEEN_KEY = 'feed:agent-intro:v1';

export function agentEntryView(
  preview: string | null,
  allowPreview: boolean
): AgentEntryView {
  return allowPreview && preview === 'signin' ? 'signin' : 'agent';
}

export class AgentSetupConfigurationError extends Error {}

/** Configuration, never an untrusted request Host, chooses the skill origin. */
export function agentSetupPrompt(configuredUrl?: string): string {
  let url: URL;
  try {
    url = new URL(configuredUrl ?? 'https://feed.fun');
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AgentSetupConfigurationError('Feed skill URL is invalid');
    }
    throw error;
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new AgentSetupConfigurationError(
      'Feed skill URL requires an HTTPS origin or local HTTP loopback host'
    );
  }
  return `Read ${url.origin}/SKILL.md and follow it to connect Feed and sign me in.`;
}

/** Unsupported agent origins must not prevent the existing Steward form rendering. */
export function agentSetupPromptForEntry(
  configuredUrl?: string
): string | null {
  try {
    return agentSetupPrompt(configuredUrl);
  } catch (error) {
    if (error instanceof AgentSetupConfigurationError) return null;
    throw error;
  }
}
