import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IAgentRuntime } from '@elizaos/core';
import type { AgentLLMBridgeData } from '@feed/shared';
import * as actualAi from 'ai';

let surplusConfigured = false;
const mockUsageBridge = mock((_call: AgentLLMBridgeData) => {});

const mockLanguageModel = mock((model: string) => `language-model:${model}`);
const mockCreateGroq = mock(() => ({
  languageModel: mockLanguageModel,
}));
const mockGenerateText = mock(async () => ({
  text: 'mocked response',
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
}));
const mockGenerateObject = mock(async () => ({
  object: { ok: true },
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
}));
const mockLogPrompt = mock(async () => undefined);
const mockGetEmbedding = mock(
  async (_text: string): Promise<number[] | null> => [0.1, 0.2]
);

mock.module('@ai-sdk/groq', () => ({
  createGroq: mockCreateGroq,
}));

mock.module('ai', () => ({
  ...actualAi,
  generateObject: mockGenerateObject,
  jsonSchema: (schema: object) => schema,
  generateText: mockGenerateText,
}));

mock.module('@feed/engine/embedding', () => ({
  getEmbedding: mockGetEmbedding,
}));

mock.module('@feed/shared', () => ({
  getSurplusConfig: () =>
    surplusConfigured
      ? {
          apiKey: 'test-surplus-key',
          baseURL: 'https://surplus.example/v1',
          model: 'surplus-model',
        }
      : null,
  getAgentLLMBridge: () => mockUsageBridge,
  GROQ_MODELS: {
    FREE: { modelId: 'groq-small-model' },
    PRO: { modelId: 'groq-large-model' },
  },
}));

mock.module('@elizaos/core', () => ({
  ModelType: {
    TEXT_EMBEDDING: 'text_embedding',
    OBJECT_LARGE: 'object_large',
    OBJECT_SMALL: 'object_small',
    TEXT_LARGE: 'text_large',
    TEXT_SMALL: 'text_small',
    TEXT_TOKENIZER_DECODE: 'text_tokenizer_decode',
    TEXT_TOKENIZER_ENCODE: 'text_tokenizer_encode',
  },
}));

mock.module('../../shared/logger', () => ({
  logger: {
    debug: mock(),
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

mock.module('../../utils/prompt-logger', () => ({
  isPromptLoggingEnabled: () => false,
  logPrompt: mockLogPrompt,
}));

const { ModelType } = await import('@elizaos/core');
const { groqPlugin } = await import('../groq');

const runtime = {
  character: { system: 'System prompt' },
  fetch: undefined,
  getSetting: (key: string) => {
    if (key === 'GROQ_API_KEY') return 'test-groq-key';
    if (key === 'GROQ_BASE_URL') return 'https://groq.example';
    return undefined;
  },
} as unknown as IAgentRuntime;

const runtimeWithModelOverride = {
  character: { system: 'System prompt' },
  fetch: undefined,
  getSetting: (key: string) => {
    if (key === 'GROQ_API_KEY') return 'test-groq-key';
    if (key === 'GROQ_BASE_URL') return 'https://proxy.example/v1';
    if (key === 'GROQ_SMALL_MODEL') return 'proxy-small';
    if (key === 'GROQ_LARGE_MODEL') return 'proxy-large';
    if (key === 'GROQ_PRIMARY_MODEL') return 'proxy-primary';
    return undefined;
  },
} as unknown as IAgentRuntime;

describe('groqPlugin embedding dimension discovery', () => {
  beforeEach(() => mockGetEmbedding.mockClear());

  it('supports the null dimension probe used by Eliza runtime initialization', async () => {
    const embedding = await groqPlugin.models![ModelType.TEXT_EMBEDDING]!(
      runtime,
      null
    );
    expect(embedding).toEqual([0.1, 0.2]);
    expect(mockGetEmbedding).toHaveBeenCalledTimes(1);
    expect(mockGetEmbedding.mock.calls[0]?.[0]).toBeTruthy();
  });

  it.each([
    'A memory.',
    { text: 'A memory.' },
  ])('embeds normal memory input %p', async (params) => {
    const embedding = await groqPlugin.models![ModelType.TEXT_EMBEDDING]!(
      runtime,
      params
    );
    expect(embedding).toEqual([0.1, 0.2]);
    expect(mockGetEmbedding).toHaveBeenCalledWith('A memory.');
  });

  it('rejects the dimension probe when the embedding provider is unavailable', async () => {
    mockGetEmbedding.mockResolvedValueOnce(null);
    await expect(
      groqPlugin.models![ModelType.TEXT_EMBEDDING]!(runtime, null)
    ).rejects.toThrow('Embedding provider is unavailable');
  });

  it('still rejects an empty memory instead of treating it as a dimension probe', async () => {
    await expect(
      groqPlugin.models![ModelType.TEXT_EMBEDDING]!(runtime, { text: '' })
    ).rejects.toThrow('Embedding input must not be empty');
    expect(mockGetEmbedding).not.toHaveBeenCalled();
  });
});

describe('groqPlugin TEXT_SMALL', () => {
  beforeEach(() => {
    mockCreateGroq.mockClear();
    mockLanguageModel.mockClear();
    mockGenerateText.mockClear();
    mockGenerateObject.mockClear();
    mockLogPrompt.mockClear();
  });

  it('passes caller-provided generation params through to Groq', async () => {
    const response = await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtime, {
      frequencyPenalty: 0.2,
      maxTokens: 321,
      presencePenalty: 0.1,
      prompt: 'tell my agent to buy TSLAI',
      stopSequences: ['</response>'],
      temperature: 0.4,
    });

    expect(response).toBe('mocked response');
    expect(mockCreateGroq).toHaveBeenCalledWith({
      apiKey: 'test-groq-key',
      baseURL: 'https://groq.example',
      fetch: undefined,
    });
    expect(mockLanguageModel).toHaveBeenCalledWith('groq-small-model');
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        frequencyPenalty: 0.2,
        maxOutputTokens: 321,
        model: 'language-model:groq-small-model',
        presencePenalty: 0.1,
        prompt: 'tell my agent to buy TSLAI',
        stopSequences: ['</response>'],
        system: 'System prompt',
        temperature: 0.4,
      })
    );
  });

  it('keeps the previous defaults when caller params are omitted', async () => {
    await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: 'default params',
    });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        frequencyPenalty: 0.7,
        maxOutputTokens: 8000,
        presencePenalty: 0.7,
        prompt: 'default params',
        stopSequences: [],
        temperature: 0.7,
      })
    );
  });

  it('uses runtime model overrides for small and large routes', async () => {
    await groqPlugin.models[ModelType.TEXT_SMALL]?.(runtimeWithModelOverride, {
      prompt: 'small route',
    });
    await groqPlugin.models[ModelType.TEXT_LARGE]?.(runtimeWithModelOverride, {
      prompt: 'large route',
    });

    expect(mockCreateGroq).toHaveBeenCalledWith({
      apiKey: 'test-groq-key',
      baseURL: 'https://proxy.example/v1',
      fetch: undefined,
    });
    expect(mockLanguageModel).toHaveBeenCalledWith('proxy-small');
    expect(mockLanguageModel).toHaveBeenCalledWith('proxy-large');
  });
});

it('passes system, schema and limits to object generation', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
  await groqPlugin.models[ModelType.OBJECT_LARGE]?.(runtime, {
    prompt: 'make a decision',
    schema,
    maxTokens: 123,
    temperature: 0.3,
  });
  expect(mockGenerateObject).toHaveBeenCalledWith(
    expect.objectContaining({
      system: 'System prompt',
      prompt: 'make a decision',
      schema,
      maxOutputTokens: 123,
      maxRetries: 0,
    })
  );
});

it('records failed text and object requests in the active training step', async () => {
  const { setTrajectoryContext, clearTrajectoryContext } = await import(
    '../plugin-trajectory-logger/src/action-interceptor'
  );
  const logLLMCall = mock();
  setTrajectoryContext(runtime, 'audit-trajectory', {
    startStep: () => 'audit-step',
    getCurrentStepId: () => 'audit-step',
    logLLMCall,
    logProviderAccess: () => {},
    completeStep: () => {},
  });
  try {
    mockGenerateText.mockRejectedValueOnce(new Error('text provider failed'));
    await expect(
      groqPlugin.models![ModelType.TEXT_SMALL]!(runtime, {
        prompt: 'retain failed text context',
      })
    ).rejects.toThrow('text provider failed');
    expect(logLLMCall.mock.calls.at(-1)?.[1]).toMatchObject({
      userPrompt: 'retain failed text context',
      metadata: { success: false, error: 'text provider failed' },
    });
    mockGenerateObject.mockRejectedValueOnce(
      new Error('object provider failed')
    );
    await expect(
      groqPlugin.models![ModelType.OBJECT_SMALL]!(runtime, {
        prompt: 'retain failed object context',
      })
    ).rejects.toThrow('object provider failed');
    expect(logLLMCall.mock.calls.at(-1)?.[1]).toMatchObject({
      userPrompt: 'retain failed object context',
      metadata: { success: false, error: 'object provider failed' },
    });
  } finally {
    clearTrajectoryContext(runtime);
  }
});

it('tokenizes for non-tiktoken provider models instead of throwing', async () => {
  const encode = groqPlugin.models?.[ModelType.TEXT_TOKENIZER_ENCODE];
  const decode = groqPlugin.models?.[ModelType.TEXT_TOKENIZER_DECODE];
  if (!encode || !decode) throw new Error('tokenizer handlers missing');
  const tokens = (await encode(runtime, {
    prompt: 'hello world',
    modelType: ModelType.TEXT_LARGE,
  } as never)) as number[];
  expect(tokens.length).toBeGreaterThan(0);
  expect(
    await decode(runtime, { tokens, modelType: ModelType.TEXT_LARGE } as never)
  ).toBe('hello world');
});

describe('native inference usage attribution', () => {
  const savedCloudKey = process.env.ELIZACLOUD_API_KEY;
  beforeEach(() => {
    delete process.env.ELIZACLOUD_API_KEY;
    mockUsageBridge.mockClear();
  });
  afterEach(() => {
    surplusConfigured = false;
    if (savedCloudKey === undefined) delete process.env.ELIZACLOUD_API_KEY;
    else process.env.ELIZACLOUD_API_KEY = savedCloudKey;
  });

  const cloudRuntime = {
    ...runtime,
    getSetting: (key: string) =>
      key === 'ELIZACLOUD_API_KEY' ? 'test-cloud-key' : runtime.getSetting(key),
  };
  for (const provider of ['surplus', 'elizacloud', 'groq'] as const) {
    for (const modelType of [
      ModelType.TEXT_SMALL,
      ModelType.TEXT_LARGE,
      ModelType.OBJECT_SMALL,
      ModelType.OBJECT_LARGE,
    ]) {
      it(`${provider} ${modelType} reports the selected provider and usage`, async () => {
        surplusConfigured = provider === 'surplus';
        // Surplus must take precedence even when a runtime cloud key is set.
        const selectedRuntime = provider === 'groq' ? runtime : cloudRuntime;
        await groqPlugin.models![modelType]!(selectedRuntime, {
          prompt: 'Hello',
        });
        expect(mockUsageBridge).toHaveBeenCalledTimes(1);
        expect(mockUsageBridge.mock.calls[0]?.[0]).toMatchObject({
          provider,
          model:
            provider === 'surplus'
              ? 'surplus-model'
              : modelType === ModelType.TEXT_SMALL ||
                  modelType === ModelType.OBJECT_SMALL
                ? 'groq-small-model'
                : 'groq-large-model',
          success: true,
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        });
      });
      it(`${provider} ${modelType} reports the selected provider on failure`, async () => {
        surplusConfigured = provider === 'surplus';
        const selectedRuntime = provider === 'groq' ? runtime : cloudRuntime;
        const failure = new Error('provider unavailable');
        const generator =
          modelType === ModelType.TEXT_SMALL ||
          modelType === ModelType.TEXT_LARGE
            ? mockGenerateText
            : mockGenerateObject;
        generator.mockRejectedValueOnce(failure);
        await expect(
          groqPlugin.models![modelType]!(selectedRuntime, { prompt: 'Hello' })
        ).rejects.toThrow('provider unavailable');
        expect(mockUsageBridge).toHaveBeenCalledTimes(1);
        expect(mockUsageBridge.mock.calls[0]?.[0]).toMatchObject({
          provider,
          success: false,
          error: 'provider unavailable',
          inputTokens: 0,
          outputTokens: 0,
        });
      });
    }
  }
});

describe('structured-output failure usage', () => {
  const truncatedUsage = {
    inputTokens: 387,
    outputTokens: 1,
    totalTokens: 388,
  };
  const truncatedResponse = () =>
    new actualAi.NoObjectGeneratedError({
      message: 'No object generated: response did not match schema.',
      text: '{"decision"',
      response: {
        id: 'gen-truncated',
        timestamp: new Date(0),
        modelId: 'groq-small-model',
      },
      usage: truncatedUsage,
      finishReason: 'length',
    });

  beforeEach(() => mockUsageBridge.mockClear());

  it.each([
    ModelType.OBJECT_SMALL,
    ModelType.OBJECT_LARGE,
  ])('%s keeps provider-reported usage when parsing fails', async (modelType) => {
    mockGenerateObject.mockRejectedValueOnce(truncatedResponse());
    await expect(
      groqPlugin.models![modelType]!(runtime, {
        prompt: 'truncated object',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        temperature: 0,
        maxTokens: 1,
      })
    ).rejects.toThrow('No object generated');
    expect(mockUsageBridge).toHaveBeenCalledTimes(1);
    expect(mockUsageBridge.mock.calls[0]?.[0]).toMatchObject({
      success: false,
      inputTokens: 387,
      outputTokens: 1,
      totalTokens: 388,
      error: 'No object generated: response did not match schema.',
    });
  });

  it('does not invent usage for ordinary failures', async () => {
    mockGenerateObject.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(
      groqPlugin.models![ModelType.OBJECT_SMALL]!(runtime, {
        prompt: 'transport failure',
      })
    ).rejects.toThrow('socket hang up');
    expect(mockUsageBridge).toHaveBeenCalledTimes(1);
    const call = mockUsageBridge.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      error: 'socket hang up',
    });
    expect(call?.totalTokens).toBeUndefined();
  });

  it('records reported usage on the failed trajectory step', async () => {
    const { setTrajectoryContext, clearTrajectoryContext } = await import(
      '../plugin-trajectory-logger/src/action-interceptor'
    );
    const logLLMCall = mock();
    setTrajectoryContext(runtime, 'usage-trajectory', {
      startStep: () => 'usage-step',
      getCurrentStepId: () => 'usage-step',
      logLLMCall,
      logProviderAccess: () => {},
      completeStep: () => {},
    });
    try {
      mockGenerateObject.mockRejectedValueOnce(truncatedResponse());
      await expect(
        groqPlugin.models![ModelType.OBJECT_SMALL]!(runtime, {
          prompt: 'truncated object',
        })
      ).rejects.toThrow('No object generated');
      expect(logLLMCall.mock.calls.at(-1)?.[1]).toMatchObject({
        promptTokens: 387,
        completionTokens: 1,
        metadata: { success: false },
      });
    } finally {
      clearTrajectoryContext(runtime);
    }
  });
});
