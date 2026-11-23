/**
 * Embedding Client
 *
 * Thin wrapper around OpenAI's text-embedding-3-small for semantic similarity.
 * Used by ContentQualityGate (parody validation) and WorldFactsConsolidator
 * (fact clustering). Separate from FeedLLMClient because embeddings are
 * OpenAI-only — the Groq/Claude fallback chain doesn't apply.
 *
 * Gracefully degrades: returns null when OPENAI_API_KEY is missing, so callers
 * can skip embedding-based checks without crashing the pipeline.
 */

import { scheduledInferenceFetch } from '@feed/db';
import { getSurplusConfig, logger } from '@feed/shared';
import OpenAI from 'openai';

const EMBEDDING_MODEL = process.env.SURPLUS_API_KEY
  ? process.env.SURPLUS_EMBEDDING_MODEL
  : 'text-embedding-3-small';
const MAX_BATCH_SIZE = 100;

let openaiClient: OpenAI | null = null;
let initialized = false;

/**
 * Lazily initialize the OpenAI-compatible client for embeddings.
 * Prefers ELIZACLOUD_API_KEY, falls back to OPENAI_API_KEY.
 * Returns null if neither key is set.
 */
function getClient(): OpenAI | null {
  if (initialized) return openaiClient;
  initialized = true;

  const surplus = getSurplusConfig();
  if (surplus) {
    if (!EMBEDDING_MODEL) {
      logger.warn(
        'SURPLUS_EMBEDDING_MODEL is required for embedding quality checks',
        undefined,
        'EmbeddingClient'
      );
      return null;
    }
    openaiClient = new OpenAI({
      apiKey: surplus.apiKey,
      baseURL: surplus.baseURL,
      fetch: scheduledInferenceFetch,
      timeout: 30_000,
      maxRetries: 2,
    });
    return openaiClient;
  }
  const elizacloudKey = process.env.ELIZACLOUD_API_KEY;
  if (elizacloudKey) {
    const base =
      process.env.ELIZACLOUD_API_URL?.replace(/\/$/, '') ||
      'https://api.elizacloud.com';
    logger.debug(
      'EmbeddingClient using ElizaCloud',
      { baseURL: `${base}/openai/v1` },
      'EmbeddingClient'
    );
    openaiClient = new OpenAI({
      apiKey: elizacloudKey,
      baseURL: `${base}/openai/v1`,
      timeout: 30_000,
      maxRetries: 2,
    });
    return openaiClient;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    logger.warn(
      'Neither ELIZACLOUD_API_KEY nor OPENAI_API_KEY set — embedding-based quality checks will be skipped',
      undefined,
      'EmbeddingClient'
    );
    return null;
  }

  openaiClient = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 2 });
  return openaiClient;
}

/**
 * Get the embedding vector for a single text.
 * Returns null if the API key is missing or the call fails.
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  const client = getClient();
  if (!client || !EMBEDDING_MODEL) return null;

  const startTime = Date.now();
  try {
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    const latencyMs = Date.now() - startTime;
    logger.debug(
      'Embedding request completed',
      { latencyMs, textLength: text.length },
      'EmbeddingClient'
    );
    return response.data[0]?.embedding ?? null;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    logger.error(
      'Embedding request failed',
      {
        error: error instanceof Error ? error.message : String(error),
        latencyMs,
      },
      'EmbeddingClient'
    );
    return null;
  }
}

/**
 * Get embeddings for multiple texts in a single batch call.
 * Returns an array aligned with the input — null entries for failures.
 */
export async function getEmbeddings(
  texts: string[]
): Promise<(number[] | null)[]> {
  const client = getClient();
  if (!client || !EMBEDDING_MODEL) return texts.map(() => null);

  if (texts.length === 0) return [];

  // OpenAI supports batching up to ~2048 inputs per call,
  // but we cap at MAX_BATCH_SIZE for memory safety.
  const results: (number[] | null)[] = texts.map(() => null);

  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchStartTime = Date.now();
    try {
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch,
      });
      const latencyMs = Date.now() - batchStartTime;
      logger.debug(
        'Batch embedding request completed',
        { latencyMs, batchSize: batch.length, batchOffset: i },
        'EmbeddingClient'
      );

      // Place each vector at its declared index so a missing or reordered
      // entry can never shift later embeddings onto the wrong text.
      let placed = 0;
      for (const item of response.data) {
        if (
          Number.isInteger(item.index) &&
          item.index >= 0 &&
          item.index < batch.length &&
          Array.isArray(item.embedding)
        ) {
          results[i + item.index] = item.embedding;
          placed++;
        }
      }
      if (placed !== batch.length) {
        logger.warn(
          'Batch embedding response missing entries',
          { expected: batch.length, received: placed, batchOffset: i },
          'EmbeddingClient'
        );
      }
    } catch (error) {
      const latencyMs = Date.now() - batchStartTime;
      logger.error(
        'Batch embedding request failed',
        {
          error: error instanceof Error ? error.message : String(error),
          latencyMs,
          batchOffset: i,
          batchSize: batch.length,
          totalTexts: texts.length,
        },
        'EmbeddingClient'
      );
      // Failed batch entries remain null; earlier successful results are kept
    }
  }

  return results;
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value in [-1, 1] where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dot / denominator;
}
