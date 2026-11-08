/**
 * LLM Client for Feed Game Generation
 * Supports multiple providers with intelligent fallback
 * Priority: Groq > Claude > OpenAI
 */

import OpenAI from 'openai';
import 'dotenv/config';
import { getSurplusConfig, logger } from '@feed/shared';
import type { JsonValue } from '../types/common';
import type { LLMCallTokenUsage } from '../types/token-stats';
import { first } from '../utils/array-utils';
import { isPromptLoggingEnabled, logPrompt } from '../utils/prompt-logger';
import {
  cleanMarkdownCodeBlocks,
  extractJsonFromText,
} from './json-continuation-parser';
import type { LLMJsonSchema as JSONSchema } from './types';
import { cleanXMLMarkdown, extractXMLFromText, parseXML } from './xml-parser';

type LLMProvider = 'surplus' | 'elizacloud' | 'groq' | 'claude' | 'openai';
type LLMDisabledContext = 'default' | 'gameTick';
type StructuredOutput = Record<string, JsonValue> | JsonValue[];

class StructuredOutputError extends Error {}

function requireStructuredOutput(value: JsonValue): StructuredOutput {
  if (value === null || typeof value !== 'object') {
    throw new StructuredOutputError('Response must be a JSON object or array');
  }
  return value;
}

function parseStructuredJSON(content: string): StructuredOutput {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new StructuredOutputError(`Failed to parse JSON: ${error.message}`);
  }
  return requireStructuredOutput(parsed);
}

/**
 * Token usage callback function type
 * Called after each LLM call with usage statistics
 */
export type TokenUsageCallback = (
  usage: Omit<LLMCallTokenUsage, 'callId' | 'timestamp'>
) => void;

// Global token usage callback (can be set by TokenStatsService)
let globalTokenUsageCallback: TokenUsageCallback | null = null;

// Global LLM call detail callback (can be set by DAG trace interceptor)
import { getLLMCallCallback } from '../dag-trace/llm-interceptor';
import type { LLMCallInput } from '../dag-trace/types';

/**
 * Set the global token usage callback
 * Used by TokenStatsService to collect usage across all LLM calls
 */
export function setTokenUsageCallback(
  callback: TokenUsageCallback | null
): void {
  globalTokenUsageCallback = callback;
}

/**
 * Get the current token usage callback
 */
export function getTokenUsageCallback(): TokenUsageCallback | null {
  return globalTokenUsageCallback;
}

function resolveElizaCloudConfig():
  | { apiKey: string; baseURL: string }
  | undefined {
  const apiKey = process.env.ELIZACLOUD_API_KEY;
  if (!apiKey) return undefined;
  const base =
    process.env.ELIZACLOUD_API_URL?.replace(/\/$/, '') ||
    'https://elizacloud.ai';
  // ElizaCloud uses /api/v1 (OpenAI-compatible); the SDK appends /chat/completions
  return { apiKey, baseURL: `${base}/api/v1` };
}

function resolveGroqBaseURL(): string {
  return process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
}

function resolveGroqDefaultModel(): string {
  return (
    process.env.MARKET_DECISION_MODEL ||
    process.env.GROQ_PRIMARY_MODEL ||
    process.env.GROQ_LARGE_MODEL ||
    'openai/gpt-oss-120b'
  );
}

/**
 * Simple JSON schema for validation
 */
// NOTE: Schema types are shared via ./types to avoid duplicating shapes across the engine.

export class FeedLLMClient {
  private client: OpenAI | null = null;
  private provider: LLMProvider = 'openai';
  private groqKey: string | undefined;
  private claudeKey: string | undefined;
  private openaiKey: string | undefined;
  private missingKeyContext: LLMDisabledContext = 'default';

  /**
   * Create a FeedLLMClient configured to use ElizaCloud (Priority #1)
   */
  static forElizaCloud(): FeedLLMClient {
    return new FeedLLMClient('', 'elizacloud');
  }

  /**
   * Create a FeedLLMClient configured to use Groq provider (Priority #2)
   * This is a convenience factory method for forcing Groq without passing undefined parameters
   */
  static forGroq(): FeedLLMClient {
    return new FeedLLMClient('', 'groq');
  }

  /**
   * Create a FeedLLMClient configured to use Anthropic/Claude provider (Priority #3)
   * This is a convenience factory method for forcing Claude without passing undefined parameters
   */
  static forClaude(): FeedLLMClient {
    return new FeedLLMClient('', 'claude');
  }

  /**
   * Create a FeedLLMClient configured to use OpenAI provider (Priority #4 - fallback)
   * This is a convenience factory method for forcing OpenAI without passing undefined parameters
   */
  static forOpenAI(apiKey?: string): FeedLLMClient {
    return new FeedLLMClient(apiKey || '', 'openai');
  }

  /**
   * Create a FeedLLMClient for game tick operations
   * Priority: ElizaCloud > Groq > Claude > OpenAI
   */
  static forGameTick(): FeedLLMClient {
    return new FeedLLMClient('', undefined, 'gameTick');
  }

  constructor(
    apiKey?: string,
    forceProvider?: LLMProvider,
    missingKeyContext: LLMDisabledContext = 'default'
  ) {
    this.missingKeyContext = missingKeyContext;

    // Priority: ElizaCloud > Groq > Claude > OpenAI (unless forceProvider is set)
    const elizaCloud = resolveElizaCloudConfig();
    this.groqKey = process.env.GROQ_API_KEY;
    this.claudeKey = process.env.ANTHROPIC_API_KEY;
    this.openaiKey = apiKey || process.env.OPENAI_API_KEY;

    // Surplus overrides every provider selection below, so a forced provider
    // only needs its own credentials when Surplus is not configured.
    if (forceProvider && !getSurplusConfig()) {
      const available: Record<LLMProvider, string | undefined> = {
        surplus: undefined,
        elizacloud: elizaCloud?.apiKey,
        groq: this.groqKey,
        claude: this.claudeKey,
        openai: this.openaiKey,
      };
      if (!available[forceProvider]) {
        throw new Error(
          `Required credentials missing for selected provider ${forceProvider}`
        );
      }
    }

    // Timeout and retry configuration
    // For large batch operations (like NPC trading), we need longer timeouts
    // since Groq can take 30-60 seconds for complex prompts
    const isTestEnv =
      process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';
    // Test: 120 seconds (2 min) to allow for large batch operations
    // Production: 300 seconds (5 minutes) for safety
    const timeoutMs = isTestEnv ? 120000 : 300000;
    // Let SDK handle initial retries for transient errors
    // We also do our own retries in generateJSON for more control
    const sdkMaxRetries = 0; // Retries below are explicit and each attempt is traced.

    // Force specific provider if requested
    const surplus = getSurplusConfig();
    if (surplus) {
      this.client = new OpenAI({
        apiKey: surplus.apiKey,
        baseURL: surplus.baseURL,
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'surplus';
    } else if (forceProvider === 'elizacloud' && elizaCloud) {
      logger.info('Using ElizaCloud (forced)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: elizaCloud.apiKey,
        baseURL: elizaCloud.baseURL,
        defaultHeaders: { 'X-API-Key': elizaCloud.apiKey },
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'elizacloud';
    } else if (forceProvider === 'groq' && this.groqKey) {
      logger.info('Using Groq (forced)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: this.groqKey,
        baseURL: resolveGroqBaseURL(),
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'groq';
    } else if (forceProvider === 'claude' && this.claudeKey) {
      logger.info('Using Claude (forced)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: this.claudeKey,
        baseURL: 'https://api.anthropic.com/v1',
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'claude';
    } else if (forceProvider === 'openai' && this.openaiKey) {
      logger.info('Using OpenAI (forced)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: this.openaiKey,
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'openai';
    } else if (elizaCloud) {
      logger.info(
        'Using ElizaCloud (unified inference)',
        undefined,
        'FeedLLMClient'
      );
      this.client = new OpenAI({
        apiKey: elizaCloud.apiKey,
        baseURL: elizaCloud.baseURL,
        defaultHeaders: { 'X-API-Key': elizaCloud.apiKey },
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'elizacloud';
    } else if (this.groqKey) {
      logger.info('Using Groq (fast inference)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: this.groqKey,
        baseURL: resolveGroqBaseURL(),
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'groq';
    } else if (this.claudeKey) {
      logger.info(
        'Using Claude via OpenAI-compatible API',
        undefined,
        'FeedLLMClient'
      );
      this.client = new OpenAI({
        apiKey: this.claudeKey,
        baseURL: 'https://api.anthropic.com/v1',
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'claude';
    } else if (this.openaiKey) {
      logger.info('Using OpenAI (fallback)', undefined, 'FeedLLMClient');
      this.client = new OpenAI({
        apiKey: this.openaiKey,
        timeout: timeoutMs,
        maxRetries: sdkMaxRetries,
      });
      this.provider = 'openai';
    } else {
      this.client = null;
      const suppressOptionalWarnings = ['1', 'true', 'yes'].includes(
        (process.env.FEED_SUPPRESS_OPTIONAL_LLM_WARNINGS || '')
          .trim()
          .toLowerCase()
      );
      if (!suppressOptionalWarnings) {
        logger.warn(
          'No LLM API key configured - FeedLLMClient is disabled',
          { missingKeyContext: this.missingKeyContext },
          'FeedLLMClient'
        );
      }
    }
  }

  private assertEnabled(): void {
    if (this.client) return;

    if (this.missingKeyContext === 'gameTick') {
      throw new Error(
        '❌ No API key found for game tick operations!\n' +
          '   Set one of these environment variables:\n' +
          '   - ELIZACLOUD_API_KEY (recommended — single key for all inference)\n' +
          '   - GROQ_API_KEY (direct Groq)\n' +
          '   - ANTHROPIC_API_KEY\n' +
          '   - OPENAI_API_KEY\n' +
          '   Example: export ELIZACLOUD_API_KEY=elc_...'
      );
    }

    throw new Error(
      '❌ No API key found!\n' +
        '   Set one of these environment variables (in priority order):\n' +
        '   - ELIZACLOUD_API_KEY (recommended — single key for all inference)\n' +
        '   - GROQ_API_KEY (direct Groq, fast inference)\n' +
        '   - ANTHROPIC_API_KEY (Claude)\n' +
        '   - OPENAI_API_KEY (fallback)\n' +
        '   Example: export ELIZACLOUD_API_KEY=elc_...'
    );
  }

  /**
   * Generate completion with structured response (XML or JSON)
   * ALWAYS retries on failure - never gives up without exhausting all retries
   * Defaults to XML for more robust parsing
   */
  async generateJSON<T>(
    prompt: string,
    schema?: JSONSchema,
    options: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
      format?: 'xml' | 'json';
      /** Prompt type identifier for logging and monitoring */
      promptType?: string;
      /** Prompt template for logging and monitoring */
      promptTemplate?: string;
    } = {}
  ): Promise<T> {
    this.assertEnabled();
    const defaultModel = this.getDefaultModel();

    const {
      model: requestedModel = defaultModel,
      temperature = 0.7,
      maxTokens: requestedMaxTokens = 32000,
      format = 'xml',
      promptType = 'unknown',
      promptTemplate,
    } = options;
    const model =
      this.provider === 'surplus' ? this.getDefaultModel() : requestedModel;
    const maxTokens =
      this.provider === 'surplus'
        ? Math.min(requestedMaxTokens, 16384)
        : requestedMaxTokens;

    // OpenAI can enforce JSON mode, but we default to XML for robustness
    const useJsonFormat =
      this.provider === 'openai' && format === 'json'
        ? { type: 'json_object' as const }
        : undefined;

    // Feed world context - pre-condition LLM to expect parody names
    const feedContext = `You are generating content for Feed, a satirical prediction market game.
WORLD RULES:
- Use ONLY parody names (e.g., "AIlon Musk" not "Elon Musk", "TeslAI" not "Tesla", "OpenAGI" not "OpenAI")
- NEVER use real-world person or organization names
- NO hashtags (#) in any content
- NO emojis in any content
- Each character has a UNIQUE voice - match their writing style exactly

`;

    const systemContent =
      format === 'xml'
        ? feedContext +
          'You are an XML-only assistant. CRITICAL INSTRUCTIONS:\n' +
          '1. Respond ONLY with valid XML - NO explanations, NO reasoning, NO markdown\n' +
          '2. Start your response IMMEDIATELY with < (the opening tag)\n' +
          '3. End your response with > (the closing tag)\n' +
          '4. Do NOT write "Okay, let\'s see" or any thinking process\n' +
          '5. Do NOT write "Here is the XML" or any preamble\n' +
          '6. Just output the pure XML structure directly\n' +
          'WRONG: "Okay, let\'s see. I need to..."\n' +
          'Match the requested XML root, field names and nesting.\n' +
          (schema
            ? `Use this schema for the XML child elements (nest object properties inside their parent tag): ${JSON.stringify(schema)}`
            : '')
        : feedContext +
          'You are a JSON-only assistant. You must respond ONLY with valid JSON. No explanations, no markdown, no other text.';

    const baseMessages = [
      {
        role: 'system' as const,
        content: systemContent,
      },
      {
        role: 'user' as const,
        content: prompt,
      },
    ];

    // Collect each API request, then publish its actual parsing outcome before
    // returning or throwing. Continuations retain separate raw request records.
    let attemptCalls: LLMCallInput[] = [];
    let completionTemperature = temperature;
    const requestCompletion = async (
      requestMessages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }>
    ) => {
      const started = Date.now();
      const metadata = {
        provider: this.provider,
        model,
        promptType,
        format,
        temperature: completionTemperature,
        maxTokens,
        systemPrompt: systemContent,
        userPrompt: requestMessages
          .filter((message) => message.role === 'user')
          .map((message) => message.content)
          .join('\n\n'),
        messages: requestMessages,
      };
      const response = await this.client!.chat.completions.create({
        model,
        messages: requestMessages,
        ...(useJsonFormat ? { response_format: useJsonFormat } : {}),
        temperature: completionTemperature,
        max_tokens: maxTokens,
        ...(model.includes('qwen3')
          ? { reasoning_effort: 'none' as const }
          : {}),
        ...(model.includes('gpt-5')
          ? { reasoning_effort: 'minimal' as const }
          : {}),
      }).catch((error: Error) => {
        attemptCalls.push({
          ...metadata,
          rawResponse: '',
          parsedResponse: null,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          durationMs: Date.now() - started,
          success: false,
          error: error.message,
        });
        throw error;
      });
      const content = response.choices[0]?.message.content ?? '';
      attemptCalls.push({
        ...metadata,
        rawResponse: content,
        parsedResponse: null,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens:
          response.usage?.total_tokens ??
          (response.usage?.prompt_tokens ?? 0) +
            (response.usage?.completion_tokens ?? 0),
        durationMs: Date.now() - started,
        success: Boolean(content.trim()),
        ...(content.trim() ? {} : { error: 'LLM response missing content' }),
      });
      return response;
    };

    let retryCount = 0;
    let validationFeedback: string | undefined;
    const maxRetries = 3;
    const initialDelayMs = 2000;
    let callStartTime = Date.now();

    while (true) {
      const messages = validationFeedback
        ? [
            ...baseMessages,
            { role: 'user' as const, content: validationFeedback },
          ]
        : baseMessages;
      attemptCalls = [];
      let parsedResponse: JsonValue | null = null;
      let outcomeError: string | undefined;
      let failedAttemptDurationMs: number | undefined;
      try {
        callStartTime = Date.now();
        const response = await requestCompletion(messages);
        const firstChoice = first(response.choices);
        if (!firstChoice || !firstChoice.message.content) {
          throw new StructuredOutputError('LLM response missing content');
        }
        let content = firstChoice.message.content;
        let finishReason = firstChoice.finish_reason;

        // Log prompt and response for monitoring
        const fullInput = `System: ${systemContent}\n\nUser: ${prompt}`;
        await this.logPromptDebug(fullInput, content, {
          promptType,
          promptTemplate,
          provider: this.provider,
          model,
          temperature: completionTemperature,
          maxTokens,
          format,
        });

        // Handle truncation by continuing generation (for models with 32k+ context)
        if (finishReason === 'length') {
          logger.warn(
            'Response truncated, attempting continuation',
            {
              model,
              tokensUsed: maxTokens,
            },
            'FeedLLMClient'
          );

          // Try to continue generation up to 2 more times
          let continuationAttempts = 0;
          const maxContinuations = 2;

          while (
            finishReason === 'length' &&
            continuationAttempts < maxContinuations
          ) {
            continuationAttempts++;

            // Create continuation prompt
            const continuationMessages = [
              ...messages,
              {
                role: 'assistant' as const,
                content: content,
              },
              {
                role: 'user' as const,
                content: `Continue exactly where you left off. Complete the remaining ${format.toUpperCase()} without repeating previous content.`,
              },
            ];

            logger.info(
              `Continuation attempt ${continuationAttempts}/${maxContinuations}`,
              {
                contentLength: content.length,
              },
              'FeedLLMClient'
            );

            const continuationResponse =
              await requestCompletion(continuationMessages);

            const contChoice = first(continuationResponse.choices);
            if (!contChoice || !contChoice.message.content) {
              throw new Error(
                'LLM continuation response missing choices or content - invalid API response'
              );
            }
            const continuationContent = contChoice.message.content;
            finishReason = contChoice.finish_reason ?? 'stop';

            // Append continuation to content
            content += continuationContent;

            if (finishReason !== 'length') {
              logger.info(
                'Continuation successful',
                {
                  attempts: continuationAttempts,
                  finalLength: content.length,
                },
                'FeedLLMClient'
              );
              break;
            }
          }

          // If still truncated after max continuations, throw error
          if (finishReason === 'length') {
            throw new StructuredOutputError(
              `Response truncated at ${maxTokens} tokens after ${continuationAttempts} continuation attempts.`
            );
          }
        }

        // Parse based on requested format
        if (format === 'xml') {
          const trimmed = content.trim();
          let parsed: StructuredOutput;
          let rootName: string | undefined;
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            parsed = parseStructuredJSON(trimmed);
          } else {
            const xmlResult = parseXML(content);
            if (!xmlResult.success) {
              throw new StructuredOutputError(
                `Failed to parse XML: ${xmlResult.error}`
              );
            }
            parsed =
              typeof xmlResult.data === 'string'
                ? parseStructuredJSON(xmlResult.data)
                : requireStructuredOutput(xmlResult.data);
            rootName = extractXMLFromText(cleanXMLMarkdown(content)).match(
              /^<([\w-]+)(?:\s|>)/
            )?.[1];
          }
          // XML parsing discards the root. Return whichever candidate actually
          // satisfies the caller's schema, restoring the root when necessary.
          const schemaAlternatives: StructuredOutput[] = [];
          const rootProjection = rootName ? { [rootName]: parsed } : undefined;
          if (rootProjection) schemaAlternatives.push(rootProjection);
          if (
            !Array.isArray(parsed) &&
            parsed.response !== null &&
            typeof parsed.response === 'object'
          ) {
            schemaAlternatives.push(parsed.response);
          }
          const matched = schema
            ? this.validateSchema(
                parsed,
                schema,
                schemaAlternatives,
                rootProjection && rootName
                  ? { candidate: rootProjection, field: rootName }
                  : undefined
              )
            : parsed;
          if (!matched) {
            throw new StructuredOutputError(
              `Response does not match schema. Missing required fields: ${schema?.required?.join(', ')}`
            );
          }

          logger.debug(
            'Successfully parsed XML response',
            {
              hasData: true,
              isArray: Array.isArray(matched),
            },
            'FeedLLMClient'
          );

          // Log and trace the same normalized value returned to the caller.
          await this.logParsedOutput(matched, promptType);

          parsedResponse = matched;
          return matched as T;
        }
        // JSON format
        let jsonContent = cleanMarkdownCodeBlocks(content);
        jsonContent = extractJsonFromText(jsonContent);

        const parsed = parseStructuredJSON(jsonContent);

        if (schema && !this.validateSchema(parsed, schema)) {
          throw new StructuredOutputError(
            `Response does not match schema. Missing required fields: ${schema.required?.join(', ')}`
          );
        }

        // Log parsed output for monitoring
        await this.logParsedOutput(parsed, promptType);

        parsedResponse = parsed;
        return parsed as T;
      } catch (error: unknown) {
        failedAttemptDurationMs = Date.now() - callStartTime;
        outcomeError = error instanceof Error ? error.message : String(error);
        const err = error as {
          status?: number;
          message?: string;
          headers?: Headers;
        };
        const isTestEnv =
          process.env.NODE_ENV === 'test' || process.env.BUN_ENV === 'test';

        if (error instanceof StructuredOutputError && retryCount < maxRetries) {
          retryCount++;
          completionTemperature = 0;
          validationFeedback =
            format === 'xml'
              ? `Your previous response was invalid: ${error.message}. Return the complete requested XML structure, including every required field. Copy the field names exactly and close each tag with the identical name. No explanations, markdown, or truncated tags.`
              : `Your previous response was invalid: ${error.message}. Return a complete JSON object or array matching the requested schema. No explanations, markdown, or truncated values.`;
          logger.warn(
            'Invalid structured response, retrying',
            { attempt: retryCount, maxRetries, format },
            'FeedLLMClient'
          );
          continue;
        }

        // Handle 429 rate limit errors
        const isRateLimitError =
          err?.status === 429 ||
          err?.message?.includes('429') ||
          err?.message?.includes('rate_limit');

        if (isRateLimitError) {
          // Retry with backoff in both test and production environments
          // Tests need to be robust to rate limits too
          if (retryCount < maxRetries) {
            retryCount++;

            // Try to get retry-after from headers, default to exponential backoff
            let delay = initialDelayMs * 2 ** (retryCount - 1);

            // Check for retry-after header
            const retryAfter = err.headers?.get?.('retry-after');
            if (retryAfter) {
              const retryAfterSeconds = Number.parseInt(retryAfter, 10);
              if (!isNaN(retryAfterSeconds)) {
                delay = (retryAfterSeconds + 1) * 1000; // Add 1 second buffer
              }
            }

            // Cap at 30 seconds for rate limits (shorter in tests for faster feedback)
            const maxDelay = isTestEnv ? 10000 : 30000;
            delay = Math.min(delay, maxDelay);

            logger.warn(
              `Rate limit hit (429), retrying in ${delay}ms...`,
              {
                attempt: retryCount,
                maxRetries,
                retryAfterHeader: retryAfter || 'not provided',
                delay,
                isTestEnv,
              },
              'FeedLLMClient'
            );

            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }

        // Handle 502/503/504 service errors with exponential backoff
        if (
          retryCount < maxRetries &&
          (err?.status === 502 ||
            err?.status === 503 ||
            err?.status === 504 ||
            err?.message?.includes('502') ||
            err?.message?.includes('503') ||
            err?.message?.includes('service_unavailable'))
        ) {
          retryCount++;
          const delay = initialDelayMs * 2 ** (retryCount - 1);

          logger.warn(
            `LLM Service Error (${err.status || 'unknown'}), retrying in ${delay}ms...`,
            {
              attempt: retryCount,
              maxRetries,
              error: err.message,
            },
            'FeedLLMClient'
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Handle timeout errors with exponential backoff
        const isTimeoutError =
          err?.message?.includes('timed out') ||
          err?.message?.includes('timeout') ||
          err?.message?.includes('ETIMEDOUT') ||
          err?.message?.includes('ECONNRESET') ||
          err?.message?.includes('APIConnectionTimeoutError');

        if (isTimeoutError && retryCount < maxRetries) {
          retryCount++;
          // Longer backoff for timeouts since the server is overloaded
          const delay = Math.min(initialDelayMs * 3 ** (retryCount - 1), 60000);

          logger.warn(
            `LLM request timed out, retrying in ${delay}ms...`,
            {
              attempt: retryCount,
              maxRetries,
              error: err.message,
            },
            'FeedLLMClient'
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Re-throw if not a retryable error or retries exhausted
        throw error;
      } finally {
        // Publish every attempt, including retries that already consumed tokens.
        // Continuations belong to the same attempt and must be counted once.
        globalTokenUsageCallback?.({
          provider: this.provider,
          model,
          inputTokens: attemptCalls.reduce(
            (sum, call) => sum + call.inputTokens,
            0
          ),
          outputTokens: attemptCalls.reduce(
            (sum, call) => sum + call.outputTokens,
            0
          ),
          totalTokens: attemptCalls.reduce(
            (sum, call) => sum + call.totalTokens,
            0
          ),
          promptType,
          durationMs: failedAttemptDurationMs ?? Date.now() - callStartTime,
          success: outcomeError === undefined,
          ...(outcomeError === undefined ? {} : { error: outcomeError }),
        });
        for (const call of attemptCalls) {
          getLLMCallCallback()?.({
            ...call,
            parsedResponse,
            success: call.success && outcomeError === undefined,
            ...(outcomeError === undefined ? {} : { error: outcomeError }),
          });
        }
      }
    }
  }

  /**
   * Log parsed output for monitoring and analysis
   */
  private async logParsedOutput(
    data: JsonValue,
    promptType: string
  ): Promise<void> {
    if (!isPromptLoggingEnabled()) {
      return;
    }

    // Parsed output is logged via the main flow
    // This provides additional structured data for monitoring
    logger.debug(
      'Parsed LLM output',
      {
        promptType,
        dataType: Array.isArray(data) ? 'array' : typeof data,
      },
      'FeedLLMClient'
    );
  }

  /**
   * Log prompt and response for monitoring and analysis
   */
  private async logPromptDebug(
    input: string,
    output: string,
    metadata: {
      promptType?: string;
      promptTemplate?: string;
      provider?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      format?: string;
    }
  ): Promise<void> {
    if (!isPromptLoggingEnabled()) {
      return;
    }

    await logPrompt({
      promptType: metadata.promptType || 'unknown',
      promptTemplate: metadata.promptTemplate,
      input,
      output,
      metadata: {
        provider: metadata.provider,
        model: metadata.model,
        temperature: metadata.temperature,
        maxTokens: metadata.maxTokens,
        format: metadata.format,
      },
    });
  }

  /**
   * Simple schema validation
   */
  private validateSchema(
    data: StructuredOutput,
    schema: JSONSchema,
    alternatives: StructuredOutput[] = [],
    rootProjection?: { candidate: StructuredOutput; field: string }
  ): StructuredOutput | null {
    const required = schema.required;
    const candidates = [data, ...alternatives].filter(
      (candidate) => !required || required.every((field) => field in candidate)
    );
    if (candidates.length === 0) {
      logger.error(
        `Missing required fields: ${required?.join(', ')}`,
        undefined,
        'FeedLLMClient'
      );
      return null;
    }
    const patternedFields = Object.entries(schema.properties ?? {}).filter(
      ([, property]) => property.pattern !== undefined
    );
    const firstViolation = (
      candidate: StructuredOutput
    ): string | undefined => {
      if (candidate === rootProjection?.candidate) {
        const field = rootProjection.field;
        const expected = schema.properties?.[field]?.type;
        const value = (candidate as Record<string, JsonValue>)[field];
        const valid =
          expected === undefined ||
          (expected === 'array'
            ? Array.isArray(value)
            : expected === 'object'
              ? value !== null &&
                typeof value === 'object' &&
                !Array.isArray(value)
              : typeof value === expected);
        if (!valid) return `Field "${field}" must have type ${expected}`;
      }
      const invalidPattern = patternedFields.find(([field, property]) => {
        if (!(field in candidate)) return false;
        const value = (candidate as Record<string, JsonValue>)[field];
        return (
          typeof value !== 'string' ||
          !new RegExp(property.pattern!).test(value)
        );
      });
      return invalidPattern
        ? `Field "${invalidPattern[0]}" must be a string matching pattern ${JSON.stringify(invalidPattern[1].pattern)}`
        : undefined;
    };
    const matched = candidates.find(
      (candidate) => firstViolation(candidate) === undefined
    );
    if (!matched)
      throw new StructuredOutputError(firstViolation(candidates[0]!)!);
    return matched;
  }

  /**
   * Get the default model for the current provider
   */
  private getDefaultModel(): string {
    switch (this.provider) {
      case 'surplus':
        return getSurplusConfig()?.model || 'gpt-4o-mini';
      case 'groq':
        return resolveGroqDefaultModel();
      case 'claude':
        return 'claude-sonnet-4-5';
      case 'openai':
        return 'gpt-5-nano';
      case 'elizacloud':
        // ElizaCloud uses provider-prefixed model IDs (openai/*, anthropic/*, etc.)
        // Allow override via env; default to gpt-5-nano with reasoning_effort=minimal.
        return process.env.ELIZACLOUD_DEFAULT_MODEL || 'openai/gpt-5-nano';
      default:
        return 'gpt-5-nano';
    }
  }

  /**
   * Get current provider information
   */
  getProvider(): LLMProvider {
    return this.provider;
  }

  /** Provider and default model. Usage totals are reported via the token usage callback. */
  getStats(): { provider: LLMProvider; model: string } {
    return {
      provider: this.provider,
      model: this.getDefaultModel(),
    };
  }
}
