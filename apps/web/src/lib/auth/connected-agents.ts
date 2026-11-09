import { z } from 'zod';

export const connectedGrantSchema = z.object({
  id: z.string().min(1),
  clientName: z.string(),
  scopes: z.array(z.enum(['read', 'social:write', 'messages', 'trade'])),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }).nullable(),
});
export const connectedGrantsResponseSchema = z.object({
  accountId: z.string().min(1),
  grants: z.array(connectedGrantSchema),
});
export type ConnectedGrant = z.infer<typeof connectedGrantSchema>;

export function connectionStatus(
  grant: ConnectedGrant,
  now = Date.now()
): 'connected' | 'revoked' | 'expired' {
  if (grant.revokedAt) return 'revoked';
  return Date.parse(grant.expiresAt) <= now ? 'expired' : 'connected';
}

export interface ConnectedAgentsState {
  ownerId: string | null;
  requestId: number;
  grants: ConnectedGrant[];
  phase: 'loading' | 'ready' | 'disconnecting' | 'error';
  pendingId: string | null;
  error: string | null;
  notice: string | null;
}
export function initialConnections(
  ownerId: string | null,
  requestId = 0
): ConnectedAgentsState {
  return {
    ownerId,
    requestId,
    grants: [],
    phase: ownerId ? 'loading' : 'ready',
    pendingId: null,
    error: null,
    notice: null,
  };
}
type RequestIdentity = { ownerId: string; requestId: number };
export type ConnectedAgentsAction =
  | ({ type: 'start' } & RequestIdentity)
  | ({
      type: 'loaded';
      grants: ConnectedGrant[];
      notice?: string;
    } & RequestIdentity)
  | ({ type: 'failed'; error: string } & RequestIdentity)
  | ({ type: 'disconnecting'; grantId: string } & RequestIdentity)
  | { type: 'signed-out'; requestId: number };

export function connectedAgentsReducer(
  state: ConnectedAgentsState,
  action: ConnectedAgentsAction
): ConnectedAgentsState {
  if (action.type === 'signed-out')
    return initialConnections(null, action.requestId);
  if (action.type === 'start')
    return initialConnections(action.ownerId, action.requestId);
  if (state.ownerId !== action.ownerId || state.requestId !== action.requestId)
    return state;
  if (action.type === 'loaded')
    return {
      ...state,
      grants: action.grants,
      phase: 'ready',
      pendingId: null,
      error: null,
      notice: action.notice ?? null,
    };
  if (action.type === 'failed')
    return {
      ...state,
      grants: [],
      phase: 'error',
      pendingId: null,
      error: action.error,
      notice: null,
    };
  return {
    ...state,
    phase: 'disconnecting',
    pendingId: action.grantId,
    error: null,
    notice: null,
  };
}

export function accountConnections(
  value: unknown,
  expectedAccountId: string
):
  | { ok: true; grants: ConnectedGrant[] }
  | { ok: false; error: 'account_changed' | 'invalid_response' } {
  const parsed = connectedGrantsResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'invalid_response' };
  if (parsed.data.accountId !== expectedAccountId)
    return { ok: false, error: 'account_changed' };
  return { ok: true, grants: parsed.data.grants };
}
