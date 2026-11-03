import { describe, expect, it } from 'bun:test';
import { WalletCreditNotAppliedError } from '@feed/shared';
import {
  classifyCreditFailure,
  isDefiniteWalletRejection,
} from './wallet-credit-outcome';

describe('classifyCreditFailure', () => {
  const notApplied = new Error(
    'User not found for wallet operation: u1. NPCs should have User records after bootstrap.'
  );
  const wrapped = new Error('query failed', { cause: notApplied });
  const lost = new Error('Connection terminated unexpectedly');

  it('treats a stored attempt id as applied', () => {
    expect(classifyCreditFailure(lost, true)).toBe('applied');
    expect(classifyCreditFailure(notApplied, true)).toBe('applied');
  });

  it('treats a failed probe as unknown', () => {
    expect(classifyCreditFailure(notApplied, null)).toBe('unknown');
    expect(classifyCreditFailure(lost, null)).toBe('unknown');
  });

  it('restores only a definite rejection when the row is absent', () => {
    expect(classifyCreditFailure(notApplied, false)).toBe('not_applied');
    expect(classifyCreditFailure(wrapped, false)).toBe('not_applied');
    expect(
      classifyCreditFailure(
        new WalletCreditNotAppliedError('wallet credit failed'),
        false
      )
    ).toBe('not_applied');
    expect(classifyCreditFailure(lost, false)).toBe('unknown');
    expect(isDefiniteWalletRejection(lost)).toBe(false);
    expect(isDefiniteWalletRejection(wrapped)).toBe(true);
  });
});
