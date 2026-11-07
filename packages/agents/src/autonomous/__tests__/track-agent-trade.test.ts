import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as api from '@feed/api';
import { trackAgentTradeExecuted } from '../track-agent-trade';

const originalAnalyticsKey = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;

afterEach(() => {
  if (originalAnalyticsKey === undefined) {
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
  } else {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID = originalAnalyticsKey;
  }
});

describe('trackAgentTradeExecuted', () => {
  test('NPC trade tracking never invokes retired hosted-agent rewards', () => {
    const checkProgress = spyOn(api, 'checkProgress');
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_ID;
    try {
      expect(() =>
        trackAgentTradeExecuted('ailon-musk', {
          agent_id: 'ailon-musk',
          market_type: 'prediction',
          action: 'buy_yes',
          owner_id: 'ailon-musk',
        })
      ).not.toThrow();
      expect(checkProgress).not.toHaveBeenCalled();
    } finally {
      checkProgress.mockRestore();
    }
  });
});
