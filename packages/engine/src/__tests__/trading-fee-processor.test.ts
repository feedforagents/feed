/**
 * Shared trading fee processor adapter tests.
 *
 * The adapter itself is the only place that maps a FeeProcessor call to
 * FeeService.processTradingFee, so this test stubs that static method and
 * asserts the argument order and the absence of a transaction argument.
 * It does not touch the database: processTradingFee is replaced before
 * the adapter is invoked.
 */

import { describe, expect, mock, test } from 'bun:test';
import { createTradingFeeProcessor, FeeService } from '../services/fee-service';

describe('createTradingFeeProcessor', () => {
  test('delegates to FeeService.processTradingFee with the canonical order', async () => {
    const processTradingFeeMock = mock(async () => ({
      feeCharged: 0,
      referrerPaid: 0,
    }));
    const original = FeeService.processTradingFee;
    // @ts-expect-error test stub replaces the static method
    FeeService.processTradingFee = processTradingFeeMock;
    try {
      const processor = createTradingFeeProcessor();
      await processor.processTradingFee({
        userId: 'user-1',
        amount: 0.5,
        type: 'perp_open',
        relatedId: 'rel-1',
        positionId: 'pos-1',
        operationId: 'key-1',
      });
      expect(processTradingFeeMock).toHaveBeenCalledWith(
        'user-1',
        'perp_open',
        0.5,
        'pos-1',
        'rel-1',
        undefined,
        'key-1'
      );
      expect(processTradingFeeMock).toHaveBeenCalledTimes(1);
    } finally {
      FeeService.processTradingFee = original;
    }
  });
});
