import { getEmbedding } from '@feed/engine/embedding';
/**
 * Groq Plugin for Feed Agents
 *
 * Provides access to Groq's fast LLM inference for agent decision-making.
 * Supports both small and large models with automatic trajectory logging.
 *
 * @packageDocumentation
 */

import type { createGroq } from '@ai-sdk/groq';
import type {
  IAgentRuntime,
  ModelTypeName,
  ObjectGenerationParams,
  Plugin,
} from '@elizaos/core';
import {
  type DetokenizeTextParams,
  type GenerateTextParams,
  ModelType,
  type TokenizeTextParams,
} from '@elizaos/core';
import { GROQ_MODELS, getAgentLLMBridge, type JsonValue } from '@feed/shared';
import { generateObject, generateText, jsonSchema } from 'ai';
import { getEncoding } from 'js-tiktoken';
import {
  createAgentGroq,
  resolveAgentInferenceProvider,
  resolveGroqModel,
} from '../llm/direct-groq';
import { buildReasoningTraceMetadata } from '../llm/reasoning-trace';
import { getAgentLLMTimeoutMs } from '../llm/request-timeout';
import {
  ensureTrajectoryStep,
  type RuntimeTrajectoryLogger,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { logger } from '../shared/logger';
import { isPromptLoggingEnabled, logPrompt } from '../utils/prompt-logger';

function resolveGroqRuntimeModel(
  runtime: IAgentRuntime,
  size: 'small' | 'large'
): string {
  return resolveGroqModel({ runtime, modelSize: size });
}

/**
 * Groq/Surplus model IDs (e.g. Llama, gpt-oss) are not tiktoken models, so
 * `encodingForModel(<provider id>)` throws "Unknown model". Tokenization here
 * is an explicit approximation using the o200k_base encoding, not the
 * provider's exact tokenizer.
 * @internal
 */
let approximateEncoding: ReturnType<typeof getEncoding> | null = null;
function getApproximateEncoding(): ReturnType<typeof getEncoding> {
  approximateEncoding ??= getEncoding('o200k_base');
  return approximateEncoding;
}

/**
 * Tokenizes text (approximate; see getApproximateEncoding)
 * @internal
 */
async function tokenizeText(_model: ModelTypeName, prompt: string) {
  return getApproximateEncoding().encode(prompt);
}

/**
 * Detokenizes tokens back to text (approximate; see getApproximateEncoding)
 * @internal
 */
async function detokenizeText(_model: ModelTypeName, tokens: number[]) {
  return getApproximateEncoding().decode(tokens);
}

/**
 * Generates text using Groq API
 * @internal
 */
async function generateGroqText(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: {
    prompt: string;
    system?: string;
    temperature: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stopSequences: string[];
    trajectoryLogger?: RuntimeTrajectoryLogger;
    trajectoryId?: string;
    purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
    actionType?: string;
    modelVersion?: string;
    runtime?: IAgentRuntime;
  }
) {
  if (!params.prompt?.trim()) throw new Error('Agent LLM prompt is required');
  const provider = resolveAgentInferenceProvider(params.runtime);
  const startTime = Date.now();
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;
  let stepId: string | null = null;

  if (params.runtime) {
    const activeStep = await ensureTrajectoryStep(params.runtime);
    if (activeStep) {
      trajectoryLogger = activeStep.logger;
      trajectoryId = activeStep.trajectoryId;
      stepId = activeStep.stepId;
    }
  } else if (trajectoryLogger && trajectoryId) {
    stepId = trajectoryLogger.getCurrentStepId(trajectoryId);
  }

  const result = await generateText({
    model: groq.languageModel(model),
    prompt: params.prompt,
    system: params.system,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    frequencyPenalty: params.frequencyPenalty,
    presencePenalty: params.presencePenalty,
    stopSequences: params.stopSequences,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(getAgentLLMTimeoutMs()),
  }).catch((error: Error) => {
    if (trajectoryLogger && stepId) {
      trajectoryLogger.logLLMCall(stepId, {
        model,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        response: '',
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        purpose: params.purpose || 'action',
        actionType: params.actionType,
        latencyMs: Date.now() - startTime,
        metadata: { success: false, error: error.message },
      });
    }
    getAgentLLMBridge()?.({
      provider,
      model,
      promptType: 'groq_plugin_text',
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      rawResponse: '',
      inputTokens: 0,
      outputTokens: 0,
      success: false,
      error: error.message,
      durationMs: Date.now() - startTime,
    });
    throw error;
  });
  getAgentLLMBridge()?.({
    provider,
    model,
    promptType: params.actionType || 'groq_plugin_text',
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    systemPrompt: params.system || '',
    userPrompt: params.prompt,
    rawResponse: result.text,
    success: Boolean(result.text?.trim()),
    error: result.text?.trim() ? undefined : 'LLM returned empty content',
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    totalTokens: result.usage.totalTokens,
    durationMs: Date.now() - startTime,
  });

  const latencyMs = Date.now() - startTime;

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: params.actionType || params.purpose || 'groq_plugin_text',
      input: `System: ${params.system || ''}\n\nUser: ${params.prompt}`,
      output: result.text,
      metadata: {
        provider: 'groq_plugin',
        model,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      },
    });
  }

  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(result.text);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      modelVersion: params.modelVersion,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response: result.text,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      ...reasoningMetadata,
      metadata: {
        success: Boolean(result.text?.trim()),
        ...(result.text?.trim() ? {} : { error: 'LLM returned empty content' }),
      },
    });
  }

  if (!result.text?.trim()) throw new Error('LLM returned empty content');
  return result.text;
}

/** Preserve reported counts on structured-output errors; never estimate them. */
function failedObjectUsage(error: Error): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const cause = error.cause;
  const candidate =
    ('usage' in error ? error.usage : undefined) ??
    (cause && typeof cause === 'object' && 'usage' in cause
      ? cause.usage
      : undefined);
  if (!candidate || typeof candidate !== 'object') return {};
  const usage = candidate as Record<string, unknown>;
  const tokenCount = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : undefined;
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    totalTokens: tokenCount(usage.totalTokens),
  };
}

/**
 * Generates structured object using Groq API
 * @internal
 */
async function generateGroqObject(
  groq: ReturnType<typeof createGroq>,
  model: string,
  params: ObjectGenerationParams,
  runtime: IAgentRuntime
) {
  if (!params.prompt?.trim()) throw new Error('Agent LLM prompt is required');
  if (params.output && params.output !== 'object') {
    throw new Error(`Unsupported agent object output: ${params.output}`);
  }
  const provider = resolveAgentInferenceProvider(runtime);
  const system = runtime.character.system;
  const startTime = Date.now();
  const activeStep = await ensureTrajectoryStep(runtime);
  const options = {
    model: groq.languageModel(model),
    prompt: params.prompt,
    system,
    temperature: params.temperature,
    maxOutputTokens: params.maxTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(getAgentLLMTimeoutMs()),
  };
  const result = await (params.schema
    ? generateObject({
        ...options,
        output: 'object',
        schema: jsonSchema(params.schema as Parameters<typeof jsonSchema>[0]),
      })
    : generateObject({ ...options, output: 'no-schema' })
  ).catch((error: Error) => {
    // A structured-output failure can still carry the provider's reported usage
    // when the completion arrived and parsing or validation failed. Keep it, and
    // keep an unreported count absent rather than recording a second guess.
    const failedUsage = failedObjectUsage(error);
    if (activeStep)
      activeStep.logger.logLLMCall(activeStep.stepId, {
        model,
        systemPrompt: system || '',
        userPrompt: params.prompt,
        response: '',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        purpose: 'action',
        actionType: 'groq_plugin_object',
        latencyMs: Date.now() - startTime,
        promptTokens: failedUsage.inputTokens,
        completionTokens: failedUsage.outputTokens,
        metadata: { success: false, error: error.message },
      });
    getAgentLLMBridge()?.({
      provider,
      model,
      promptType: 'groq_plugin_object',
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      format: 'json',
      systemPrompt: system || '',
      userPrompt: params.prompt,
      rawResponse: '',
      inputTokens: failedUsage.inputTokens ?? 0,
      outputTokens: failedUsage.outputTokens ?? 0,
      totalTokens: failedUsage.totalTokens,
      success: false,
      error: error.message,
      durationMs: Date.now() - startTime,
    });
    throw error;
  });
  const { object, usage } = result;
  const response = JSON.stringify(object);
  const valid =
    typeof object === 'object' && object !== null && !Array.isArray(object);
  getAgentLLMBridge()?.({
    provider,
    model,
    promptType: 'groq_plugin_object',
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    format: 'json',
    systemPrompt: system || '',
    userPrompt: params.prompt,
    rawResponse: response,
    success: valid,
    error: valid ? undefined : 'LLM returned a non-object result',
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens,
    durationMs: Date.now() - startTime,
  });

  if (activeStep) {
    activeStep.logger.logLLMCall(activeStep.stepId, {
      model,
      systemPrompt: system || '',
      userPrompt: params.prompt,
      response,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 8192,
      purpose: 'action',
      actionType: 'groq_plugin_object',
      latencyMs: Date.now() - startTime,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      metadata: { success: valid },
    });
  }
  if (!valid) throw new Error('LLM returned a non-object result');
  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: 'groq_plugin_object',
      input: `System: ${system || ''}\n\nUser: ${params.prompt}`,
      output: response,
      metadata: {
        provider: 'groq_plugin',
        model,
        temperature: params.temperature,
      },
    });
  }
  return object as Record<string, JsonValue>;
}

export const groqPlugin: Plugin = {
  name: 'groq',
  description: 'Groq plugin for Feed agents',
  config: {
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? null,
    GROQ_SMALL_MODEL: process.env.GROQ_SMALL_MODEL || GROQ_MODELS.FREE.modelId,
    GROQ_LARGE_MODEL: process.env.GROQ_LARGE_MODEL || GROQ_MODELS.PRO.modelId,
  },
  async init(_config, runtime) {
    createAgentGroq(runtime);
  },
  models: {
    [ModelType.TEXT_EMBEDDING]: async (_runtime, params) => {
      // Eliza initializes its adapter with a null request to discover dimensions.
      // Use a real provider embedding for that probe, rather than a fixed vector.
      const text =
        params === null
          ? 'Embedding dimension discovery.'
          : typeof params === 'string'
            ? params
            : params?.text;
      if (!text) throw new Error('Embedding input must not be empty');
      const embedding = await getEmbedding(text);
      if (!embedding) throw new Error('Embedding provider is unavailable');
      return embedding;
    },
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      _runtime,
      { prompt, modelType = ModelType.TEXT_LARGE }: TokenizeTextParams
    ) => {
      return await tokenizeText(modelType ?? ModelType.TEXT_LARGE, prompt);
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      _runtime,
      { tokens, modelType = ModelType.TEXT_LARGE }: DetokenizeTextParams
    ) => {
      return await detokenizeText(modelType ?? ModelType.TEXT_LARGE, tokens);
    },
    [ModelType.TEXT_SMALL]: async (
      runtime,
      {
        prompt,
        stopSequences = [],
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
        maxTokens = 8000,
      }: GenerateTextParams
    ) => {
      const groq = createAgentGroq(runtime);

      const model = resolveGroqRuntimeModel(runtime, 'small');

      interface RuntimeWithExtensions extends IAgentRuntime {
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      }
      const extendedRuntime = runtime as RuntimeWithExtensions;
      const modelVersion = extendedRuntime.currentModelVersion;

      return await generateGroqText(groq, model, {
        prompt,
        system: runtime.character.system ?? undefined,
        temperature,
        maxTokens,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        purpose: 'action',
        modelVersion,
        runtime,
      });
    },
    [ModelType.TEXT_LARGE]: async (
      runtime,
      {
        prompt,
        stopSequences = [],
        maxTokens = 8192,
        temperature = 0.7,
        frequencyPenalty = 0.7,
        presencePenalty = 0.7,
      }: GenerateTextParams
    ) => {
      const groq = createAgentGroq(runtime);

      const model = resolveGroqRuntimeModel(runtime, 'large');

      type RuntimeWithTrajectory = typeof runtime & {
        currentTrajectoryId?: string;
        currentModelVersion?: string;
      };
      const runtimeWithTrajectory = runtime as RuntimeWithTrajectory;
      const modelVersion = runtimeWithTrajectory.currentModelVersion;

      logger.debug(
        'Using Groq model for inference',
        {
          model,
          modelSource: 'groq',
        },
        'GroqPlugin'
      );

      return await generateGroqText(groq, model, {
        prompt,
        system: runtime.character.system ?? undefined,
        temperature,
        maxTokens,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        purpose: 'action',
        modelVersion,
        runtime,
      });
    },
    [ModelType.OBJECT_SMALL]: async (
      runtime,
      params: ObjectGenerationParams
    ) => {
      const groq = createAgentGroq(runtime);
      const model = resolveGroqRuntimeModel(runtime, 'small');

      return (await generateGroqObject(groq, model, params, runtime)) as Record<
        string,
        JsonValue
      >;
    },
    [ModelType.OBJECT_LARGE]: async (
      runtime,
      params: ObjectGenerationParams
    ) => {
      const groq = createAgentGroq(runtime);
      const model = resolveGroqRuntimeModel(runtime, 'large');

      return (await generateGroqObject(groq, model, params, runtime)) as Record<
        string,
        JsonValue
      >;
    },
  },
};
