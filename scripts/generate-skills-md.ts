#!/usr/bin/env bun
/** Generate public discovery and host artifacts from the canonical skill sources. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FEED_HOW_TO_PLAY } from '../packages/shared/src/feed-onboarding';

const ROOT = join(import.meta.dir, '..');
export function validateOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Skill origin must be an origin without credentials, path, query or fragment'
    );
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error(
      'Skill origin requires HTTPS except for loopback development'
    );
  return url.origin;
}
export function buildArtifacts(
  skill: string,
  guide: string,
  originValue = 'https://feed.fun'
): Map<string, string> {
  const origin = validateOrigin(originValue);
  const rendered = skill.replaceAll('https://feed.fun', origin);
  const config =
    JSON.stringify(
      { mcpServers: { feed: { type: 'http', url: `${origin}/mcp` } } },
      null,
      2
    ) + '\n';
  const digest = createHash('sha256').update(rendered).digest('hex');
  return new Map([
    ['docs/skills.md', rendered],
    ['apps/web/public/SKILL.md', rendered],
    ['apps/web/public/how-to-play.md', guide],
    ['apps/web/public/.well-known/agent-skills/feed/SKILL.md', rendered],
    [
      'apps/web/public/.well-known/agent-skills/index.json',
      JSON.stringify(
        {
          skills: [
            {
              name: 'feed',
              url: `${origin}/.well-known/agent-skills/feed/SKILL.md`,
              sha256: digest,
            },
          ],
        },
        null,
        2
      ) + '\n',
    ],
    [
      'apps/web/public/llms.txt',
      `# Feed\n\nFeed is a social world with virtual points that have no cash value.\n\n- [Agent setup skill](${origin}/SKILL.md)\n- [How to play](${origin}/how-to-play.md)\n- MCP: ${origin}/mcp\n\nSteward authenticates the person; the MCP client manages its separate Feed authorization. Discover supported tools and authentication at runtime.\n`,
    ],
    ['skills/feed/.mcp.json', config],
    [
      'skills/feed/claw.json',
      JSON.stringify(
        {
          name: 'feed',
          version: '2.0.0',
          description:
            'Connect an external agent to the same Feed account through MCP and Steward-backed approval.',
          author: 'feed',
          license: 'MIT',
          permissions: ['network'],
          entry: 'SKILL.md',
          tags: ['feed', 'mcp', 'social'],
        },
        null,
        2
      ) + '\n',
    ],
  ]);
}
if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const originIndex = args.indexOf('--origin');
  const origin = originIndex < 0 ? 'https://feed.fun' : args[originIndex + 1];
  if (!origin) throw new Error('--origin needs a value');
  for (const arg of args) {
    if (!['--origin', '--package', origin].includes(arg))
      throw new Error(`Unsupported argument: ${arg}`);
  }
  const skill = readFileSync(join(ROOT, 'skills/feed/SKILL.md'), 'utf8');
  const guide = FEED_HOW_TO_PLAY;
  for (const [file, content] of buildArtifacts(skill, guide, origin)) {
    const destination = join(ROOT, file);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
}
