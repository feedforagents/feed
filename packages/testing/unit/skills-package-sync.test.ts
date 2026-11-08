import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  generateSkillsMarkdown,
  parseAgentCardSkills,
  parseExecutorOperations,
  parseMCPTools,
} from '../../../scripts/generate-skills-md';

const ROOT = resolve(import.meta.dir, '../../..');

function groupOperationsByPrefix(ops: string[]): Map<string, string[]> {
  const byPrefix = new Map<string, string[]>();
  for (const op of ops) {
    const dot = op.indexOf('.');
    const prefix = dot > 0 ? op.slice(0, dot) : 'other';
    const list = byPrefix.get(prefix) ?? [];
    list.push(op);
    byPrefix.set(prefix, list);
  }
  return byPrefix;
}

function buildExpected() {
  const skills = parseAgentCardSkills(
    readFileSync(join(ROOT, 'packages/a2a/src/feed-agent-card.ts'), 'utf-8')
  );
  const operations = parseExecutorOperations(
    readFileSync(
      join(ROOT, 'packages/a2a/src/executors/feed-executor.ts'),
      'utf-8'
    )
  );
  const mcpTools = parseMCPTools(
    readFileSync(join(ROOT, 'packages/mcp/src/server/mcp-server.ts'), 'utf-8')
  );
  const byPrefix = groupOperationsByPrefix(operations);
  return { skills, operations, mcpTools, byPrefix };
}

describe('generated agent skills artifacts stay in sync with live sources', () => {
  it('docs/skills.md matches the generator output', () => {
    const { skills, operations, mcpTools, byPrefix } = buildExpected();
    const expected = generateSkillsMarkdown(
      skills,
      operations,
      byPrefix,
      mcpTools,
      {}
    );
    const committed = readFileSync(join(ROOT, 'docs/skills.md'), 'utf-8');
    expect(committed).toBe(expected);
  });

  it('skills/feed/SKILL.md matches the generator output (package mode)', () => {
    const { skills, operations, mcpTools, byPrefix } = buildExpected();
    const expectedBody = generateSkillsMarkdown(
      skills,
      operations,
      byPrefix,
      mcpTools,
      { skipGeneratedNotice: true }
    );
    const committed = readFileSync(join(ROOT, 'skills/feed/SKILL.md'), 'utf-8');
    // Package SKILL.md is frontmatter + blank line + the generated body.
    const frontmatterEnd = committed.indexOf('\n---\n');
    expect(frontmatterEnd).toBeGreaterThan(0);
    expect(committed.slice(frontmatterEnd + 5).replace(/^\n/, '')).toBe(
      expectedBody
    );
  });

  it('does not advertise the retired peer-transfer capability (PRD D-18)', () => {
    const { operations, mcpTools } = buildExpected();
    // Ground truth: the capability is gone from the live sources.
    expect(operations).not.toContain('points.transfer');
    expect(mcpTools.map((tool) => tool.name)).not.toContain('transfer_points');
    // So the published artifacts must not promise it either.
    for (const artifact of ['docs/skills.md', 'skills/feed/SKILL.md']) {
      const content = readFileSync(join(ROOT, artifact), 'utf-8');
      expect(content).not.toContain('points.transfer');
      expect(content).not.toContain('transfer_points');
    }
  });
});
