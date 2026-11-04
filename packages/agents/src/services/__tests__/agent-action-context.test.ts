import { describe, expect, it } from 'bun:test';
import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import {
  formatClockTime,
  formatRelativeTime,
} from '../../plugins/conversation-time';
import { actionStateProvider } from '../../plugins/plugin-agent-core/src/providers/action-state';
import { formatAgentActionResults } from '../agent-action-context';

const runtime = {} as IAgentRuntime;
const message = { content: {} } as Memory;

function stateWith(actionResults: object[]): State {
  return { values: {}, data: { actionResults }, text: '' } as State;
}

const results = [
  {
    actionType: 'BUY_SHARES',
    success: true,
    text: 'Bought 10 YES',
    values: { shares: 10, marketId: 'm1' },
    timestamp: 1,
  },
  {
    actionType: 'SELL_SHARES',
    success: false,
    text: 'Sell failed',
    error: 'Insufficient shares',
    timestamp: 2,
  },
];

describe('ACTION_STATE providers', () => {
  it('renders action results with the shared formatter', async () => {
    const result = await actionStateProvider.get(
      runtime,
      message,
      stateWith(results)
    );
    const expected = formatAgentActionResults(results);
    expect(result.values?.actionResults).toBe(expected);
    expect(result.text).toBe(`# Actions Taken This Request\n\n${expected}`);
    expect(result.values?.completedActions).toBe(1);
    expect(result.values?.failedActions).toBe(1);
    expect(result.values?.totalActions).toBe(2);
  });

  it('drops malformed action entries', async () => {
    const state = stateWith([...results, { actionType: 42 }, null]);
    const a = await actionStateProvider.get(runtime, message, state);
    expect(a.values?.totalActions).toBe(2);
  });

  it('reports no actions when state has none', async () => {
    const result = await actionStateProvider.get(runtime, message, {
      values: {},
      data: {},
      text: '',
    } as State);
    expect(result.text).toBe('No actions taken yet.');
    expect(result.values?.actionResults).toBe(
      'No actions taken yet in this request.'
    );
  });
});

describe('conversation time formatting', () => {
  it('formats HH:MM with zero padding', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 7, 5))).toBe('07:05');
  });

  it('formats relative times', () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now))).toBe('just now');
    expect(formatRelativeTime(new Date(now - 5 * 60_000))).toBe('5m ago');
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000))).toBe('3h ago');
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000))).toBe('2d ago');
  });
});
