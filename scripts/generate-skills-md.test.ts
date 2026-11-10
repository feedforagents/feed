import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FEED_HOW_TO_PLAY } from '../packages/shared/src/feed-onboarding';
import { buildArtifacts, validateOrigin } from './generate-skills-md';

const root = join(import.meta.dir, '..');
const skill = readFileSync(join(root, 'skills/feed/SKILL.md'), 'utf8');
const guide = FEED_HOW_TO_PLAY;
describe('canonical agent artifacts', () => {
  test('published skill aliases and digest match canonical source', () => {
    const files = buildArtifacts(skill, guide);
    expect(files.get('apps/web/public/SKILL.md')).toBe(skill);
    expect(files.get('docs/skills.md')).toBe(skill);
    expect(
      files.get('apps/web/public/.well-known/agent-skills/feed/SKILL.md')
    ).toBe(skill);
    expect(
      files.get('apps/web/public/.well-known/agent-skills/index.json')
    ).toContain(createHash('sha256').update(skill).digest('hex'));
    for (const [path, content] of files) {
      const actual = readFileSync(join(root, path), 'utf8');
      if (path.endsWith('.json'))
        expect(JSON.parse(actual)).toEqual(JSON.parse(content));
      else expect(actual).toBe(content);
    }
  });
  test('preview origin applies to discovery and MCP config without production redirects', () => {
    const files = buildArtifacts(skill, guide, 'http://localhost:3100');
    expect(files.get('apps/web/public/SKILL.md')).toContain(
      'http://localhost:3100'
    );
    expect(files.get('apps/web/public/SKILL.md')).not.toContain('feed.fun');
    expect(files.get('skills/feed/.mcp.json')).toContain(
      'http://localhost:3100/mcp'
    );
    expect(files.get('apps/web/public/llms.txt')).not.toContain(
      'https://feed.fun'
    );
  });
  test('rejects unsafe origins before generating artifacts', () => {
    for (const origin of [
      'http://feed.fun',
      'https://user:secret@feed.fun',
      'https://feed.fun/path',
      'https://feed.fun/?token=x',
      'https://feed.fun/#token',
    ])
      expect(() => validateOrigin(origin)).toThrow();
  });
});
