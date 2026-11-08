/**
 * Agent LLM usage accounting on empty-content failures
 *
 * A provider response that arrives but produces empty content still consumed
 * inference. The usage it reported must reach the DAG trace bridge on the
 * failure record instead of being recorded as zero — the same accounting
 * defect as issue #1550, in the raw-fetch HuggingFace/Phala paths.
 * Errors that carry no provider-reported usage stay at zero.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { AgentLLMBridgeData } from '@feed/shared';
import { getAgentLLMBridge, setAgentLLMBridge } from '@feed/shared';
import { callAgentLLM } from '../agent-llm';

const bridgeCalls: AgentLLMBridgeData[] = [];
const realFetch = globalThis.fetch;
const originalBridge = getAgentLLMBridge();
const envKeys = [
  'SURPLUS_API_KEY',
  'AGENT_LLM_PROVIDER',
  'HUGGINGFACE_API_KEY',
  'HUGGINGFACE_MODEL_ENDPOINT',
  'HUGGINGFACE_API_FORMAT',
  'PHALA_ENDPOINT',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function useHuggingFace(): void {
  process.env.AGENT_LLM_PROVIDER = 'huggingface';
  process.env.HUGGINGFACE_API_KEY = 'test-key';
  process.env.HUGGINGFACE_MODEL_ENDPOINT = 'https://hf.example/v1';
  process.env.HUGGINGFACE_API_FORMAT = 'openai';
}

beforeEach(() => {
  for (const key of envKeys) delete process.env[key];
  bridgeCalls.length = 0;
  setAgentLLMBridge((data) => {
    bridgeCalls.push(data);
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setAgentLLMBridge(originalBridge);
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('callAgentLLM usage on empty-content failures', () => {
  it('huggingface: records provider-reported usage when content is empty', async () => {
    useHuggingFace();
    globalThis.fetch = mock(async () =>
      jsonResponse({
        choices: [{ message: { content: '' } }],
        usage: { prompt_tokens: 387, completion_tokens: 1 },
      })
    ) as unknown as typeof fetch;

    await expect(callAgentLLM({ prompt: 'hi' })).rejects.toThrow(
      'HuggingFace returned empty content'
    );
    const failure = bridgeCalls.find((c) => c.success === false);
    expect(failure).toBeDefined();
    expect(failure?.inputTokens).toBe(387);
    expect(failure?.outputTokens).toBe(1);
    expect(failure?.totalTokens).toBe(388);
  });

  it('phala: records provider-reported usage when content is empty', async () => {
    process.env.AGENT_LLM_PROVIDER = 'phala';
    process.env.PHALA_ENDPOINT = 'https://phala.example';
    globalThis.fetch = mock(async () =>
      jsonResponse({
        choices: [{ message: { content: '   ' } }],
        usage: { prompt_tokens: 100, completion_tokens: 2 },
      })
    ) as unknown as typeof fetch;

    await expect(callAgentLLM({ prompt: 'hi' })).rejects.toThrow(
      'Phala returned empty content'
    );
    const failure = bridgeCalls.find((c) => c.success === false);
    expect(failure).toBeDefined();
    expect(failure?.inputTokens).toBe(100);
    expect(failure?.outputTokens).toBe(2);
    expect(failure?.totalTokens).toBe(102);
  });

  it('huggingface: an empty response without usage stays at zero', async () => {
    useHuggingFace();
    globalThis.fetch = mock(async () =>
      jsonResponse({ choices: [{ message: { content: '' } }] })
    ) as unknown as typeof fetch;

    await expect(callAgentLLM({ prompt: 'hi' })).rejects.toThrow(
      'HuggingFace returned empty content'
    );
    const failure = bridgeCalls.find((c) => c.success === false);
    expect(failure).toBeDefined();
    expect(failure?.inputTokens).toBe(0);
    expect(failure?.outputTokens).toBe(0);
  });

  it('phala: a transport failure stays at zero (no usage reported)', async () => {
    process.env.AGENT_LLM_PROVIDER = 'phala';
    process.env.PHALA_ENDPOINT = 'https://phala.example';
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    await expect(callAgentLLM({ prompt: 'hi' })).rejects.toThrow(
      'connection refused'
    );
    const failure = bridgeCalls.find((c) => c.success === false);
    expect(failure).toBeDefined();
    expect(failure?.inputTokens).toBe(0);
    expect(failure?.outputTokens).toBe(0);
  });
});
