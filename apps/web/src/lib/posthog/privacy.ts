/** Authentication pages must never contribute analytics or replay data. */
export function isPrivateAnalyticsPath(pathname: string): boolean {
  return /^\/(?:auth|oauth|connect|link|onboarding)(?:\/|$)/i.test(pathname);
}

/** Keep origin/path only: query strings and fragments may contain credentials. */
export function analyticsUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0] ?? '';
  }
}

/** PostHog also nests initial/referrer URLs inside person-property updates. */
export function redactAnalyticsUrls(
  value: unknown,
  seen = new WeakSet<object>()
): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const [key, property] of Object.entries(value)) {
    if (key === '$search_params') {
      Reflect.deleteProperty(value, key);
    } else if (
      typeof property === 'string' &&
      (key.includes('url') || key.includes('referrer') || key === '$pathname')
    ) {
      Reflect.set(value, key, analyticsUrl(property));
    } else if (property && typeof property === 'object') {
      redactAnalyticsUrls(property, seen);
    }
  }
}
