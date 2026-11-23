import { describe, expect, test } from 'bun:test';
import { extractFirstJsonObject, parseDecisionJson } from '../decision-json';

describe('extractFirstJsonObject', () => {
  test('extracts raw JSON whose string payload contains a markdown code fence', () => {
    const decision = {
      thought: 'Share a position sizing snippet',
      action: 'POST',
      parameters: {
        content: 'Use:\n```ts\nconst size = 10;\n```\nbefore entering.',
      },
    };
    const raw = JSON.stringify(decision);

    const extracted = extractFirstJsonObject(raw);
    expect(extracted).toBe(raw);
    expect(parseDecisionJson(extracted!)).toEqual(decision);
  });

  test('extracts fenced JSON whose string payload contains a nested code fence, braces, and escaped quotes', () => {
    const decision = {
      thought: 'Share "} escaped quote and trailing backslash \\',
      action: 'COMMENT',
      parameters: {
        postId: 'post-1',
        content: 'Example:\n```\nconst cfg = { size: 42 };\n```',
      },
    };
    const raw = JSON.stringify(decision);
    const response = `\`\`\`json\n${raw}\n\`\`\``;

    const extracted = extractFirstJsonObject(response);
    expect(extracted).toBe(raw);
    expect(parseDecisionJson(extracted!)).toEqual(decision);
  });

  test('skips an earlier non-JSON code fence to extract the following JSON decision', () => {
    const decision = {
      thought: 'Open long after checking breakout level',
      action: 'TRADE',
      parameters: {
        marketId: 'BTC',
        marketType: 'perp',
        side: 'open_long',
        amount: 50,
      },
    };
    const raw = JSON.stringify(decision);
    const response = [
      'Scratch check:',
      '```js',
      'function breakout(p) { return p > 100; }',
      '```',
      '```json',
      raw,
      '```',
    ].join('\n');

    const extracted = extractFirstJsonObject(response);
    expect(extracted).toBe(raw);
    expect(parseDecisionJson(extracted!)).toEqual(decision);
  });

  test('skips non-JSON brace prose and unclosed stray braces before the valid JSON object', () => {
    const decision = {
      thought: 'Wait for a cleaner setup',
      action: 'WAIT',
      parameters: {},
    };
    const raw = JSON.stringify(decision);

    expect(extractFirstJsonObject(`Using {schema}: ${raw}`)).toBe(raw);
    expect(extractFirstJsonObject(`Draft {unclosed prefix\n${raw}`)).toBe(raw);
    expect(extractFirstJsonObject(`{ outer wrapper ${raw} }`)).toBe(raw);
  });

  test('falls back to the first balanced object when no valid JSON object exists', () => {
    expect(extractFirstJsonObject('{"action":}')).toBe('{"action":}');
    expect(extractFirstJsonObject('{first invalid} {second invalid}')).toBe(
      '{first invalid}'
    );
    expect(extractFirstJsonObject('{"action":"POST"')).toBeNull();
    expect(extractFirstJsonObject('plain text only')).toBeNull();
  });
});
