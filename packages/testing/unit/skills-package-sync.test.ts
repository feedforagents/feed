import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
describe('published skill safety and source ownership', () => {
  it('publishes the canonical instructions unchanged at both discovery URLs', () => {
    const source = readFileSync(join(ROOT, 'skills/feed/SKILL.md'), 'utf8');
    for (const path of [
      'docs/skills.md',
      'apps/web/public/SKILL.md',
      'apps/web/public/.well-known/agent-skills/feed/SKILL.md',
    ])
      expect(readFileSync(join(ROOT, path), 'utf8')).toBe(source);
  });
  it('removes retired transfer, payment, and old authentication instructions', () => {
    for (const path of ['skills/feed/SKILL.md', 'docs/skills.md']) {
      const content = readFileSync(join(ROOT, path), 'utf8');
      for (const retired of [
        'points.transfer',
        'transfer_points',
        'X-Feed-Api-Key',
        '/api/a2a',
        'x402',
        '/api/mcp',
      ])
        expect(content).not.toContain(retired);
      expect(content).toContain('Steward');
      expect(content).toContain('whoami');
      expect(content).toContain('tools/list');
    }
  });
});
