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
    const pretty = JSON.stringify(decision, null, 2);

    expect(extractFirstJsonObject(`Using {schema}: ${raw}`)).toBe(raw);
    expect(extractFirstJsonObject(`Draft {unclosed prefix\n${raw}`)).toBe(raw);
    expect(extractFirstJsonObject(`\`\`\`json\n${pretty}\n\`\`\``)).toBe(
      pretty
    );
  });

  test('does not descend into a truncated or malformed outer JSON object to run a nested object', () => {
    const truncatedOuter =
      '{"thought":"compared two options","rejected":{"thought":"buy","action":"TRADE","parameters":{"marketId":"m1","marketType":"prediction","side":"buy_yes","amount":500}},"action":"WAIT","parameters":{"reason":"too ris';
    expect(extractFirstJsonObject(truncatedOuter)).toBeNull();

    const malformedOuter =
      '{"decision":{"thought":"sell","action":"TRADE","parameters":{"marketId":"m1","marketType":"prediction","side":"sell_yes","amount":0}}, oops}';
    expect(extractFirstJsonObject(malformedOuter)).toBe(malformedOuter);
    expect(() => parseDecisionJson(malformedOuter)).toThrow(SyntaxError);
  });

  test('preserves malformed-JSON fallback, empty objects, and linear-time failure on repeated braces', () => {
    expect(extractFirstJsonObject('{"action":}')).toBe('{"action":}');
    expect(extractFirstJsonObject('{}')).toBe('{}');
    expect(extractFirstJsonObject('{"action":"POST"')).toBeNull();
    expect(extractFirstJsonObject('plain text only')).toBeNull();

    const startedAt = performance.now();
    expect(extractFirstJsonObject('{'.repeat(100_000))).toBeNull();
    expect(extractFirstJsonObject('{"'.repeat(50_000))).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(250);
  });
});
