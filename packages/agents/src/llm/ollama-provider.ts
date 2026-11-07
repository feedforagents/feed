/**
 * Ollama Provider for Local Model Inference
 *
 * Provides local LLM inference using Ollama, supporting base models, fine-tuned models
 * with LoRA adapters, and archetype-specific model routing for RL training workflows.
 *
 * @remarks
 * Supports the closed-loop RL training process:
 * 1. Agents generate trajectory data using current models
 * 2. Training pipeline trains new models on trajectory data
 * 3. Trained models are benchmarked and exported to Ollama
 * 4. Agents use new models to generate improved trajectory data
 * 5. Process repeats with continuous model improvement
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
import { buildReasoningTraceMetadata } from './reasoning-trace';

/**
 * Ollama model metadata from API
 * @internal
 */
interface OllamaModelInfo {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

/**
 * Ollama API list models response
 * @internal
 */
interface OllamaListResponse {
  models: OllamaModelInfo[];
}

/**
 * Mapping of agent archetypes to their trained Ollama model names
 * Updated when new models are trained, benchmarked, and deployed
 */
const ARCHETYPE_MODELS: Readonly<Record<string, string>> = {
  trader: 'feed-trader:latest',
  'social-butterfly': 'feed-social:latest',
  scammer: 'feed-scammer:latest',
  degen: 'feed-degen:latest',
  'information-trader': 'feed-info-trader:latest',
  researcher: 'feed-researcher:latest',
  'goody-twoshoes': 'feed-goody:latest',
  'ass-kisser': 'feed-asskisser:latest',
  'perps-trader': 'feed-perps:latest',
  'super-predictor': 'feed-predictor:latest',
  infosec: 'feed-infosec:latest',
  liar: 'feed-liar:latest',
};

// Default fallback model
const DEFAULT_MODEL = 'qwen2.5:7b-instruct';

function getConfiguredDefaultModel(): string | undefined {
  return process.env.OLLAMA_MODEL;
}

// Ollama configuration
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

export interface OllamaCallParams {
  prompt: string;
  system?: string;
  archetype?: string;
  modelOverride?: string;
  temperature?: number;
  maxTokens?: number;
  trajectoryLogger?: RuntimeTrajectoryLogger;
  trajectoryId?: string;
  purpose?: 'action' | 'reasoning' | 'evaluation' | 'response' | 'other';
  actionType?: string;
  runtime?: IAgentRuntime;
}

/**
 * List available Ollama models
 */
export async function listOllamaModels(): Promise<OllamaModelInfo[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status}`);
  }

  const data = (await response.json()) as Partial<OllamaListResponse> | null;
  if (!data || !Array.isArray(data.models)) {
    throw new Error('Ollama /api/tags returned an unexpected response shape');
  }
  return data.models;
}

/**
 * Check if a specific model is available in Ollama
 */
export async function isModelAvailable(modelName: string): Promise<boolean> {
  const models = await listOllamaModels();
  return models.some(
    (m) =>
      m.name === modelName ||
      (!modelName.includes(':') && m.name === `${modelName}:latest`)
  );
}

/**
 * Get the best available model for an archetype
 */
export async function getModelForArchetype(archetype: string): Promise<string> {
  const configuredDefaultModel = getConfiguredDefaultModel();

  const model =
    ARCHETYPE_MODELS[archetype] || configuredDefaultModel || DEFAULT_MODEL;
  if (!(await isModelAvailable(model))) {
    throw new Error(`Required Ollama model is unavailable: ${model}`);
  }
  return model;
}

/**
 * Call Ollama for local LLM inference
 *
 * Supports archetype-specific model routing and automatic trajectory logging
 */
export async function callOllama(params: OllamaCallParams): Promise<string> {
  if (typeof params.prompt !== 'string' || !params.prompt.trim())
    throw new Error('Agent LLM prompt is required');
  // Auto-extract trajectory context from runtime if not explicitly provided
  let trajectoryLogger = params.trajectoryLogger;
  let trajectoryId = params.trajectoryId;

  if (!trajectoryLogger && !trajectoryId && params.runtime) {
    const context = getTrajectoryContext(params.runtime);
    if (context) {
      trajectoryLogger = context.logger;
      trajectoryId = context.trajectoryId;
    }
  }

  // Determine which model to use
  let model: string;
  const configuredDefaultModel = getConfiguredDefaultModel();
  if (params.modelOverride) {
    model = params.modelOverride;
  } else if (params.archetype) {
    model = await getModelForArchetype(params.archetype);
  } else if (configuredDefaultModel) {
    model = configuredDefaultModel;
  } else {
    model = DEFAULT_MODEL;
  }

  // Capture the trajectory step before the request so a concurrent step
  // change cannot attach this result to the wrong step.
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

  // Build messages for chat format
  const messages: Array<{ role: string; content: string }> = [];

  if (params.system) {
    messages.push({ role: 'system', content: params.system });
  }

  messages.push({ role: 'user', content: params.prompt });

  const callMetadata = {
    provider: 'ollama',
    model,
    promptType: params.actionType || params.purpose || 'agent-ollama',
    format: 'text',
    temperature: params.temperature ?? 0.7,
    maxTokens: params.maxTokens ?? 8192,
    systemPrompt: params.system || '',
    userPrompt: params.prompt,
  };
  let responseText: string;
  let data: {
    message?: { content?: unknown };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  // Provider-reported counts from a parsed response, captured as soon as the
  // body is parsed so a content-validation failure below still reports the
  // usage Ollama already returned. Stays undefined when no response was
  // parsed (transport failure), which records zero usage.
  let parsedUsage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    // Call Ollama chat API
    const timeoutMs =
      params.maxTokens && params.maxTokens < 500 ? 30000 : 120000;

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: params.temperature ?? 0.7,
          num_predict: params.maxTokens ?? 8192,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
    }

    data = (await response.json()) as typeof data;
    parsedUsage = {
      inputTokens: data?.prompt_eval_count ?? 0,
      outputTokens: data?.eval_count ?? 0,
    };

    const content = data?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Ollama /api/chat response is missing message.content');
    }
    responseText = content;
    if (!responseText.trim()) throw new Error('Ollama returned empty content');
  } catch (error) {
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
        promptTokens: parsedUsage?.inputTokens,
        completionTokens: parsedUsage?.outputTokens,
        metadata: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    getAgentLLMBridge()?.({
      ...callMetadata,
      rawResponse: '',
      inputTokens: parsedUsage?.inputTokens ?? 0,
      outputTokens: parsedUsage?.outputTokens ?? 0,
      durationMs: Date.now() - startTime,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const latencyMs = Date.now() - startTime;
  getAgentLLMBridge()?.({
    ...callMetadata,
    rawResponse: responseText,
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    durationMs: latencyMs,
    success: true,
  });

  if (trajectoryLogger && trajectoryId && stepId) {
    const reasoningMetadata = buildReasoningTraceMetadata(responseText);
    trajectoryLogger.logLLMCall(stepId, {
      model,
      systemPrompt: params.system || '',
      userPrompt: params.prompt,
      response: responseText,
      temperature: params.temperature ?? 0.7,
      maxTokens: params.maxTokens ?? 8192,
      purpose: params.purpose || 'action',
      actionType: params.actionType,
      latencyMs,
      promptTokens: data.prompt_eval_count,
      completionTokens: data.eval_count,
      ...reasoningMetadata,
    });
  }

  logger.debug(
    'Ollama call complete',
    {
      model,
      archetype: params.archetype,
      latencyMs,
      responseLength: responseText.length,
    },
    'OllamaProvider'
  );

  return responseText;
}
