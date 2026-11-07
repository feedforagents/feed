import { describe, expect, test } from 'bun:test';
import {
  executeDirectShareInformation,
  normalizeShareKeywords,
} from '../intel-payment-executors';

describe('normalizeShareKeywords', () => {
  test('dedupes, lowercases, drops blanks and bounds count/length', () => {
    expect(
      normalizeShareKeywords(['  ACME ', 'acme', '', '   ', 'Deal'])
    ).toEqual(['acme', 'deal']);
    expect(
      normalizeShareKeywords(Array.from({ length: 20 }, (_, i) => `k${i}`))
    ).toHaveLength(10);
    expect(normalizeShareKeywords(['x'.repeat(100)])[0]).toHaveLength(64);
  });
});

describe('executeDirectShareInformation', () => {
  test('whitespace-only keywords fail validation without touching the DB', async () => {
    const result = await executeDirectShareInformation({
      agentUserId: 'a',
      recipientId: 'b',
      keywords: ['  ', ''],
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('At least one keyword is required');
  });
});
