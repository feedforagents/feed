/**
 * Request guards for the A2A JSON-RPC endpoint (`/api/a2a`).
 *
 * - Validates the JSON-RPC envelope before anything reads from it, so null,
 *   primitive or array bodies return a protocol error instead of a 500.
 *
 * Caller scoping and task ownership live in `@feed/a2a`
 * (`scopeRequestToCaller` / `authorizeTaskReference`).
 */

import { NextResponse } from 'next/server';

export type JsonRpcId = string | number | null;

export interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  method: string;
  id: JsonRpcId;
  /** Always a plain object after validation (absent params become `{}`). */
  params: Record<string, unknown>;
}

/** Standard JSON-RPC / A2A error codes used by these guards. */
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_INVALID_PARAMS = -32602;

export function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function jsonRpcErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  status: number
): NextResponse {
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status }
  );
}

function readId(value: unknown): JsonRpcId {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/**
 * Validate a parsed request body as a JSON-RPC 2.0 request envelope.
 * Invalid params are rejected rather than silently replaced.
 */
export function parseJsonRpcEnvelope(
  body: unknown
):
  | { envelope: JsonRpcEnvelope; errorResponse?: never }
  | { errorResponse: NextResponse; envelope?: never } {
  if (!isPlainObject(body)) {
    return {
      errorResponse: jsonRpcErrorResponse(
        null,
        JSON_RPC_INVALID_REQUEST,
        'Invalid Request: body must be a JSON-RPC 2.0 request object',
        400
      ),
    };
  }

  const id = readId(body.id);
  const idIsValid =
    body.id === undefined ||
    body.id === null ||
    typeof body.id === 'string' ||
    typeof body.id === 'number';

  if (
    body.jsonrpc !== '2.0' ||
    typeof body.method !== 'string' ||
    body.method.length === 0 ||
    !idIsValid
  ) {
    return {
      errorResponse: jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_REQUEST,
        'Invalid Request: jsonrpc must be "2.0", method a non-empty string and id a string, number or null',
        400
      ),
    };
  }

  if (body.params !== undefined && !isPlainObject(body.params)) {
    return {
      errorResponse: jsonRpcErrorResponse(
        id,
        JSON_RPC_INVALID_PARAMS,
        'Invalid params: params must be an object',
        400
      ),
    };
  }

  return {
    envelope: {
      jsonrpc: '2.0',
      method: body.method,
      id,
      params: body.params ?? {},
    },
  };
}
