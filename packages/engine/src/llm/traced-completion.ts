import type OpenAI from 'openai';
import { getLLMCallCallback } from '../dag-trace/llm-interceptor';

/** Instrument raw text helpers that do not use FeedLLMClient's parser. */
export async function tracedCompletion(
  client: OpenAI,
  provider: string,
  promptType: string,
  params: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature: number;
    max_tokens: number;
    reasoning_effort?: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming['reasoning_effort'];
  }
) {
  const started = Date.now();
  const base = {
    provider,
    promptType,
    model: params.model,
    format: 'text' as const,
    temperature: params.temperature,
    maxTokens: params.max_tokens,
    messages: params.messages,
    systemPrompt: params.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n'),
    userPrompt: params.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n'),
    parsedResponse: null,
  };
  const response = await client.chat.completions
    .create({
      ...params,
      ...(params.model.includes('qwen3') &&
      params.reasoning_effort === undefined
        ? { reasoning_effort: 'none' as const }
        : {}),
    })
    .catch((error: Error) => {
      getLLMCallCallback()?.({
        ...base,
        rawResponse: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs: Date.now() - started,
        success: false,
        error: error.message,
      });
      throw error;
    });
  const content = response.choices[0]?.message?.content ?? '';
  getLLMCallCallback()?.({
    ...base,
    rawResponse: content,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? 0,
    durationMs: Date.now() - started,
    success: !!content.trim(),
    ...(!content.trim() ? { error: 'LLM returned empty content' } : {}),
  });
  if (!content.trim())
    throw new Error(`${promptType}: LLM returned empty content`);
  return response;
}
