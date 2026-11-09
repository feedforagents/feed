import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ConnectedGrant,
  initialConnections,
} from '@/lib/auth/connected-agents';
import { ConnectedAgentsView } from './ConnectedAgentsTab';

const grant: ConnectedGrant = {
  id: 'grant-1',
  clientName: 'My <agent>',
  scopes: ['read', 'messages'],
  createdAt: '2026-11-09T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2099-11-09T00:00:00.000Z',
  revokedAt: null,
};
const callbacks = {
  onRefresh: () => {},
  onDisconnect: () => {},
  onConfirm: () => {},
  onCancel: () => {},
};
describe('Connected agents settings view', () => {
  test('distinguishes loading, empty and failure without inventing an empty list on errors', () => {
    const base = initialConnections('owner');
    expect(
      renderToStaticMarkup(
        <ConnectedAgentsView {...callbacks} state={base} confirmingId={null} />
      )
    ).toContain('Loading connected agents');
    expect(
      renderToStaticMarkup(
        <ConnectedAgentsView
          {...callbacks}
          state={{ ...base, phase: 'ready' }}
          confirmingId={null}
        />
      )
    ).toContain('No agents connected yet');
    const failed = renderToStaticMarkup(
      <ConnectedAgentsView
        {...callbacks}
        state={{ ...base, phase: 'error', error: 'Request failed' }}
        confirmingId={null}
      />
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Try again');
    expect(failed).not.toContain('No agents connected yet');
  });
  test('shows returned names, permissions and date fields without invented activity or origins', () => {
    const html = renderToStaticMarkup(
      <ConnectedAgentsView
        {...callbacks}
        state={{
          ...initialConnections('owner'),
          phase: 'ready',
          grants: [grant],
        }}
        confirmingId={null}
      />
    );
    expect(html).toContain('My &lt;agent&gt;');
    expect(html).toContain('Names are supplied by the connected apps');
    expect(html).toContain('Read and send messages');
    expect(html).toContain('Not used yet');
    expect(html).toMatch(/datetime="2026-11-09T00:00:00.000Z"/i);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('<script');
  });
  test('revoked grants have no disconnect control, and active grants require confirmation', () => {
    const base = {
      ...initialConnections('owner'),
      phase: 'ready' as const,
      grants: [grant],
    };
    const confirming = renderToStaticMarkup(
      <ConnectedAgentsView
        {...callbacks}
        state={base}
        confirmingId={grant.id}
      />
    );
    expect(confirming).toContain('Confirm disconnect');
    expect(confirming).toContain('Cancel');
    const revoked = renderToStaticMarkup(
      <ConnectedAgentsView
        {...callbacks}
        state={{
          ...base,
          grants: [{ ...grant, revokedAt: '2026-11-10T00:00:00.000Z' }],
        }}
        confirmingId={null}
      />
    );
    expect(revoked).toContain('Disconnected');
    expect(revoked).not.toContain('data-disconnect-id');
    expect(revoked).not.toContain('Confirm disconnect');
  });
});
