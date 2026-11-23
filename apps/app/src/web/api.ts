// spec/app/index.md, "Story: Browse, switch modes, and sign in through the JoinSheet"
export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractApiError(payload: unknown, status: number): { readonly code: string; readonly message: string } {
  if (isObj(payload)) {
    const nested = isObj(payload.error) ? payload.error : null;
    const rawCode = nested?.code ?? payload.code ?? payload.error;
    const rawMessage = nested?.message ?? payload.message ?? payload.error_description;
    const code = typeof rawCode === "string" && rawCode.trim() !== "" ? rawCode : `http_${status}`;
    const message = typeof rawMessage === "string" && rawMessage.trim() !== "" ? rawMessage : `Request failed (${status})`;
    return { code, message };
  }
  return { code: `http_${status}`, message: `Request failed (${status})` };
}

export async function requestJson<T>(
  url: string,
  options: {
    readonly method?: "GET" | "POST" | "DELETE" | "PATCH";
    readonly body?: unknown;
    readonly parse: (raw: unknown) => T;
  },
): Promise<ApiResult<T>> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  let encodedBody: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    encodedBody = JSON.stringify(options.body);
  }
  try {
    const response = await fetch(url, {
      method,
      headers,
      credentials: "include",
      ...(encodedBody === undefined ? {} : { body: encodedBody }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { message: text };
      }
    }
    if (!response.ok) {
      const err = extractApiError(parsed, response.status);
      return { ok: false, status: response.status, code: err.code, message: err.message };
    }
    return { ok: true, status: response.status, data: options.parse(parsed) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: "network_error",
      message: err instanceof Error ? err.message : "Network request failed",
    };
  }
}

export function passThrough(raw: unknown): unknown {
  return raw;
}
