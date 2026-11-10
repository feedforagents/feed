import { describe, expect, test } from 'bun:test';
import {
  accountConnections,
  type ConnectedGrant,
  connectedAgentsReducer,
  connectionStatus,
  initialConnections,
} from '../../../apps/web/src/lib/auth/connected-agents';

const grant: ConnectedGrant = {
  id: 'connection-1',
  clientName: 'My agent',
  scopes: ['read'],
  createdAt: '2026-11-09T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-12-09T00:00:00.000Z',
  revokedAt: null,
};
describe('connected-agent owner and request isolation', () => {
  test('ignores owner A results and failures after switching to owner B', () => {
    let state = connectedAgentsReducer(initialConnections('A'), {
      type: 'start',
      ownerId: 'A',
      requestId: 1,
    });
    state = connectedAgentsReducer(state, {
      type: 'start',
      ownerId: 'B',
      requestId: 2,
    });
    const current = state;
    state = connectedAgentsReducer(state, {
      type: 'loaded',
      ownerId: 'A',
      requestId: 1,
      grants: [grant],
    });
    expect(state).toBe(current);
    state = connectedAgentsReducer(state, {
      type: 'failed',
      ownerId: 'A',
      requestId: 1,
      error: 'old error',
    });
    expect(state).toBe(current);
    expect(state.grants).toEqual([]);
  });
  test('a slower earlier refresh cannot replace a newer list for the same owner', () => {
    let state = connectedAgentsReducer(initialConnections('A'), {
      type: 'start',
      ownerId: 'A',
      requestId: 2,
    });
    state = connectedAgentsReducer(state, {
      type: 'loaded',
      ownerId: 'A',
      requestId: 2,
      grants: [grant],
    });
    expect(
      connectedAgentsReducer(state, {
        type: 'loaded',
        ownerId: 'A',
        requestId: 1,
        grants: [],
      })
    ).toBe(state);
  });
  test('sign-out discards data and pending disconnect results', () => {
    let state = connectedAgentsReducer(initialConnections('A'), {
      type: 'start',
      ownerId: 'A',
      requestId: 1,
    });
    state = connectedAgentsReducer(state, {
      type: 'loaded',
      ownerId: 'A',
      requestId: 1,
      grants: [grant],
    });
    state = connectedAgentsReducer(state, {
      type: 'disconnecting',
      ownerId: 'A',
      requestId: 1,
      grantId: grant.id,
    });
    state = connectedAgentsReducer(state, { type: 'signed-out', requestId: 2 });
    expect(state.ownerId).toBeNull();
    expect(state.pendingId).toBeNull();
    expect(state.grants).toEqual([]);
    expect(
      connectedAgentsReducer(state, {
        type: 'loaded',
        ownerId: 'A',
        requestId: 1,
        grants: [grant],
        notice: 'Disconnected',
      })
    ).toBe(state);
  });
  test('only an account-bound validated response can reach the view', () => {
    expect(
      accountConnections({ accountId: 'B', grants: [grant] }, 'A')
    ).toEqual({ ok: false, error: 'account_changed' });
    expect(accountConnections({ grants: [grant] }, 'A')).toEqual({
      ok: false,
      error: 'invalid_response',
    });
    expect(
      accountConnections(
        { accountId: 'A', grants: [{ ...grant, expiresAt: 'not-a-date' }] },
        'A'
      ).ok
    ).toBe(false);
    const result = accountConnections(
      {
        accountId: 'A',
        grants: [{ ...grant, access_token: 'must-not-be-retained' }],
      },
      'A'
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('must-not-be-retained');
  });
  test('uses actual revocation and expiry fields, with revoked state taking precedence', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    expect(connectionStatus(grant, now)).toBe('connected');
    expect(
      connectionStatus({ ...grant, expiresAt: '2026-11-09T12:00:00Z' }, now)
    ).toBe('expired');
    expect(
      connectionStatus(
        {
          ...grant,
          revokedAt: '2026-11-09T01:00:00Z',
          expiresAt: '2026-11-09T12:00:00Z',
        },
        now
      )
    ).toBe('revoked');
  });
});
