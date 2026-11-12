import OpenAI from 'openai';
import { getSurplusConfig } from '../../packages/shared/src/utils/surplus';

const provider = 'surplus';
const requestedModel = 'venice-embed-1';
const baseURL = 'https://api.surplusintelligence.ai/v1';
const started = performance.now();
const outcome: { httpStatus: number | null } = { httpStatus: null };
let requests = 0;
let failed = false;

try {
  const surplus = getSurplusConfig();
  if (
    !surplus ||
    surplus.baseURL !== baseURL ||
    process.env.SURPLUS_EMBEDDING_MODEL !== requestedModel
  ) {
    throw new Error(
      'Required diagnostic configuration is missing or unexpected'
    );
  }

  const signal = AbortSignal.timeout(30_000);
  const client = new OpenAI({
    apiKey: surplus.apiKey,
    baseURL: surplus.baseURL,
    timeout: 30_000,
    maxRetries: 0,
    logLevel: 'off',
    fetch: async (url, init) => {
      requests++;
      if (requests !== 1) {
        throw new Error('Diagnostic permits exactly one request');
      }
      const response = await fetch(url, { ...init, redirect: 'error' });
      outcome.httpStatus = response.status;
      return response;
    },
  });
  const response = await client.embeddings.create(
    { model: requestedModel, input: 'Feed CI embedding check.' },
    { signal }
  );
  const embedding = response.data[0]?.embedding;
  if (
    requests !== 1 ||
    outcome.httpStatus !== 200 ||
    !Array.isArray(embedding) ||
    embedding.length === 0 ||
    !embedding.every(Number.isFinite)
  ) {
    throw new Error('Diagnostic response is not a finite numeric embedding');
  }
} catch {
  // This CI process boundary never prints SDK errors, headers or response bodies.
  failed = true;
} finally {
  console.info(
    JSON.stringify({
      provider,
      requestedModel,
      httpStatus: outcome.httpStatus,
      elapsedMs: Math.round(performance.now() - started),
    })
  );
}

if (failed) process.exitCode = 1;
