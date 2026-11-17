import { describe, expect, it, mock } from 'bun:test';

mock.module('@feed/db', () => ({
  db: {},
  desc: () => undefined,
  eq: () => undefined,
  markets: {},
  questions: {},
  timeframedMarkets: {},
  users: {},
}));

const { redactUntilResolved } = await import('../_resolution-audit');

const stored = {
  resolution: true,
  resolvedAt: null,
  reviewStatus: 'pending',
  confidence: 0.42,
  description: 'Resolution text written before payout.',
  proofUrl: 'https://example.test/proof/1',
  resolvedBy: null,
};

describe('redactUntilResolved', () => {
  it('hides the stored resolution text, proof and confidence while the market is unresolved', () => {
    const audit = redactUntilResolved(stored, false);
    expect(audit.resolution).toBeNull();
    expect(audit.description).toBeNull();
    expect(audit.proofUrl).toBeNull();
    expect(audit.confidence).toBeNull();
    expect(audit.reviewStatus).toBe('pending');
  });

  it('shows them once the market has resolved', () => {
    expect(redactUntilResolved(stored, true)).toEqual(stored);
  });
});
