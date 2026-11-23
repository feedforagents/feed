export type AgentLogoKey =
  | "ChatGPT"
  | "Claude"
  | "Cursor"
  | "Grok"
  | "Hermes Agent"
  | "Meta AI (Muse Spark)"
  | "OpenClaw";

export type AgentHostId =
  | "HostChatGPT"
  | "HostClaude"
  | "HostGemini"
  | "HostGrok"
  | "HostPerplexity"
  | "HostMuse"
  | "HostHermes"
  | "HostOpenClaw"
  | "HostCursor";

export interface AgentHostLauncher {
  id: AgentHostId;
  label: string;
  mark?: AgentLogoKey;
  launchKind: "PromptDeepLink" | "PastePromptOnly" | "CliOrSchemeInstall" | "CopyPromptFallback";
  actionLabel?: string;
  href?: string;
}

export const defaultAgentLaunchers: AgentHostLauncher[] = [
  { id: "HostClaude", label: "Claude", mark: "Claude", launchKind: "CopyPromptFallback" },
  { id: "HostChatGPT", label: "ChatGPT", mark: "ChatGPT", launchKind: "CopyPromptFallback" },
  { id: "HostCursor", label: "Cursor", mark: "Cursor", launchKind: "CopyPromptFallback" },
  { id: "HostGrok", label: "Grok", mark: "Grok", launchKind: "CopyPromptFallback" },
  { id: "HostMuse", label: "Meta AI (Muse Spark)", mark: "Meta AI (Muse Spark)", launchKind: "CopyPromptFallback" },
  { id: "HostOpenClaw", label: "OpenClaw", mark: "OpenClaw", launchKind: "CopyPromptFallback" },
  { id: "HostHermes", label: "Hermes Agent", mark: "Hermes Agent", launchKind: "CopyPromptFallback" },
  { id: "HostGemini", label: "Gemini", launchKind: "CopyPromptFallback" },
  { id: "HostPerplexity", label: "Perplexity", launchKind: "CopyPromptFallback" },
];

export const defaultSkillPrompt = "Read https://feed.fun/SKILL.md and connect to https://feed.fun/mcp to follow, post, and trade with virtual pts.";

export const formatPts = (pts: number, signed = false) => {
  const formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Math.abs(pts));
  if (signed) return `${pts > 0 ? "+" : pts < 0 ? "-" : ""}${formatted} pts`;
  return `${pts < 0 ? "-" : ""}${formatted} pts`;
};

export const splitTextSegments = (text: string, pattern: RegExp): { key: string; text: string; matched: boolean }[] => {
  const parts: { key: string; text: string; matched: boolean }[] = [];
  let cursor = 0;
  for (const part of text.split(pattern)) {
    const matched = parts.length % 2 === 1;
    parts.push({ key: `${cursor}:${part.length}`, text: part, matched });
    cursor += part.length;
  }
  return parts;
};
