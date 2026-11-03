import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getAgentLLMBridge } from '@feed/shared';
import OpenAI from 'openai';
import { callAgentLLM } from '../../agents/src/llm/agent-llm';
import { callGroqDirect } from '../../agents/src/llm/direct-groq';
import {
  installLLMInterceptor,
  setLLMCallCallback,
  uninstallLLMInterceptor,
} from '../../engine/src/dag-trace/llm-interceptor';
import type { LLMCallInput } from '../../engine/src/dag-trace/types';
import {
  FeedLLMClient,
  setTokenUsageCallback,
  type TokenUsageCallback,
} from '../../engine/src/llm/openai-client';
import { tracedCompletion } from '../../engine/src/llm/traced-completion';

const calls: LLMCallInput[] = [];
const requests: Array<{ messages: Array<{ role: string; content: string }> }> =
  [];
const requestPaths: string[] = [];
const saved = { ...process.env };
let responseText = 'A model response';
let status = 200;
let queuedResponses: Array<{
  content: string;
  finish: string;
  status?: number;
}> = [];
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    requestPaths.push(new URL(request.url).pathname);
    requests.push(await request.json());
    if (status !== 200)
      return Response.json(
        { error: { message: 'Controlled provider failure' } },
        { status }
      );
    const next = queuedResponses.shift() ?? {
      content: responseText,
      finish: 'stop',
    };
    if (next.status) {
      return Response.json(
        { error: { message: 'Controlled continuation failure' } },
        { status: next.status, headers: { 'x-should-retry': 'false' } }
      );
    }
    return Response.json({
      id: 'audit-call',
      object: 'chat.completion',
      created: 1,
      model: 'audit-model',
      choices: [
        {
          index: 0,
          finish_reason: next.finish,
          message: { role: 'assistant', content: next.content },
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    });
  },
});

beforeAll(() => {
  process.env.GROQ_API_KEY = 'local-test-only';
  process.env.GROQ_BASE_URL = `${server.url}v1`;
  delete process.env.ELIZACLOUD_API_KEY;
  installLLMInterceptor();
  setLLMCallCallback((call) => calls.push(call));
});
afterAll(() => {
  uninstallLLMInterceptor();
  process.env = saved;
  server.stop(true);
});

describe('actual provider transport and trajectory bridge', () => {
  test('raw helper calls capture success, provider failure and empty output', async () => {
    const client = new OpenAI({
      apiKey: 'local-test-only',
      baseURL: `${server.url}v1`,
      maxRetries: 0,
    });
    const params = {
      model: 'audit-model',
      messages: [{ role: 'user' as const, content: 'Full tag context' }],
      temperature: 0.3,
      max_tokens: 100,
    };
    const initial = calls.length;
    await tracedCompletion(client, 'groq', 'tag_generation', params);
    expect(calls.at(-1)).toMatchObject({
      userPrompt: 'Full tag context',
      messages: params.messages,
      success: true,
      totalTokens: 40,
    });
    status = 400;
    await expect(
      tracedCompletion(client, 'groq', 'tag_generation', params)
    ).rejects.toThrow();
    expect(calls.at(-1)?.success).toBe(false);
    status = 200;
    responseText = '';
    await expect(
      tracedCompletion(client, 'groq', 'tag_generation', params)
    ).rejects.toThrow('empty');
    expect(calls.at(-1)?.success).toBe(false);
    expect(calls.length - initial).toBe(3);
    responseText = 'A model response';
  });
  test('captures exact prompts and token usage without an active game tick', async () => {
    expect(getAgentLLMBridge()).not.toBeNull();
    const prompt = 'Required information: $& {{literal_user_text}}';
    const system = 'Keep the NPC identity and full conversation';
    expect(await callGroqDirect({ prompt, system, maxTokens: 100 })).toBe(
      responseText
    );
    expect(requests.at(-1)?.messages).toEqual([
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ]);
    expect(calls.at(-1)).toMatchObject({
      systemPrompt: system,
      userPrompt: prompt,
      rawResponse: responseText,
      inputTokens: 30,
      outputTokens: 10,
      totalTokens: 40,
      success: true,
    });
  });
  test('captures failed HTTP calls and propagates the failure', async () => {
    status = 400;
    await expect(callGroqDirect({ prompt: 'failure input' })).rejects.toThrow();
    expect(calls.at(-1)).toMatchObject({
      userPrompt: 'failure input',
      success: false,
    });
    status = 200;
  });
  test('rejects and records empty model content', async () => {
    responseText = '';
    await expect(
      callGroqDirect({ prompt: 'empty response input' })
    ).rejects.toThrow('empty');
    expect(calls.at(-1)).toMatchObject({
      success: false,
      userPrompt: 'empty response input',
    });
  });
  test('does not silently choose Groq for an unknown configured provider', async () => {
    process.env.AGENT_LLM_PROVIDER = 'typo-provider';
    await expect(callAgentLLM({ prompt: 'input' })).rejects.toThrow(
      'Unsupported'
    );
  });
  test('records every engine continuation with its exact conversation', async () => {
    const before = calls.length;
    queuedResponses = [
      { content: '{"items":[', finish: 'length' },
      { content: '1]}', finish: 'stop' },
    ];
    const client = new FeedLLMClient(undefined, 'groq');
    expect(
      await client.generateJSON<{ items: number[] }>(
        'Generate items',
        undefined,
        {
          format: 'json',
          maxTokens: 100,
        }
      )
    ).toEqual({ items: [1] });
    const captured = calls.slice(before);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.rawResponse).toBe('{"items":[');
    expect(captured[1]?.rawResponse).toBe('1]}');
    expect(captured[1]?.messages?.[2]).toEqual({
      role: 'assistant',
      content: '{"items":[',
    });
    expect(captured[1]?.messages?.[3]?.content).toContain('JSON');
    expect(captured.reduce((sum, call) => sum + call.totalTokens, 0)).toBe(80);
  });
  test('token totals retain consumed continuation tokens when an engine attempt retries', async () => {
    const usage: Array<Parameters<TokenUsageCallback>[0]> = [];
    const before = calls.length;
    queuedResponses = [
      { content: '{"items":[', finish: 'length' },
      { content: '', finish: 'stop', status: 503 },
      { content: '{"items":[1]}', finish: 'stop' },
    ];
    setTokenUsageCallback((call) => usage.push(call));
    try {
      const client = new FeedLLMClient(undefined, 'groq');
      expect(
        await client.generateJSON<{ items: number[] }>(
          'Generate items',
          undefined,
          {
            format: 'json',
            maxTokens: 100,
          }
        )
      ).toEqual({ items: [1] });
      expect(calls.slice(before)).toHaveLength(3);
      expect(usage.map((call) => call.success)).toEqual([false, true]);
      expect(usage.reduce((sum, call) => sum + call.inputTokens, 0)).toBe(60);
      expect(usage.reduce((sum, call) => sum + call.outputTokens, 0)).toBe(20);
      expect(usage.reduce((sum, call) => sum + call.totalTokens, 0)).toBe(80);
    } finally {
      setTokenUsageCallback(null);
    }
  }, 15000);
  test('malformed engine XML is a failed trajectory with raw output and usage preserved', async () => {
    responseText =
      '<decisions><decision><npcId>org-example</npcName></decision></decisions>';
    const before = calls.length;
    const client = new FeedLLMClient(undefined, 'groq');
    await expect(
      client.generateJSON('Required market context')
    ).rejects.toThrow('Failed to parse XML');
    const captured = calls.slice(before);
    expect(captured).toHaveLength(4);
    expect(captured[0]?.userPrompt).toBe('Required market context');
    for (const call of captured) {
      expect(call).toMatchObject({
        success: false,
        rawResponse: responseText,
        totalTokens: 40,
        parsedResponse: null,
      });
    }
    expect(calls.at(-1)?.error).toContain('Mismatched XML');
  });
  test('unwraps only whole top-level JSON containers inside XML text', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content: '<response>{"parodyTitle":"A new parody headline"}</response>',
        finish: 'stop',
      },
      { content: '<response>[{"id":"opaque-id"}]</response>', finish: 'stop' },
      {
        content:
          '<response><message>{"post":"literal text"}</message></response>',
        finish: 'stop',
      },
    ];

    expect(
      await client.generateJSON<{ parodyTitle: string }>(
        'Generate a headline',
        {
          required: ['parodyTitle'],
        }
      )
    ).toEqual({ parodyTitle: 'A new parody headline' });
    expect(
      await client.generateJSON<Array<{ id: string }>>('Generate items')
    ).toEqual([{ id: 'opaque-id' }]);
    expect(
      await client.generateJSON<{ message: string }>('Preserve message text', {
        required: ['message'],
      })
    ).toEqual({ message: '{"post":"literal text"}' });
  });
  test('validates XML required fields without changing discarded-root or response-wrapper shapes', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content:
          '<decisions><decision><npcId>opaque-id</npcId></decision></decisions>',
        finish: 'stop',
      },
      {
        content: '<output><response><name>Wrapped</name></response></output>',
        finish: 'stop',
      },
      {
        content: '<response><wrong>missing name</wrong></response>',
        finish: 'stop',
      },
      {
        content: '<response><name>Corrected</name></response>',
        finish: 'stop',
      },
    ];

    expect(
      await client.generateJSON<{ decision: { npcId: string } }>(
        'Generate decisions',
        {
          required: ['decisions'],
        }
      )
    ).toEqual({ decision: { npcId: 'opaque-id' } });
    expect(
      await client.generateJSON<{ response: { name: string } }>(
        'Generate a name',
        { required: ['name'] }
      )
    ).toEqual({ response: { name: 'Wrapped' } });
    const before = calls.length;
    expect(
      await client.generateJSON<{ name: string }>('Generate a valid name', {
        required: ['name'],
      })
    ).toEqual({ name: 'Corrected' });
    expect(calls.slice(before).map((call) => call.success)).toEqual([
      false,
      true,
    ]);
  });
  test('does not treat an XML tag inside JSON text as a discarded root', async () => {
    const before = calls.length;
    const previousResponse = responseText;
    responseText = '{"message":"<decisions>"}';
    try {
      const client = new FeedLLMClient(undefined, 'groq');
      await expect(
        client.generateJSON('Generate decisions', { required: ['decisions'] })
      ).rejects.toThrow('Missing required fields: decisions');
      expect(calls.slice(before)).toHaveLength(4);
      expect(calls.slice(before).every((call) => !call.success)).toBe(true);
    } finally {
      responseText = previousResponse;
    }
  });
  test('preserves complete XML fragments inside a bare JSON container', async () => {
    const previousResponse = responseText;
    const message =
      '<decisions><decision>opaque</decision></decisions> <think>literal text</think>';
    responseText = JSON.stringify({ message });
    try {
      const client = new FeedLLMClient(undefined, 'groq');
      expect(
        await client.generateJSON<{ message: string }>(
          'Preserve message text',
          {
            required: ['message'],
          }
        )
      ).toEqual({ message });

      const before = calls.length;
      await expect(
        client.generateJSON('Generate decisions', { required: ['decisions'] })
      ).rejects.toThrow('Missing required fields: decisions');
      expect(calls.slice(before)).toHaveLength(4);
      expect(calls.slice(before).every((call) => !call.success)).toBe(true);
    } finally {
      responseText = previousResponse;
    }
  });
  for (const invalid of [
    '<response><name>Truncated',
    '<response><name>Mismatched</wrong></response>',
    '<response>plain prose</response>',
    '<response>{"name":"truncated JSON"</response>',
  ]) {
    test(`retries invalid structured output: ${invalid}`, async () => {
      const usage: Array<Parameters<TokenUsageCallback>[0]> = [];
      const before = calls.length;
      queuedResponses = [
        { content: invalid, finish: 'stop' },
        {
          content: '<response><name>Corrected</name></response>',
          finish: 'stop',
        },
      ];
      setTokenUsageCallback((call) => usage.push(call));
      try {
        const client = new FeedLLMClient(undefined, 'groq');
        expect(
          await client.generateJSON<{ name: string }>('Required context', {
            required: ['name'],
          })
        ).toEqual({ name: 'Corrected' });
        const captured = calls.slice(before);
        expect(captured.map((call) => call.success)).toEqual([false, true]);
        expect(captured[0]?.rawResponse).toBe(invalid);
        expect(captured[0]?.messages).toHaveLength(2);
        expect(captured[1]?.messages).toHaveLength(3);
        const feedback = captured[1]?.messages?.[2]?.content;
        expect(feedback).toContain('complete');
        expect(feedback).not.toContain(invalid);
        expect(usage.map((call) => call.success)).toEqual([false, true]);
        expect(usage.reduce((sum, call) => sum + call.totalTokens, 0)).toBe(80);
      } finally {
        setTokenUsageCallback(null);
        queuedResponses = [];
      }
    });
  }
  test('rejects primitive JSON after four attempts and accounts for every failed output', async () => {
    const usage: Array<Parameters<TokenUsageCallback>[0]> = [];
    const before = calls.length;
    responseText = 'true';
    setTokenUsageCallback((call) => usage.push(call));
    try {
      const client = new FeedLLMClient(undefined, 'groq');
      await expect(
        client.generateJSON('Return structured data', undefined, {
          format: 'json',
        })
      ).rejects.toThrow('object or array');
      const captured = calls.slice(before);
      expect(captured).toHaveLength(4);
      expect(
        captured.every((call) => !call.success && call.rawResponse === 'true')
      ).toBe(true);
      expect(captured.map((call) => call.messages?.length)).toEqual([
        2, 3, 3, 3,
      ]);
      expect(usage.every((call) => !call.success)).toBe(true);
      expect(usage.reduce((sum, call) => sum + call.totalTokens, 0)).toBe(160);
    } finally {
      setTokenUsageCallback(null);
      responseText = 'A model response';
    }
  });
  test('captures engine transport failure with the exact prompt', async () => {
    status = 400;
    const client = new FeedLLMClient(undefined, 'groq');
    await expect(client.generateJSON('engine failure input')).rejects.toThrow();
    expect(calls.at(-1)).toMatchObject({
      userPrompt: 'engine failure input',
      success: false,
    });
    status = 200;
  });
  test('HuggingFace retains system context, avoids doubled v1 paths, and exposes failures', async () => {
    const before = { ...process.env };
    try {
      process.env.AGENT_LLM_PROVIDER = 'huggingface';
      process.env.HUGGINGFACE_API_KEY = 'local-test-only';
      process.env.HUGGINGFACE_MODEL_ENDPOINT = `${server.url}v1`;
      process.env.HUGGINGFACE_API_FORMAT = 'openai';
      process.env.HUGGINGFACE_MODEL_NAME = 'configured-model';
      responseText = 'HF response';
      await callAgentLLM({
        prompt: 'Required user context',
        system: 'Required character system',
      });
      expect(requestPaths.at(-1)).toBe('/v1/chat/completions');
      expect(requests.at(-1)?.messages).toEqual([
        { role: 'system', content: 'Required character system' },
        { role: 'user', content: 'Required user context' },
      ]);
      expect(calls.at(-1)).toMatchObject({
        provider: 'huggingface',
        model: 'configured-model',
        success: true,
      });
      const count = requests.length;
      status = 503;
      await expect(callAgentLLM({ prompt: 'fail visibly' })).rejects.toThrow(
        '503'
      );
      expect(requests.length - count).toBe(1);
      expect(calls.at(-1)).toMatchObject({
        success: false,
        userPrompt: 'fail visibly',
      });
    } finally {
      process.env = before;
      status = 200;
      responseText = 'A model response';
    }
  });
  test('does not hide capture callback failures', async () => {
    responseText = 'valid response';
    setLLMCallCallback(() => {
      throw new Error('Capture storage failed');
    });
    await expect(callGroqDirect({ prompt: 'capture failure' })).rejects.toThrow(
      'Capture storage failed'
    );
  });
});
