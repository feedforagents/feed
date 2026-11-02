/**
 * Direct Groq LLM calls
 *
 * Supports Groq models for fast inference.
 * All LLM calls are automatically logged to trajectory logger if available.
 *
 * IMPORTANT FOR RL TRAINING:
 * - When runtime is provided, trajectory context is automatically extracted
 * - Every LLM call is logged with EXACT input/output for training data
 * - Purpose field tracks call type: action, reasoning, evaluation, response
 */

import { createGroq } from '@ai-sdk/groq';
import type { IAgentRuntime } from '@elizaos/core';
import { GROQ_MODELS, getAgentLLMBridge, getSurplusConfig } from '@feed/shared';
import { generateText } from 'ai';
import {
  ensureTrajectoryStep,
  getTrajectoryContext,
  type RuntimeTrajectoryLogger,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { isPromptLoggingEnabled, logPrompt } from '../utils/prompt-logger';
import { buildReasoningTraceMetadata } from './reasoning-trace';
import { getAgentLLMTimeoutMs } from './request-timeout';

function getRuntimeSetting(
  runtime: IAgentRuntime | undefined,
  key: string
): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const value = runtime.getSetting(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The provider that `createAgentGroq` actually routes to, using the same
 * precedence (Surplus > ElizaCloud > Groq), so telemetry is labeled with the
 * real endpoint instead of always "groq".
 */
export function resolveAgentInferenceProvider(
  runtime?: IAgentRuntime
): 'surplus' | 'elizacloud' | 'groq' {
  if (getSurplusConfig()) return 'surplus';
  const elizacloudKey =
    getRuntimeSetting(runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  return elizacloudKey ? 'elizacloud' : 'groq';
}

/**
 * Provider-reported usage carried by a failed text generation, when the SDK
 * supplies it. A completion that arrived but produced no usable text (an empty
 * or filtered response) still consumed provider tokens. Transport failures
 * usually carry none, and a count the provider never reported stays absent
 * instead of becoming an estimate.
 */
export function failedUsageOf(
  error: unknown
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const usage = (candidate as { usage?: unknown }).usage;
    if (!usage || typeof usage !== 'object') continue;
    const { inputTokens, outputTokens, totalTokens } = usage as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      totalTokens?: unknown;
    };
    if (
      typeof inputTokens !== 'number' &&
      typeof outputTokens !== 'number' &&
      typeof totalTokens !== 'number'
    ) {
      continue;
    }
    return {
      inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
      totalTokens: typeof totalTokens === 'number' ? totalTokens : undefined,
    };
  }
  return undefined;
}

function resolveGroqBaseURL(runtime: IAgentRuntime | undefined): string {
  const surplus = getSurplusConfig();
  if (surplus) return surplus.baseURL;
  // When ElizaCloud is configured, route through its OpenAI-compatible proxy
  const elizacloudKey =
    getRuntimeSetting(runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  if (elizacloudKey) {
    const base = (
      getRuntimeSetting(runtime, 'ELIZACLOUD_API_URL') ||
      process.env.ELIZACLOUD_API_URL ||
      'https://www.elizacloud.ai'
    ).replace(/\/$/, '');
    return `${base}/api/v1`;
  }
  return (
    getRuntimeSetting(runtime, 'GROQ_BASE_URL') ||
    process.env.GROQ_BASE_URL ||
    'https://api.groq.com/openai/v1'
  );
}

export function resolveGroqModel(params: {
  modelSize?: 'small' | 'large';
  runtime?: IAgentRuntime;
}): string {
  const surplus = getSurplusConfig();
  if (surplus) return surplus.model;
  const defaultSmall = process.env.GROQ_SMALL_MODEL || GROQ_MODELS.FREE.modelId;
  const defaultLarge = process.env.GROQ_LARGE_MODEL || GROQ_MODELS.PRO.modelId;

  const smallModel =
    getRuntimeSetting(params.runtime, 'GROQ_SMALL_MODEL') || defaultSmall;
  const largeModel =
    getRuntimeSetting(params.runtime, 'GROQ_LARGE_MODEL') || defaultLarge;
  const primaryModel =
    getRuntimeSetting(params.runtime, 'GROQ_PRIMARY_MODEL') ||
    process.env.GROQ_PRIMARY_MODEL ||
    largeModel;

  if (params.modelSize === 'small') {
    return smallModel;
  }
  if (params.modelSize === 'large') {
    return largeModel;
  }

  return primaryModel;
}

export function createAgentGroq(runtime?: IAgentRuntime) {
  const surplus = getSurplusConfig();
  if (surplus) {
    return createGroq({
      apiKey: surplus.apiKey,
      fetch: runtime?.fetch ?? undefined,
      baseURL: surplus.baseURL,
    });
  }
  const elizacloudKey =
    getRuntimeSetting(runtime, 'ELIZACLOUD_API_KEY') ||
    process.env.ELIZACLOUD_API_KEY;
  const isElizaCloud = Boolean(elizacloudKey);
  const apiKey =
    elizacloudKey ||
    getRuntimeSetting(runtime, 'GROQ_API_KEY') ||
    process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error(
      'No API key for inference — set GROQ_API_KEY or ELIZACLOUD_API_KEY'
    );
  }

  return createGroq({
    apiKey,
    fetch: runtime?.fetch ?? undefined,
    baseURL: resolveGroqBaseURL(runtime),
    ...(isElizaCloud ? { headers: { 'X-API-Key': apiKey } } : {}),
  });
}

export async function callGroqDirect(params: {
  prompt: string;
  system?: string;
  modelSize?: 'small' | 'large';
  temperature?: number;
  maxTokens?: number;
  trajectoryLogger?: RuntimeTrajectoryLogger;
  trajectoryId?: string;
  purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  actionType?: string;
  runtime?: IAgentRuntime; // Pass runtime to access settings
}): Promise<string> {
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
    throw new Error('Agent LLM prompt is required');
  }
  // Auto-extract trajectory context from runtime if not explicitly provided
  // This ensures ALL LLM calls are logged for RL training
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

  const groq = createAgentGroq(params.runtime);
  const provider = resolveAgentInferenceProvider(params.runtime);

  const model = resolveGroqModel({
    modelSize: params.modelSize,
    runtime: params.runtime,
  });

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

  const startTime = Date.now();

  // Add timeout to prevent hanging (60 seconds default, configurable)
  const timeoutMs = getAgentLLMTimeoutMs(
    params.maxTokens && params.maxTokens < 500 ? 20000 : 60000
  ); // Shorter timeout for small outputs

  const result = await generateText({
    model: groq.languageModel(model),
    prompt: params.prompt,
    system: params.system,
    temperature: params.temperature ?? 0.7,
    maxOutputTokens: params.maxTokens ?? 8192,
    maxRetries: 0, // Every request is observable; callers own explicit retries.
    abortSignal: AbortSignal.timeout(timeoutMs),
    experimental_telemetry: { isEnabled: false },
  }).catch((error: Error) => {
    const usage = failedUsageOf(error);
    if (trajectoryLogger && stepId) {
      trajectoryLogger.logLLMCall(stepId, {
        model,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        response: '',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        purpose: params.purpose || 'action',
        actionType: params.actionType,
        latencyMs: Date.now() - startTime,
        metadata: { success: false, error: error.message },
      });
    }
    getAgentLLMBridge()?.({
      provider,
      model,
      promptType: params.actionType || params.purpose || 'agent-groq-direct',
      format: 'text',
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 8192,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      rawResponse: '',
      parsedResponse: null,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      totalTokens: usage?.totalTokens,
      durationMs: Date.now() - startTime,
      success: false,
      error: error.message,
    });
    throw error;
  });
  if (!result.text?.trim()) {
    if (trajectoryLogger && stepId) {
      trajectoryLogger.logLLMCall(stepId, {
        model,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        response: result.text || '',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        purpose: params.purpose || 'action',
        actionType: params.actionType,
        latencyMs: Date.now() - startTime,
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
        metadata: { success: false, error: 'LLM returned empty content' },
      });
    }
    getAgentLLMBridge()?.({
      provider,
      model,
      promptType: params.actionType || params.purpose || 'agent-groq-direct',
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      rawResponse: result.text || '',
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: 'LLM returned empty content',
    });
    throw new Error('LLM returned empty content');
  }

  const latencyMs = Date.now() - startTime;

  // Log to trajectory if available (CRITICAL for RL training data collection)
  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(result.text);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response: result.text,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 8192,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      ...reasoningMetadata,
    });
  }

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: params.actionType || params.purpose || 'groq_direct',
      input: `System: ${params.system || ''}\n\nUser: ${params.prompt}`,
      output: result.text,
      metadata: {
        provider,
        model,
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
      },
    });
  }

  // Forward to DAG trace bridge if active (game-tick observability)
  {
    const bridge = getAgentLLMBridge();
    if (bridge) {
      bridge({
        provider,
        model,
        promptType: params.actionType || params.purpose || 'agent-groq-direct',
        format: 'text',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 8192,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        rawResponse: result.text,
        parsedResponse: null,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        durationMs: latencyMs,
        success: true,
      });
    }
  }

  return result.text;
}
