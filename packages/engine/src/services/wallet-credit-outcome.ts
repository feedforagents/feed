import { WalletCreditNotAppliedError } from '@feed/shared';

const DEFINITE_REJECTION_PREFIXES = [
  'User not found for wallet operation',
  'Invalid wallet mutation',
  'Invalid credit amount',
  'Invalid debit amount',
];

function walkErrors(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : '';
}

function isDefiniteMessage(message: string): boolean {
  return DEFINITE_REJECTION_PREFIXES.some((prefix) =>
    message.startsWith(prefix)
  );
}

/**
 * True when the credit transaction rolled back (or never started) and the
 * balance row cannot exist. Connection loss and commit timeouts are not
 * definite: the row may still have landed.
 */
export function isDefiniteWalletRejection(err: unknown): boolean {
  for (const item of walkErrors(err)) {
    if (item instanceof WalletCreditNotAppliedError) return true;
    if (isDefiniteMessage(errorText(item))) return true;
  }
  return false;
}

export function walletRejectionMessage(err: unknown): string {
  for (const item of walkErrors(err)) {
    const message = errorText(item);
    if (
      item instanceof WalletCreditNotAppliedError ||
      isDefiniteMessage(message)
    ) {
      return message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * `probedApplied` is the ledger lookup: true (row exists), false (row
 * absent), or null when the lookup itself failed.
 */
export function classifyCreditFailure(
  err: unknown,
  probedApplied: boolean | null
): 'applied' | 'not_applied' | 'unknown' {
  if (probedApplied === true) return 'applied';
  if (probedApplied === null) return 'unknown';
  if (isDefiniteWalletRejection(err)) return 'not_applied';
  return 'unknown';
}
