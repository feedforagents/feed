import { describe, expect, test } from 'bun:test';
import {
  failedTotalTokens,
  failedUsageOf,
  isUsableTokenCount,
} from '../direct-groq';

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

describe('isUsableTokenCount', () => {
  test('accepts finite non-negative numbers', () => {
    expect(isUsableTokenCount(0)).toBe(true);
    expect(isUsableTokenCount(82)).toBe(true);
  });

  test('rejects a negative count the provider could not measure', () => {
    expect(isUsableTokenCount(-1)).toBe(false);
  });

  test('rejects NaN and Infinity', () => {
    expect(isUsableTokenCount(Number.NaN)).toBe(false);
    expect(isUsableTokenCount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUsableTokenCount(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  test('rejects non-numbers', () => {
    expect(isUsableTokenCount('82')).toBe(false);
    expect(isUsableTokenCount(null)).toBe(false);
    expect(isUsableTokenCount(undefined)).toBe(false);
  });
});

describe('failedTotalTokens', () => {
  test('passes a provider-reported total through unchanged', () => {
    expect(
      failedTotalTokens({ inputTokens: 412, outputTokens: 3, totalTokens: 415 })
    ).toBe(415);
  });

  test('reports nothing when the provider reported no usage at all', () => {
    expect(failedTotalTokens(undefined)).toBeUndefined();
    expect(failedTotalTokens({})).toBeUndefined();
  });

  test('keeps an absent total absent when the parts are not reported either', () => {
    expect(failedTotalTokens({ totalTokens: undefined })).toBeUndefined();
  });

  test('sums the reported parts only when the provider omitted the total', () => {
    expect(failedTotalTokens({ inputTokens: 81, outputTokens: 1 })).toBe(82);
    expect(failedTotalTokens({ inputTokens: 12 })).toBe(12);
  });

  test('ignores a negative or non-finite total instead of passing it through', () => {
    expect(failedTotalTokens({ totalTokens: -1 })).toBeUndefined();
    expect(failedTotalTokens({ totalTokens: Number.NaN })).toBeUndefined();
    expect(
      failedTotalTokens({ totalTokens: Number.POSITIVE_INFINITY })
    ).toBeUndefined();
  });

  test('ignores a negative part instead of poisoning the sum', () => {
    expect(failedTotalTokens({ inputTokens: 81, outputTokens: -1 })).toBe(81);
    expect(failedTotalTokens({ inputTokens: -1 })).toBeUndefined();
  });
});
