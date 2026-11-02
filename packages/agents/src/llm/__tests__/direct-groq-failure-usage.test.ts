import { describe, expect, test } from 'bun:test';
import { failedUsageOf } from '../direct-groq';

describe('failedUsageOf', () => {
  test('reads provider-reported usage carried on the error itself', () => {
    const error = Object.assign(new Error('completion filtered by provider'), {
      usage: { inputTokens: 412, outputTokens: 3, totalTokens: 415 },
    });

    expect(failedUsageOf(error)).toEqual({
      inputTokens: 412,
      outputTokens: 3,
      totalTokens: 415,
    });
  });

  test('reads usage the SDK nests on the error cause', () => {
    const error = Object.assign(new Error('wrapped failure'), {
      cause: { usage: { inputTokens: 31, outputTokens: 2, totalTokens: 33 } },
    });

    expect(failedUsageOf(error)).toEqual({
      inputTokens: 31,
      outputTokens: 2,
      totalTokens: 33,
    });
  });

  test('reports nothing for a transport error instead of an estimate', () => {
    expect(failedUsageOf(new Error('socket hang up'))).toBeUndefined();
  });

  test('ignores a usage object whose fields are not numbers', () => {
    const error = Object.assign(new Error('odd payload'), {
      usage: { inputTokens: '412', outputTokens: null },
    });

    expect(failedUsageOf(error)).toBeUndefined();
  });

  test('keeps partial usage when only some fields are reported', () => {
    const error = Object.assign(new Error('partial usage'), {
      usage: { inputTokens: 12 },
    });

    expect(failedUsageOf(error)).toEqual({
      inputTokens: 12,
      outputTokens: undefined,
      totalTokens: undefined,
    });
  });

  test('tolerates a non-object error', () => {
    expect(failedUsageOf('boom')).toBeUndefined();
    expect(failedUsageOf(undefined)).toBeUndefined();
    expect(failedUsageOf(null)).toBeUndefined();
  });
});
