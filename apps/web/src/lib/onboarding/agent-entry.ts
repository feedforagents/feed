export type AgentEntryView = 'agent' | 'signin';
export const AGENT_INTRO_SEEN_KEY = 'feed:agent-intro:v1';

export function agentEntryView(
  preview: string | null,
  allowPreview: boolean
): AgentEntryView {
  return allowPreview && preview === 'signin' ? 'signin' : 'agent';
}

/** Configuration, never an untrusted request Host, chooses the skill origin. */
export function agentSetupPrompt(configuredUrl?: string): string {
  const url = new URL(configuredUrl || 'https://feed.fun');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error('Feed skill URL requires HTTPS or local development');
  }
  return `Read ${url.origin}/SKILL.md and follow it to connect Feed and sign me in.`;
}
