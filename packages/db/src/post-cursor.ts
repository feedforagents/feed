/**
 * Post feed keyset cursor: `<ISO timestamp>_<post id>`.
 *
 * A timestamp alone cannot resume a page whose last post shares its timestamp
 * with the next posts, so the cursor also carries the last post id. A bare
 * ISO timestamp (the previous format) is still accepted.
 */

const SEPARATOR = '_';

export interface PostCursor {
  /** Timestamp part, exactly as received. */
  timestamp: string;
  /** Last post id; absent for legacy timestamp-only cursors. */
  id?: string;
}

export function encodePostCursor(timestamp: Date | string, id: string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  return `${date.toISOString()}${SEPARATOR}${id}`;
}

export function decodePostCursor(raw: string): PostCursor {
  // ISO timestamps never contain the separator; ids may.
  const at = raw.indexOf(SEPARATOR);
  if (at > 0 && at < raw.length - 1) {
    const timestamp = raw.slice(0, at);
    if (!Number.isNaN(new Date(timestamp).getTime())) {
      return { timestamp, id: raw.slice(at + 1) };
    }
  }
  return { timestamp: raw };
}
