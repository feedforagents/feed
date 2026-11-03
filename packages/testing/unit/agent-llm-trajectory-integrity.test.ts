import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getAgentLLMBridge } from '@feed/shared';
import OpenAI from 'openai';
import { callAgentLLM } from '../../agents/src/llm/agent-llm';
import { callGroqDirect } from '../../agents/src/llm/direct-groq';
import { callClaudeDirect } from '../../api/src/services/claude-service';
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
const requests: Array<{
  model?: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content: string }>;
}> = [];
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
  delete process.env.SURPLUS_API_KEY;
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
  test('traced text helper disables Qwen 3 thinking in actual HTTP requests', async () => {
    const client = new OpenAI({
      apiKey: 'local-test-only',
      baseURL: `${server.url}v1`,
      maxRetries: 0,
    });
    const params = {
      model: 'qwen3.5:4b',
      messages: [{ role: 'user' as const, content: 'Generate tags' }],
      temperature: 0.3,
      max_tokens: 100,
    };
    await tracedCompletion(client, 'surplus', 'tag_generation', params);
    expect(requests.at(-1)).toMatchObject({
      model: 'qwen3.5:4b',
      reasoning_effort: 'none',
      messages: params.messages,
    });
    expect(calls.at(-1)).toMatchObject({
      model: 'qwen3.5:4b',
      temperature: 0.3,
      maxTokens: 100,
      userPrompt: 'Generate tags',
      success: true,
    });
    const explicitParams = { ...params, reasoning_effort: 'high' as const };
    await tracedCompletion(client, 'surplus', 'tag_generation', explicitParams);
    expect(requests.at(-1)?.reasoning_effort).toBe('high');
    await tracedCompletion(client, 'groq', 'tag_generation', {
      ...params,
      model: 'ordinary-model',
    });
    expect(requests.at(-1)?.model).toBe('ordinary-model');
    expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
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
  test('disables thinking for Qwen 3 models in the actual provider request only', async () => {
    const originalModel = process.env.GROQ_PRIMARY_MODEL;
    try {
      process.env.GROQ_PRIMARY_MODEL = 'qwen3.5:4b';
      await callGroqDirect({ prompt: 'local Qwen request' });
      expect(requests.at(-1)).toMatchObject({
        model: 'qwen3.5:4b',
        reasoning_effort: 'none',
      });
      process.env.GROQ_PRIMARY_MODEL = 'ordinary-model';
      await callGroqDirect({ prompt: 'ordinary model request' });
      expect(requests.at(-1)?.model).toBe('ordinary-model');
      expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
    } finally {
      if (originalModel === undefined) delete process.env.GROQ_PRIMARY_MODEL;
      else process.env.GROQ_PRIMARY_MODEL = originalModel;
    }
  });
  test('moderation Surplus requests disable thinking only for Qwen 3', async () => {
    const previous = {
      apiKey: process.env.SURPLUS_API_KEY,
      baseURL: process.env.SURPLUS_BASE_URL,
      model: process.env.SURPLUS_MODEL,
    };
    try {
      process.env.SURPLUS_API_KEY = 'local-test-only';
      process.env.SURPLUS_BASE_URL = `${server.url}v1`;
      process.env.SURPLUS_MODEL = 'qwen3.5:4b';
      expect(
        await callClaudeDirect({
          prompt: 'Moderation input',
          system: 'Moderation system',
          maxTokens: 2048,
        })
      ).toBe(responseText);
      expect(requests.at(-1)).toMatchObject({
        model: 'qwen3.5:4b',
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: 'Moderation system' },
          { role: 'user', content: 'Moderation input' },
        ],
      });
      process.env.SURPLUS_MODEL = 'ordinary-model';
      await callClaudeDirect({ prompt: 'Another moderation input' });
      expect(requests.at(-1)?.model).toBe('ordinary-model');
      expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
    } finally {
      if (previous.apiKey === undefined) delete process.env.SURPLUS_API_KEY;
      else process.env.SURPLUS_API_KEY = previous.apiKey;
      if (previous.baseURL === undefined) delete process.env.SURPLUS_BASE_URL;
      else process.env.SURPLUS_BASE_URL = previous.baseURL;
      if (previous.model === undefined) delete process.env.SURPLUS_MODEL;
      else process.env.SURPLUS_MODEL = previous.model;
    }
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
  test('returns the schema-matched XML root or response projection', async () => {
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
      await client.generateJSON<{ decisions: { decision: { npcId: string } } }>(
        'Generate decisions',
        {
          required: ['decisions'],
        }
      )
    ).toEqual({ decisions: { decision: { npcId: 'opaque-id' } } });
    expect(
      await client.generateJSON<{ name: string }>('Generate a name', {
        required: ['name'],
      })
    ).toEqual({ name: 'Wrapped' });
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
  test('returns typed root projections and records the same parsed response', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content: '<post><content>ambient content</content></post>',
        finish: 'stop',
      },
      { content: '<reply><post>reply content</post></reply>', finish: 'stop' },
      {
        content: '<theory><post>theory content</post></theory>',
        finish: 'stop',
      },
      { content: '<posts>[{"id":"a"},{"id":"b"}]</posts>', finish: 'stop' },
    ];
    for (const [root, type, expected] of [
      ['post', 'object', { post: { content: 'ambient content' } }],
      ['reply', 'object', { reply: { post: 'reply content' } }],
      ['theory', 'object', { theory: { post: 'theory content' } }],
      ['posts', 'array', { posts: [{ id: 'a' }, { id: 'b' }] }],
    ] as const) {
      const result = await client.generateJSON<Record<string, unknown>>(root, {
        required: [root],
        properties: { [root]: { type } },
      });
      expect(result).toEqual(expected);
      expect(calls.at(-1)?.parsedResponse).toEqual(expected);
    }
  });
  test('preserves already-matching XML and unschematized array output', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content: '<response><post>flat content</post></response>',
        finish: 'stop',
      },
      { content: '<items>[{"id":"one"}]</items>', finish: 'stop' },
    ];
    expect(
      await client.generateJSON<{ post: string }>('Already flat', {
        required: ['post'],
        properties: { post: { type: 'string' } },
      })
    ).toEqual({ post: 'flat content' });
    expect(
      await client.generateJSON<Array<{ id: string }>>('No schema')
    ).toEqual([{ id: 'one' }]);
  });
  for (const [root, type, raw] of [
    ['post', 'string', '<post><content>unexpected object</content></post>'],
    ['post', 'object', '<post>[1,2]</post>'],
    ['items', 'array', '<items><item>x</item></items>'],
    ['amount', 'number', '<amount>{"value":1}</amount>'],
    ['enabled', 'boolean', '<enabled>{"value":true}</enabled>'],
  ] as const) {
    test(`rejects invalid projected ${type} ${root} in all four attempts`, async () => {
      const client = new FeedLLMClient(undefined, 'groq');
      const before = calls.length;
      const previousResponse = responseText;
      responseText = raw;
      try {
        await expect(
          client.generateJSON('Bad projected root', {
            required: [root],
            properties: { [root]: { type } },
          })
        ).rejects.toThrow(/type/i);
        expect(calls.slice(before)).toHaveLength(4);
        expect(calls.slice(before).every((call) => !call.success)).toBe(true);
      } finally {
        responseText = previousResponse;
      }
    });
  }

  for (const value of ['', '   ', {}, [], 42]) {
    test(`retries invalid required message pattern ${JSON.stringify(value)}`, async () => {
      const before = calls.length;
      queuedResponses = [
        { content: JSON.stringify({ message: value }), finish: 'stop' },
        {
          content: JSON.stringify({ message: 'A real group message' }),
          finish: 'stop',
        },
      ];
      try {
        const client = new FeedLLMClient(undefined, 'groq');
        expect(
          await client.generateJSON<{ message: string }>(
            'Generate group message',
            {
              required: ['message'],
              properties: { message: { type: 'string', pattern: '\\S' } },
            },
            { format: 'json', temperature: 0.9 }
          )
        ).toEqual({ message: 'A real group message' });
        const captured = calls.slice(before);
        expect(captured.map((call) => call.success)).toEqual([false, true]);
        expect(captured.map((call) => call.temperature)).toEqual([0.9, 0]);
        expect(captured[1]?.messages?.[2]?.content).toContain('message');
        expect(captured[1]?.messages?.[2]?.content).toContain('pattern');
      } finally {
        queuedResponses = [];
      }
    });
  }
  test('exhausts four structured attempts when the message pattern keeps failing', async () => {
    const before = calls.length;
    const previousResponse = responseText;
    responseText = JSON.stringify({ message: '  ' });
    try {
      const client = new FeedLLMClient(undefined, 'groq');
      await expect(
        client.generateJSON(
          'Generate group message',
          {
            required: ['message'],
            properties: { message: { type: 'string', pattern: '\\S' } },
          },
          { format: 'json' }
        )
      ).rejects.toThrow(/message.*pattern/i);
      expect(calls.slice(before)).toHaveLength(4);
      expect(calls.slice(before).every((call) => !call.success)).toBe(true);
    } finally {
      responseText = previousResponse;
    }
  });
  test('validates pattern against the candidate XML wrapper that has required fields', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content:
          '<output><response><message>wrapped value</message></response></output>',
        finish: 'stop',
      },
      {
        content: '<response><message>root value</message></response>',
        finish: 'stop',
      },
    ];
    const schema = {
      required: ['message'],
      properties: { message: { type: 'string' as const, pattern: '\\S' } },
    };
    expect(
      await client.generateJSON<{ message: string }>('Wrapped message', schema)
    ).toEqual({ message: 'wrapped value' });
    expect(
      await client.generateJSON<{ message: string }>('Root message', schema)
    ).toEqual({
      message: 'root value',
    });
  });

  test('accepts the wrapped candidate when another candidate fails the pattern', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [
      {
        content:
          '<output><message></message><response><message>valid wrapped</message></response></output>',
        finish: 'stop',
      },
    ];
    try {
      expect(
        await client.generateJSON<{ message: string }>('Wrapped message', {
          required: ['message'],
          properties: { message: { type: 'string', pattern: '\\S' } },
        })
      ).toEqual({ message: 'valid wrapped' });
    } finally {
      queuedResponses = [];
    }
  });
  test('does not make optional patterned fields required', async () => {
    const client = new FeedLLMClient(undefined, 'groq');
    queuedResponses = [{ content: '{"other":"value"}', finish: 'stop' }];
    try {
      expect(
        await client.generateJSON<{ other: string }>(
          'Optional message',
          { properties: { message: { type: 'string', pattern: '\\S' } } },
          { format: 'json' }
        )
      ).toEqual({ other: 'value' });
    } finally {
      queuedResponses = [];
    }
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
          await client.generateJSON<{ name: string }>(
            'Required context',
            { required: ['name'] },
            { temperature: 0.9 }
          )
        ).toEqual({ name: 'Corrected' });
        const captured = calls.slice(before);
        expect(captured.map((call) => call.success)).toEqual([false, true]);
        expect(captured.map((call) => call.temperature)).toEqual([0.9, 0]);
        expect(captured[0]?.rawResponse).toBe(invalid);
        expect(captured[0]?.messages).toHaveLength(2);
        expect(captured[1]?.messages).toHaveLength(3);
        const feedback = captured[1]?.messages?.[2]?.content;
        expect(feedback).toContain('complete');
        expect(feedback).toContain(captured[0]?.error);
        expect(feedback).toContain('close each tag with the identical name');
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
