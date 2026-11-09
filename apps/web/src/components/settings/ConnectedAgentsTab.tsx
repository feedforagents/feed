'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import {
  accountConnections,
  type ConnectedAgentsState,
  type ConnectedGrant,
  connectedAgentsReducer,
  connectionStatus,
  initialConnections,
} from '@/lib/auth/connected-agents';

class ConnectionRequestError extends Error {}
function expectedFailure(error: unknown): string | null {
  if (error instanceof ConnectionRequestError) return error.message;
  if (error instanceof TypeError || error instanceof SyntaxError)
    return 'Could not reach Feed. Check your connection and refresh.';
  return null;
}
async function fetchGrants(
  ownerId: string,
  signal: AbortSignal
): Promise<ConnectedGrant[]> {
  const response = await fetch('/oauth/consents', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (!response.ok)
    throw new ConnectionRequestError(
      response.status === 401
        ? 'Your sign-in expired. Sign in again, then refresh.'
        : 'Could not load connected agents. Try refreshing.'
    );
  const result = accountConnections(await response.json(), ownerId);
  if (!result.ok && result.error === 'account_changed')
    throw new ConnectionRequestError(
      'Your Feed account changed. Refresh to load its connections.'
    );
  if (!result.ok)
    throw new ConnectionRequestError(
      'Feed returned an unreadable connection list. Try refreshing.'
    );
  return result.grants;
}

export function ConnectedAgentsTab() {
  const { user, authenticated, loadingProfile, profileFetchStatus, refresh } =
    useAuth();
  const ownerId =
    authenticated && !loadingProfile && profileFetchStatus === 'done'
      ? (user?.id ?? null)
      : null;
  const owner = useRef(ownerId);
  owner.current = ownerId;
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const disconnecting = useRef(false);
  const [state, dispatch] = useReducer(
    connectedAgentsReducer,
    ownerId,
    initialConnections
  );
  const [confirmation, setConfirmation] = useState<{
    ownerId: string;
    grantId: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (owner.current !== ownerId) return;
    controller.current?.abort();
    const requestId = ++sequence.current;
    disconnecting.current = false;
    if (!ownerId) {
      dispatch({ type: 'signed-out', requestId });
      return;
    }
    if (owner.current !== ownerId) return;
    const active = new AbortController();
    controller.current = active;
    dispatch({ type: 'start', ownerId, requestId });
    try {
      const grants = await fetchGrants(ownerId, active.signal);
      if (!active.signal.aborted && owner.current === ownerId)
        dispatch({ type: 'loaded', ownerId, requestId, grants });
    } catch (error) {
      if (active.signal.aborted || owner.current !== ownerId) return;
      const message = expectedFailure(error);
      if (message === null) throw error;
      dispatch({ type: 'failed', ownerId, requestId, error: message });
    }
  }, [ownerId]);
  useEffect(() => {
    setConfirmation(null);
    void load();
    return () => controller.current?.abort();
  }, [load]);

  const disconnect = async (grantId: string) => {
    if (!ownerId || owner.current !== ownerId || disconnecting.current) return;
    const active = controller.current;
    if (!active || active.signal.aborted) return;
    disconnecting.current = true;
    const requestId = sequence.current;
    dispatch({ type: 'disconnecting', ownerId, requestId, grantId });
    try {
      const response = await fetch('/oauth/consents', {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: active.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grantId }),
      });
      if (!response.ok)
        throw new ConnectionRequestError(
          response.status === 401
            ? 'Your sign-in expired. Sign in again, then refresh.'
            : 'Could not disconnect this agent. Refresh to check its current status.'
        );
      const grants = await fetchGrants(ownerId, active.signal);
      const remaining = grants.find((grant) => grant.id === grantId);
      if (remaining && !remaining.revokedAt)
        throw new ConnectionRequestError(
          'The agent is still connected. Refresh before trying again.'
        );
      if (!active.signal.aborted && owner.current === ownerId) {
        setConfirmation(null);
        dispatch({
          type: 'loaded',
          ownerId,
          requestId,
          grants,
          notice: 'Agent disconnected.',
        });
      }
    } catch (error) {
      if (active.signal.aborted || owner.current !== ownerId) return;
      const message = expectedFailure(error);
      if (message === null) throw error;
      dispatch({ type: 'failed', ownerId, requestId, error: message });
    } finally {
      if (owner.current === ownerId && sequence.current === requestId)
        disconnecting.current = false;
    }
  };
  const visible =
    state.ownerId === ownerId ? state : initialConnections(ownerId);
  if (authenticated && !ownerId)
    return (
      <section>
        <p role={profileFetchStatus === 'error' ? 'alert' : 'status'}>
          {profileFetchStatus === 'error'
            ? 'Could not load your Feed account.'
            : 'Loading your Feed account…'}
        </p>
        {profileFetchStatus === 'error' && (
          <Button onClick={() => void refresh()}>Try again</Button>
        )}
      </section>
    );
  return (
    <ConnectedAgentsView
      state={visible}
      confirmingId={
        confirmation?.ownerId === ownerId ? confirmation.grantId : null
      }
      onRefresh={() => void load()}
      onDisconnect={(grantId) => {
        if (ownerId) setConfirmation({ ownerId, grantId });
      }}
      onCancel={() => setConfirmation(null)}
      onConfirm={(grantId) => void disconnect(grantId)}
    />
  );
}

const scopeLabels = {
  read: 'Read account',
  'social:write': 'Post and interact',
  messages: 'Read and send messages',
  trade: 'Trade virtual points',
};
function shownDate(value: string): string {
  return new Date(value).toLocaleString();
}
export function ConnectedAgentsView({
  state,
  confirmingId,
  onRefresh,
  onDisconnect,
  onCancel,
  onConfirm,
}: {
  state: ConnectedAgentsState;
  confirmingId: string | null;
  onRefresh: () => void;
  onDisconnect: (grantId: string) => void;
  onCancel: () => void;
  onConfirm: (grantId: string) => void;
}) {
  const section = useRef<HTMLElement>(null);
  const previousConfirmation = useRef<string | null>(null);
  useEffect(() => {
    if (confirmingId) {
      const group = Array.from(
        section.current?.querySelectorAll<HTMLElement>('[data-confirm-id]') ??
          []
      ).find((element) => element.dataset.confirmId === confirmingId);
      group?.querySelector<HTMLButtonElement>('button')?.focus();
    } else if (previousConfirmation.current) {
      const trigger = Array.from(
        section.current?.querySelectorAll<HTMLButtonElement>(
          '[data-disconnect-id]'
        ) ?? []
      ).find(
        (element) =>
          element.dataset.disconnectId === previousConfirmation.current
      );
      (trigger ?? section.current?.querySelector<HTMLElement>('h2'))?.focus();
    }
    previousConfirmation.current = confirmingId;
  }, [confirmingId]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const pending = state.phase === 'disconnecting';
  return (
    <section
      ref={section}
      className="ph-no-capture space-y-5"
      data-private
      aria-labelledby="connected-agents-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="connected-agents-title"
          tabIndex={-1}
          className="font-semibold text-xl"
        >
          Connected agents
        </h2>
        <Button
          variant="outline"
          disabled={pending || state.phase === 'loading' || !state.ownerId}
          onClick={onRefresh}
        >
          Refresh
        </Button>
      </div>
      <p className="text-muted-foreground text-sm">
        Agents use your Feed account with the permissions you approved. Names
        are supplied by the connected apps.
      </p>
      {!state.ownerId ? (
        <p>Sign in to manage your connected agents.</p>
      ) : state.phase === 'loading' ? (
        <p role="status">Loading connected agents…</p>
      ) : state.error ? (
        <div role="alert">
          <p>{state.error}</p>
          <Button variant="outline" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      ) : state.grants.length === 0 ? (
        <p>
          No agents connected yet. Use the Feed setup prompt in your agent to
          connect.
        </p>
      ) : (
        <ul className="space-y-4">
          {state.grants.map((grant) => {
            const status = connectionStatus(grant, now);
            const grantPending = state.pendingId === grant.id;
            return (
              <li
                key={grant.id}
                className="space-y-3 rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="break-words font-medium">
                    {grant.clientName}
                  </h3>
                  <span className="text-muted-foreground text-sm">
                    {status === 'revoked'
                      ? 'Disconnected'
                      : status === 'expired'
                        ? 'Expired'
                        : 'Connected'}
                  </span>
                </div>
                <p className="text-sm">
                  Permissions:{' '}
                  {grant.scopes.map((scope) => scopeLabels[scope]).join(', ')}
                </p>
                <dl className="grid gap-2 text-muted-foreground text-sm">
                  <div>
                    <dt className="inline font-medium">Connected: </dt>
                    <dd className="inline">
                      <time dateTime={grant.createdAt}>
                        {shownDate(grant.createdAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Last used: </dt>
                    <dd className="inline">
                      {grant.lastUsedAt ? (
                        <time dateTime={grant.lastUsedAt}>
                          {shownDate(grant.lastUsedAt)}
                        </time>
                      ) : (
                        'Not used yet'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline font-medium">Expires: </dt>
                    <dd className="inline">
                      <time dateTime={grant.expiresAt}>
                        {shownDate(grant.expiresAt)}
                      </time>
                    </dd>
                  </div>
                  {grant.revokedAt && (
                    <div>
                      <dt className="inline font-medium">Disconnected: </dt>
                      <dd className="inline">
                        <time dateTime={grant.revokedAt}>
                          {shownDate(grant.revokedAt)}
                        </time>
                      </dd>
                    </div>
                  )}
                </dl>
                {status !== 'revoked' &&
                  (confirmingId === grant.id ? (
                    <div
                      role="group"
                      data-confirm-id={grant.id}
                      aria-label={`Disconnect ${grant.clientName}`}
                      className="space-y-2"
                    >
                      <p className="text-sm">
                        Disconnect this agent? It will need your approval to
                        reconnect.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          disabled={pending}
                          onClick={() => onConfirm(grant.id)}
                        >
                          {grantPending
                            ? 'Disconnecting…'
                            : 'Confirm disconnect'}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={pending}
                          onClick={onCancel}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={pending}
                      data-disconnect-id={grant.id}
                      onClick={() => onDisconnect(grant.id)}
                    >
                      Disconnect {grant.clientName}
                    </Button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {state.notice && <p role="status">{state.notice}</p>}
    </section>
  );
}
