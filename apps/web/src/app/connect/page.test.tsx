import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  consumeConnectReturn,
  parseConnectReturn,
} from '@/lib/auth/connect-return';

const requestId = 'opaque-request-id-123';
const returnKey = 'feed:connect-return:v1';
const saved = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
let signIn: () => void;
let close: () => void;
let signedIn: () => void;
let dismiss: () => void;

mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams({ request: requestId }),
}));
mock.module('@/hooks/useAuth', () => ({
  useAuth: () => ({ authenticated: false, ready: true, user: null }),
}));
mock.module('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick: () => void;
  }) => {
    if (children === 'Sign in') signIn = onClick;
    return <button type="button">{children}</button>;
  },
}));
mock.module('@/components/auth/LoginModal', () => ({
  LoginModal: ({
    onClose,
    onSignedIn,
    onDismiss,
  }: {
    onClose: () => void;
    onSignedIn: () => void;
    onDismiss?: () => void;
  }) => {
    close = onClose;
    signedIn = onSignedIn;
    dismiss = onDismiss ?? (() => {});
    return null;
  },
}));
const { default: ConnectPage } = await import('./page');

afterEach(() => {
  saved.clear();
  if (originalWindow)
    Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function openSignIn() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
      },
    },
  });
  renderToStaticMarkup(<ConnectPage />);
  signIn();
  expect(parseConnectReturn(saved.get(returnKey) ?? null)).toBe(
    `/connect?request=${requestId}`
  );
}

describe('Connect sign-in return lifecycle', () => {
  test('canceling the modal prevents an unrelated email callback from resuming it', () => {
    openSignIn();
    dismiss();
    close();
    expect(consumeConnectReturn()).toBeNull();
  });

  test('automatic authenticated close preserves the pending cross-tab callback return', () => {
    openSignIn();
    close();
    expect(consumeConnectReturn()).toBe(`/connect?request=${requestId}`);
  });

  test('successful in-place sign-in clears the cross-tab return', () => {
    openSignIn();
    signedIn();
    expect(consumeConnectReturn()).toBeNull();
  });

  test('an external callback can still consume the pending return before completion', () => {
    openSignIn();
    expect(consumeConnectReturn()).toBe(`/connect?request=${requestId}`);
    expect(consumeConnectReturn()).toBeNull();
  });
});
