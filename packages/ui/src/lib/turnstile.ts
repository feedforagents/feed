import { useCallback } from "react";

interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly callback: (token: string) => void;
  readonly "expired-callback"?: () => void;
  readonly "error-callback"?: () => void;
  readonly theme?: "auto" | "light" | "dark";
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  remove(widgetId: string): void;
  reset(widgetId: string): void;
}

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let turnstileLoadPromise: Promise<TurnstileApi | null> | null = null;

function getTurnstileApi(): TurnstileApi | null {
  if (typeof window === "undefined") return null;
  const g = window as Window & { readonly turnstile?: TurnstileApi };
  return g.turnstile ?? null;
}

function loadTurnstileApi(): Promise<TurnstileApi | null> {
  const existing = getTurnstileApi();
  if (existing) return Promise.resolve(existing);
  if (typeof document === "undefined") return Promise.resolve(null);
  if (turnstileLoadPromise !== null) return turnstileLoadPromise;
  turnstileLoadPromise = new Promise<TurnstileApi | null>((resolve) => {
    const resolveLoaded = () => {
      const api = getTurnstileApi();
      if (!api) turnstileLoadPromise = null;
      resolve(api);
    };
    const resolveFailed = () => {
      turnstileLoadPromise = null;
      resolve(null);
    };
    const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
    if (existingScript) {
      existingScript.addEventListener("load", resolveLoaded, { once: true });
      existingScript.addEventListener("error", resolveFailed, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", resolveLoaded, { once: true });
    script.addEventListener("error", resolveFailed, { once: true });
    document.head.appendChild(script);
  });
  return turnstileLoadPromise;
}

export function mountTurnstileWidget(
  node: HTMLElement,
  siteKey: string,
  onToken: (token: string | null) => void,
): () => void {
  let active = true;
  let widgetId: string | null = null;
  void loadTurnstileApi().then((api) => {
    if (!active || !api || !node.isConnected) return;
    widgetId = api.render(node, {
      sitekey: siteKey,
      theme: "auto",
      callback: (token) => {
        if (active) onToken(token);
      },
      "expired-callback": () => {
        if (active) onToken(null);
      },
      "error-callback": () => {
        if (active) onToken(null);
      },
    });
  });
  return () => {
    active = false;
    if (widgetId !== null) {
      getTurnstileApi()?.remove(widgetId);
      widgetId = null;
    }
  };
}

export function useTurnstileContainerRef(
  siteKey: string | null | undefined,
  onToken: (token: string | null) => void,
): (node: HTMLDivElement | null) => (() => void) | void {
  return useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !siteKey) return;
      return mountTurnstileWidget(node, siteKey, onToken);
    },
    [siteKey, onToken],
  );
}
