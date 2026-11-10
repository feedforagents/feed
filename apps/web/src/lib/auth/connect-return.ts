import {
  readStorageItem,
  removeStorageItem,
  writeStorageItem,
} from '@/utils/browser-storage';

const CONNECT_RETURN_KEY = 'feed:connect-return:v1';

export function parseConnectReturn(
  raw: string | null,
  now = Date.now()
): string | null {
  if (!raw) return null;
  let saved: { path?: string; expiresAt?: number };
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !saved ||
    typeof saved !== 'object' ||
    typeof saved.path !== 'string' ||
    typeof saved.expiresAt !== 'number' ||
    saved.expiresAt <= now
  )
    return null;
  return /^\/connect\?request=[a-zA-Z0-9_-]{16,128}$/.test(saved.path)
    ? saved.path
    : null;
}

export function saveConnectReturn(requestId: string): void {
  const path = `/connect?request=${requestId}`;
  if (
    !parseConnectReturn(
      JSON.stringify({ path, expiresAt: Date.now() + 600_000 })
    )
  )
    return;
  writeStorageItem(
    'localStorage',
    CONNECT_RETURN_KEY,
    JSON.stringify({ path, expiresAt: Date.now() + 600_000 })
  );
}

export function clearConnectReturn(): void {
  removeStorageItem('localStorage', CONNECT_RETURN_KEY);
}

export function consumeConnectReturn(): string | null {
  const path = parseConnectReturn(
    readStorageItem('localStorage', CONNECT_RETURN_KEY)
  );
  clearConnectReturn();
  return path;
}
