/**
 * Regression: when Ollama returns a response that fails local content
 * validation, the provider-reported token counts (prompt_eval_count /
 * eval_count) are already parsed and must reach the usage bridge on the
 * failure record. Only a failure with no parsed response (transport error)
 * records zero usage — the same distinction issue #1550 draws for the Groq
 * structured-output path.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AgentLLMBridgeData } from '@feed/shared';
import { setAgentLLMBridge } from '@feed/shared';
import { callOllama } from '../ollama-provider';

const bridgeCalls: AgentLLMBridgeData[] = [];
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  bridgeCalls.length = 0;
  setAgentLLMBridge((data) => bridgeCalls.push(data));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setAgentLLMBridge(null);
});

describe('callOllama usage preservation', () => {
  test('empty content keeps the provider counts on the failure record', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        message: { content: '' },
        prompt_eval_count: 387,
        eval_count: 1,
      })
    ) as unknown as typeof fetch;
    await expect(
      callOllama({ prompt: 'hi', modelOverride: 'test-model' })
    ).rejects.toThrow('Ollama returned empty content');
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]?.success).toBe(false);
    expect(bridgeCalls[0]?.inputTokens).toBe(387);
    expect(bridgeCalls[0]?.outputTokens).toBe(1);
  });

  test('missing message.content keeps the provider counts on the failure record', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({
        message: {},
        prompt_eval_count: 120,
        eval_count: 7,
      })
    ) as unknown as typeof fetch;
    await expect(
      callOllama({ prompt: 'hi', modelOverride: 'test-model' })
    ).rejects.toThrow('missing message.content');
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]?.success).toBe(false);
    expect(bridgeCalls[0]?.inputTokens).toBe(120);
    expect(bridgeCalls[0]?.outputTokens).toBe(7);
  });

  test('transport failure records zero usage (no response was parsed)', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    await expect(
      callOllama({ prompt: 'hi', modelOverride: 'test-model' })
    ).rejects.toThrow('connection refused');
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0]?.success).toBe(false);
    expect(bridgeCalls[0]?.inputTokens).toBe(0);
    expect(bridgeCalls[0]?.outputTokens).toBe(0);
  });
});
