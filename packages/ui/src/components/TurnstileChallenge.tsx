import { useCallback, useState, type RefCallback } from "react";

export type TurnstileChallengeProps = {
  /** Cloudflare Turnstile site key served as public app config. */
  siteKey: string;
  /** Receives the challenge token on solve, and "" when it expires or errors. */
  onToken: (token: string) => void;
};

type TurnstileApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi | undefined;
  }
}

const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let scriptLoad: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined" || window.turnstile !== undefined) return Promise.resolve();
  if (scriptLoad !== null) return scriptLoad;
  scriptLoad = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load."));
    document.head.appendChild(script);
  });
  return scriptLoad;
}

/**
 * Cloudflare Turnstile challenge: renders the widget for a site key and reports its token.
 * @model spec/auth/phone.md
 */
export function TurnstileChallenge({ siteKey, onToken }: TurnstileChallengeProps) {
  const [failed, setFailed] = useState(false);
  const attach = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      if (element === null) return;
      let widgetId: string | undefined;
      let cancelled = false;
      void loadTurnstileScript().then(
        () => {
          if (cancelled || !element.isConnected || window.turnstile === undefined) return;
          widgetId = window.turnstile.render(element, {
            sitekey: siteKey,
            callback: (token: string) => onToken(token),
            "expired-callback": () => onToken(""),
            "error-callback": () => onToken(""),
          });
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
      return () => {
        cancelled = true;
        if (widgetId !== undefined && window.turnstile !== undefined) window.turnstile.remove(widgetId);
      };
    },
    [siteKey, onToken],
  );
  if (failed) {
    return <p className="text-xs text-destructive">Human verification failed to load. Check your connection and try again.</p>;
  }
  return <div ref={attach} />;
}
