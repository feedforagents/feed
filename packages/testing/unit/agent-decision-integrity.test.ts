import { describe, expect, test } from 'bun:test';
import { parseDecisionJson } from '../../agents/src/autonomous/decision-json';
import { fitSectionsWithinBudget } from '../../agents/src/autonomous/templates/multi-step-decision';

describe('agent decision integrity', () => {
  const decision = {
    action: 'WAIT',
    thought: 'No actionable signal',
    isFinish: true,
    parameters: {},
  };
  test('accepts a legacy boolean but excludes it from parsed decision data', () => {
    expect(parseDecisionJson(JSON.stringify(decision))).toEqual({
      action: 'WAIT',
      thought: 'No actionable signal',
      parameters: {},
    });
  });
  test('accepts a decision without the derived finish flag', () => {
    expect(
      parseDecisionJson(
        JSON.stringify({
          action: 'TRADE',
          thought: 'Signal improves',
          parameters: { marketId: 'm' },
        })
      )
    ).toEqual({
      action: 'TRADE',
      thought: 'Signal improves',
      parameters: { marketId: 'm' },
    });
  });
  test('rejects a supplied nonboolean legacy finish flag', () => {
    for (const value of [null, 'true', 0, [], {}]) {
      expect(() =>
        parseDecisionJson(JSON.stringify({ ...decision, isFinish: value }))
      ).toThrow();
    }
  });
  test('rejects missing and invalid required fields', () => {
    for (const field of ['action', 'thought', 'parameters']) {
      for (const value of [null, undefined, 123, []]) {
        expect(() =>
          parseDecisionJson(JSON.stringify({ ...decision, [field]: value }))
        ).toThrow();
      }
    }
    expect(() => parseDecisionJson('{}')).toThrow();
    expect(() => parseDecisionJson('{')).toThrow();
  });
});

describe('complete prompt assembly', () => {
  test('never silently drops required or lower-priority context', () => {
    const sections = [
      { name: 'identity', priority: 1, content: 'Character identity' },
      {
        name: 'portfolio',
        priority: 2,
        content: 'Complete portfolio and risk',
      },
      {
        name: 'messages',
        priority: 4,
        content: 'Conversation qualifier at the end',
      },
    ];
    expect(() => fitSectionsWithinBudget(sections, 5)).toThrow(
      'no sections were dropped'
    );
    const result = fitSectionsWithinBudget(sections, 100);
    expect(result.prompt).toBe(sections.map((s) => s.content).join('\n'));
    expect(Object.keys(result.breakdown.sections)).toEqual([
      'identity',
      'portfolio',
      'messages',
    ]);
  });
});
