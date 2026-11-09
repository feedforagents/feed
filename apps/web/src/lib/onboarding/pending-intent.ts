import { z } from 'zod';

const id = z.string().min(1).max(200);
export const pendingActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('like'),
      targetId: id,
      targetType: z.enum(['post', 'comment']),
      desired: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('follow'),
      targetId: id,
      desired: z.literal(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('navigate'),
      href: z.enum(['/chats', '/wallet', '/notifications', '/profile']),
    })
    .strict(),
  z.object({ kind: z.literal('repost'), postId: id }).strict(),
  z
    .object({
      kind: z.literal('reply'),
      postId: id,
      parentCommentId: id.optional(),
      content: z.string().max(5000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('prediction'),
      marketId: id,
      side: z.enum(['yes', 'no']),
      mode: z.enum(['buy', 'sell']),
      amount: z.string().max(40),
      shares: z.string().max(40),
    })
    .strict(),
  z
    .object({
      kind: z.literal('perp'),
      ticker: id,
      side: z.enum(['long', 'short']),
      size: z.string().max(40),
      leverage: z.number().finite().positive(),
    })
    .strict(),
]);
export type PendingAction = z.infer<typeof pendingActionSchema>;
const envelopeSchema = z
  .object({
    version: z.literal(1),
    id,
    createdAt: z.number().finite(),
    expiresAt: z.number().finite(),
    ownerId: id.nullable(),
    action: pendingActionSchema,
  })
  .strict();
export type PendingIntent = z.infer<typeof envelopeSchema>;
export const PENDING_INTENT_KEY = 'feed.pending-intent.v1';
export const INTENT_TTL_MS = 10 * 60 * 1000;

export function parsePendingIntent(
  raw: string | null,
  now = Date.now()
): PendingIntent | null {
  if (!raw) return null;
  let value: object;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = envelopeSchema.safeParse(value);
  if (!result.success) return null;
  const intent = result.data;
  if (
    intent.createdAt > now ||
    intent.expiresAt <= now ||
    intent.expiresAt - intent.createdAt !== INTENT_TTL_MS
  )
    return null;
  return intent;
}

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}
export function cancelPendingIntent(target = storage()): void {
  try {
    target?.removeItem(PENDING_INTENT_KEY);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}
export function savePendingIntent(
  action: PendingAction,
  ownerId: string | null = null,
  target = storage()
): boolean {
  if (!target) return false;
  const now = Date.now();
  const intent: PendingIntent = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: now,
    expiresAt: now + INTENT_TTL_MS,
    ownerId,
    action: pendingActionSchema.parse(action),
  };
  try {
    target.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
    return true;
  } catch (error) {
    if (error instanceof DOMException) return false;
    throw error;
  }
}
/** Removing synchronously before returning prevents StrictMode, callbacks and reload replay.
 * This guarantees one start, not delivery after an ambiguous network failure. */
export function claimPendingIntent(target = storage()): PendingIntent | null {
  if (!target) return null;
  try {
    const intent = parsePendingIntent(target.getItem(PENDING_INTENT_KEY));
    target.removeItem(PENDING_INTENT_KEY);
    return intent;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}
