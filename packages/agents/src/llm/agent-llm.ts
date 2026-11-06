import { getSurplusConfig } from '@feed/shared';
/**
 * Agent LLM Provider
 *
 * LLM interface for autonomous agents supporting multiple inference backends:
 * - HuggingFace: Cloud inference endpoints for trained models
 * - Phala: Trusted execution environment for secure inference
 * - Ollama: Local inference for development and fine-tuned models
 * - Groq: Cloud inference with fast response times (default)
 *
 * @remarks
 * This provider is exclusively for autonomous agents. Core game systems
 * (MarketDecisionEngine, etc.) use FeedLLMClient with Groq/Claude/OpenAI.
 *
 * @example
 * ```typescript
 * const response = await callAgentLLM({
 *   prompt: 'Analyze market conditions',
 *   system: 'You are a trading agent',
 *   archetype: 'trader',
 *   temperature: 0.7,
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { IAgentRuntime } from '@elizaos/core';
import { getAgentLLMBridge } from '@feed/shared';
import {
  ensureTrajectoryStep,
  getTrajectoryContext,
  type RuntimeTrajectoryLogger,
} from '../plugins/plugin-trajectory-logger/src/action-interceptor';
import { logger } from '../shared/logger';
import { callGroqDirect } from './direct-groq';
import { callOllama } from './ollama-provider';
import { buildReasoningTraceMetadata } from './reasoning-trace';

/**
 * Supported LLM provider types for agent inference
 */
export type AgentLLMProvider =
  | 'surplus'
  | 'huggingface'
  | 'phala'
  | 'ollama'
  | 'groq';

/**
 * Determines the configured LLM provider from environment variables
 *
 * @returns The configured provider, defaulting to 'groq' if not specified
 * @internal
 */
function getConfiguredProvider(): AgentLLMProvider {
  if (getSurplusConfig()) return 'surplus';
  const provider = process.env.AGENT_LLM_PROVIDER?.trim().toLowerCase();
  if (provider === 'huggingface' || provider === 'hf') return 'huggingface';
  if (provider === 'phala') return 'phala';
  if (provider === 'ollama' || provider === 'local') return 'ollama';
  if (!provider || provider === 'groq') return 'groq';
  throw new Error(`Unsupported AGENT_LLM_PROVIDER: ${provider}`);
}

/**
 * Parameters for agent LLM inference calls
 */
export interface AgentLLMParams {
  /** User prompt text */
  prompt: string;
  /** System prompt for model context */
  system?: string;
  /** Agent archetype for model selection */
  archetype?: string;
  /** Sampling temperature (0-1) */
  temperature?: number;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Trajectory logger for RL training data collection */
  trajectoryLogger?: RuntimeTrajectoryLogger;
  /** Trajectory ID for logging context */
  trajectoryId?: string;
  /** Purpose of the LLM call for training categorization */
  purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  /** Specific action type being performed */
  actionType?: string;
  /** Agent runtime for context extraction */
  runtime?: IAgentRuntime;
}

/** OpenAI-compatible usage block as reported by the provider */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Provider-reported token counts for one call, as kept for accounting. */
interface TokenCounts {
  promptTokens?: number;
  completionTokens?: number;
}

/** Preserve provider-reported usage; non-finite/negative values are dropped. */
function toTokenCounts(
  usage: OpenAIUsage | undefined
): TokenCounts | undefined {
  if (!usage) return undefined;
  const valid = (n: number | undefined) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  return {
    promptTokens: valid(usage.prompt_tokens),
    completionTokens: valid(usage.completion_tokens),
  };
}

/**
 * Attach provider-reported counts to an error thrown after the response
 * arrived, so the caller's failure logging can still account for the usage
 * (issue #1550). Errors thrown before any response carry no counts and
 * keep their failure record at zero.
 */
function withTokenCounts(
  error: Error,
  tokenCounts: TokenCounts | undefined
): Error {
  if (tokenCounts)
    (error as Error & { tokenCounts?: TokenCounts }).tokenCounts = tokenCounts;
  return error;
}

/** Token counts a provider reported before the call failed, when present. */
function tokenCountsFromError(error: unknown): TokenCounts | undefined {
  if (!(error instanceof Error)) return undefined;
  const counts = (error as Error & { tokenCounts?: TokenCounts }).tokenCounts;
  if (!counts) return undefined;
  return {
    promptTokens: counts.promptTokens,
    completionTokens: counts.completionTokens,
  };
}

/**
 * Log (truncated) provider error bodies for operators instead of embedding
 * raw provider responses in errors that may surface to users.
 */
async function logProviderErrorBody(
  provider: string,
  response: Response
): Promise<void> {
  const body = await response.text();
  logger.warn(
    `${provider} API error response`,
    { status: response.status, body: body.slice(0, 500) },
    'AgentLLM'
  );
}

/**
 * Calls HuggingFace inference endpoint
 *
 * Supports both standard Inference API and OpenAI-compatible Inference Endpoints.
 * Configure via HUGGINGFACE_API_FORMAT environment variable.
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @throws Error if API key or endpoint not configured
 * @internal
 */
async function callHuggingFace(params: AgentLLMParams): Promise<string> {
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  const endpoint = process.env.HUGGINGFACE_MODEL_ENDPOINT;
  const apiFormat =
    process.env.HUGGINGFACE_API_FORMAT?.trim().toLowerCase() || 'inference';
  if (apiFormat !== 'inference' && apiFormat !== 'openai')
    throw new Error(`Unsupported HUGGINGFACE_API_FORMAT: ${apiFormat}`);

  if (!apiKey) {
    throw new Error('HUGGINGFACE_API_KEY not set');
  }
  if (!endpoint) {
    throw new Error('HUGGINGFACE_MODEL_ENDPOINT not set');
  }

  const startTime = Date.now();

  const messages: Array<{ role: string; content: string }> = [];
  if (params.system) {
    messages.push({ role: 'system', content: params.system });
  }
  messages.push({ role: 'user', content: params.prompt });

  let requestBody: string;
  let requestUrl = endpoint;

  if (apiFormat === 'openai') {
    requestBody = JSON.stringify({
      model:
        process.env.HUGGINGFACE_MODEL_NAME ||
        (params.archetype ? `feed-${params.archetype}` : 'default'),
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    });
    if (!endpoint.includes('/chat/completions')) {
      const base = endpoint.replace(/\/$/, '');
      requestUrl = base.endsWith('/v1')
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;
    }
  } else {
    requestBody = JSON.stringify({
      inputs:
        messages
          .map((message) => `${message.role}: ${message.content}`)
          .join('\n\n') + '\n\nassistant:',
      parameters: {
        temperature: params.temperature ?? 0.7,
        max_new_tokens: params.maxTokens ?? 2048,
        return_full_text: false,
      },
    });
  }

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: requestBody,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    await logProviderErrorBody('HuggingFace', response);
    throw new Error(`HuggingFace API error: ${response.status}`);
  }

  const data = (await response.json()) as
    | Array<{ generated_text: string }>
    | { generated_text: string }
    | {
        choices?: Array<{ message?: { content: string } }>;
        usage?: OpenAIUsage;
      };
  const latencyMs = Date.now() - startTime;

  let responseText: string;
  if ('choices' in data && data.choices) {
    responseText = data.choices[0]?.message?.content || '';
  } else if (Array.isArray(data)) {
    responseText = data[0]?.generated_text || '';
  } else if ('generated_text' in data) {
    responseText = data.generated_text || '';
  } else {
    responseText = '';
  }

  if (!responseText.trim())
    throw withTokenCounts(
      new Error('HuggingFace returned empty content'),
      'usage' in data ? toTokenCounts(data.usage) : undefined
    );
  await logToTrajectory(
    params,
    process.env.HUGGINGFACE_MODEL_NAME ||
      (params.archetype ? `feed-${params.archetype}` : 'default'),
    responseText,
    latencyMs,
    'usage' in data ? toTokenCounts(data.usage) : undefined
  );

  return responseText;
}

/**
 * Calls Phala TEE endpoint for secure inference
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @throws Error if endpoint not configured
 * @internal
 */
async function callPhala(params: AgentLLMParams): Promise<string> {
  const endpoint = process.env.PHALA_ENDPOINT;

  if (!endpoint) {
    throw new Error('PHALA_ENDPOINT not set');
  }

  const startTime = Date.now();

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: params.archetype ? `feed-${params.archetype}` : 'feed-default',
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        { role: 'user', content: params.prompt },
      ],
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!response.ok) {
    await logProviderErrorBody('Phala', response);
    throw new Error(`Phala API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content: string } }>;
    response?: string;
    usage?: OpenAIUsage;
  };
  const latencyMs = Date.now() - startTime;

  const responseText =
    data.choices?.[0]?.message?.content || data.response || '';

  if (!responseText.trim())
    throw withTokenCounts(
      new Error('Phala returned empty content'),
      toTokenCounts(data.usage)
    );
  await logToTrajectory(
    params,
    params.archetype ? `feed-${params.archetype}` : 'feed-default',
    responseText,
    latencyMs,
    toTokenCounts(data.usage)
  );

  return responseText;
}

/**
 * Calls Ollama for local inference
 *
 * Delegates to the shared ollama-provider implementation for consistency.
 *
 * @param params - LLM call parameters
 * @returns Generated text response
 * @internal
 */
async function callOllamaLocal(params: AgentLLMParams): Promise<string> {
  return callOllama({
    prompt: params.prompt,
    system: params.system,
    archetype: params.archetype,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    trajectoryLogger: params.trajectoryLogger,
    trajectoryId: params.trajectoryId,
    purpose: params.purpose,
    actionType: params.actionType,
    runtime: params.runtime,
  });
}

/**
 * Logs LLM call to trajectory logger for RL training data collection
 *
 * @param params - Original LLM call parameters
 * @param model - Model identifier used for the call
 * @param response - Generated response text
 * @param latencyMs - Call latency in milliseconds
 * @param tokenCounts - Optional token usage statistics
 * @internal
 */
async function logToTrajectory(
  params: AgentLLMParams,
  model: string,
  response: string,
  latencyMs: number,
  tokenCounts?: { promptTokens?: number; completionTokens?: number },
  error?: string
): Promise<void> {
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

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

  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(response);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 2048,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: tokenCounts?.promptTokens,
      completionTokens: tokenCounts?.completionTokens,
      ...reasoningMetadata,
      ...(error ? { metadata: { success: false, error } } : {}),
    });
  }

  // Forward to DAG trace bridge if active (game-tick observability)
  {
    const bridge = getAgentLLMBridge();
    if (bridge) {
      bridge({
        provider: getConfiguredProvider(),
        model,
        promptType: params.actionType || params.purpose || 'agent-llm',
        format: 'text',
        temperature: params.temperature ?? 0.7,
        maxTokens: params.maxTokens ?? 2048,
        systemPrompt: params.system || '',
        userPrompt: params.prompt,
        rawResponse: response,
        parsedResponse: null,
        inputTokens: tokenCounts?.promptTokens ?? 0,
        outputTokens: tokenCounts?.completionTokens ?? 0,
        totalTokens:
          (tokenCounts?.promptTokens ?? 0) +
          (tokenCounts?.completionTokens ?? 0),
        durationMs: latencyMs,
        success: !error,
        ...(error ? { error } : {}),
      });
    }
  }
}

/**
 * Main entry point for agent LLM inference calls
 *
 * Routes calls to the configured provider based on AGENT_LLM_PROVIDER environment variable.
 * Automatically logs all calls to trajectory logger for RL training data collection.
 *
 * @param params - LLM call parameters including prompt, system context, and configuration
 * @returns Generated text response from the configured provider
 * @throws Error if provider is misconfigured or unavailable
 *
 * @example
 * ```typescript
 * const response = await callAgentLLM({
 *   prompt: 'What should I trade?',
 *   system: 'You are a trading agent',
 *   archetype: 'trader',
 *   purpose: 'action',
 * });
 * ```
 */
export async function callAgentLLM(params: AgentLLMParams): Promise<string> {
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
    throw new Error('Agent LLM prompt is required');
  }
  const provider = getConfiguredProvider();

  logger.debug(
    'Agent LLM call',
    {
      provider,
      archetype: params.archetype,
      purpose: params.purpose,
    },
    'AgentLLM'
  );

  switch (provider) {
    case 'huggingface':
    case 'phala': {
      const started = Date.now();
      try {
        return await (provider === 'huggingface'
          ? callHuggingFace(params)
          : callPhala(params));
      } catch (error) {
        await logToTrajectory(
          params,
          provider === 'huggingface'
            ? process.env.HUGGINGFACE_MODEL_NAME ||
                (params.archetype ? `feed-${params.archetype}` : 'default')
            : params.archetype
              ? `feed-${params.archetype}`
              : 'feed-default',
          '',
          Date.now() - started,
          tokenCountsFromError(error),
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    }

    case 'ollama':
      return callOllamaLocal(params);

    case 'surplus':
    case 'groq':
    default:
      return callGroqDirect({
        prompt: params.prompt,
        system: params.system,
        modelSize: 'large',
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        trajectoryLogger: params.trajectoryLogger,
        trajectoryId: params.trajectoryId,
        purpose: params.purpose,
        actionType: params.actionType,
        runtime: params.runtime,
      });
  }
}

/**
 * Checks the configured LLM provider status and availability
 *
 * Performs health checks for the configured provider and returns detailed status information.
 *
 * @returns Provider status including configuration state, availability, and details
 *
 * @example
 * ```typescript
 * const status = await getAgentLLMStatus();
 * console.log(`Provider: ${status.provider}, Available: ${status.available}`);
 * ```
 */
export async function getAgentLLMStatus(): Promise<{
  provider: AgentLLMProvider;
  configured: boolean;
  available: boolean;
  details: Record<string, string | boolean>;
  model?: string;
  error?: string;
}> {
  const provider = getConfiguredProvider();
  const details: Record<string, string | boolean> = {};

  const surplus = getSurplusConfig();
  if (provider === 'surplus' && surplus) {
    return {
      provider,
      configured: true,
      available: true,
      model: surplus.model,
      details: { hasApiKey: true, endpoint: surplus.baseURL },
    };
  }

  let configured = false;
  let available = false;

  switch (provider) {
    case 'huggingface':
      configured =
        !!process.env.HUGGINGFACE_API_KEY &&
        !!process.env.HUGGINGFACE_MODEL_ENDPOINT;
      details.hasApiKey = !!process.env.HUGGINGFACE_API_KEY;
      details.endpoint = process.env.HUGGINGFACE_MODEL_ENDPOINT || 'not set';
      if (configured) {
        try {
          const response = await fetch(
            process.env.HUGGINGFACE_MODEL_ENDPOINT!,
            {
              method: 'HEAD',
              headers: {
                Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
              },
              signal: AbortSignal.timeout(5000),
            }
          );
          available = response.ok || response.status === 405;
        } catch (error) {
          available = false;
          details.healthcheck = 'unreachable';
          return {
            provider,
            configured,
            available,
            details,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      break;

    case 'phala':
      configured = !!process.env.PHALA_ENDPOINT;
      details.endpoint = process.env.PHALA_ENDPOINT || 'not set';
      if (configured) {
        try {
          const response = await fetch(`${process.env.PHALA_ENDPOINT}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          available = response.ok;
        } catch (error) {
          available = false;
          details.healthcheck = 'unreachable';
          return {
            provider,
            configured,
            available,
            details,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      break;

    case 'ollama':
      const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      configured = true;
      details.endpoint = ollamaUrl;
      try {
        const response = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(5000),
        });
        available = response.ok;
        if (available) {
          const data = (await response.json()) as {
            models?: Array<{ name: string }>;
          };
          details.models = (data.models?.length || 0).toString();
        }
      } catch {
        available = false;
      }
      break;

    case 'groq':
    default:
      configured = !!process.env.GROQ_API_KEY;
      details.hasApiKey = !!process.env.GROQ_API_KEY;
      available = configured;
      break;
  }

  return { provider, configured, available, details };
}
