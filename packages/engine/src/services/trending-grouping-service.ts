import { scheduledInferenceFetch } from '@feed/db';
import { getSurplusConfig } from '@feed/shared';
/**
 * Trending Grouping Service
 *
 * @description Uses LLM to intelligently group related trending tags together.
 * For example, "OpenAGI", "Sam AIltman", and "SMH-9000" become a single grouped trend.
 * Generates summaries for grouped trends. Without an LLM, tags stay ungrouped.
 */

import { logger } from '@feed/shared';
import OpenAI from 'openai';
import { tracedCompletion } from '../llm/traced-completion';
import { first } from '../utils/array-utils';
import { isPromptLoggingEnabled, logPrompt } from '../utils/prompt-logger';

// Configuration
const LLM_TIMEOUT_MS = 15000; // 15 seconds
const LLM_MAX_RETRIES = 2;
const GROUPING_MODEL =
  getSurplusConfig()?.model ||
  process.env.TRENDING_GROUPING_MODEL ||
  (process.env.GROQ_API_KEY
    ? process.env.GROQ_SMALL_MODEL ||
      process.env.GROQ_PRIMARY_MODEL ||
      'llama-3.1-8b-instant'
    : 'gpt-5-nano');
const SUMMARY_MODEL =
  getSurplusConfig()?.model ||
  process.env.TRENDING_SUMMARY_MODEL ||
  (process.env.GROQ_API_KEY
    ? process.env.GROQ_SMALL_MODEL ||
      process.env.GROQ_PRIMARY_MODEL ||
      'llama-3.1-8b-instant'
    : 'gpt-5-nano');

// Check if LLM is available
const hasApiKey = !!(
  getSurplusConfig()?.apiKey ||
  process.env.GROQ_API_KEY ||
  process.env.OPENAI_API_KEY
);
const useGroq = !!process.env.GROQ_API_KEY;
const groqBaseURL =
  process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const suppressOptionalLlmWarnings = ['1', 'true', 'yes'].includes(
  (process.env.FEED_SUPPRESS_OPTIONAL_LLM_WARNINGS || '').trim().toLowerCase()
);

// Only initialize OpenAI client if we have an API key
let openai: OpenAI | null = null;
if (hasApiKey) {
  openai = new OpenAI({
    apiKey:
      getSurplusConfig()?.apiKey ||
      process.env.GROQ_API_KEY ||
      process.env.OPENAI_API_KEY,
    baseURL:
      getSurplusConfig()?.baseURL ||
      (useGroq ? groqBaseURL : 'https://api.openai.com/v1'),
    fetch: scheduledInferenceFetch,
    timeout: LLM_TIMEOUT_MS,
    maxRetries: 0,
  });
} else if (!suppressOptionalLlmWarnings) {
  logger.warn(
    'No LLM API key configured (GROQ_API_KEY or OPENAI_API_KEY) - trending tags will not be grouped',
    undefined,
    'TrendingGroupingService'
  );
}

/**
 * Trending tag information
 *
 * @description Contains information about a single trending tag including
 * ID, display name, slug, category, post count, summary, and rank.
 */
export interface TrendingTag {
  id: string;
  tag: string;
  tagSlug: string;
  category: string | null;
  postCount: number;
  summary: string | null;
  rank: number;
}

/**
 * Grouped trend information
 *
 * @description Contains information about a grouped trend including primary
 * tag ID, related tags, total post count, summary, and rank.
 */
export interface GroupedTrend {
  id: string; // ID of the primary tag
  tags: string[]; // Array of related tag display names
  tagSlugs: string[]; // Array of tag slugs for routing
  tagIds: string[]; // Array of tag IDs
  category: string | null;
  totalPostCount: number;
  summary: string;
  rank: number;
}

/**
 * Retry helper for LLM calls
 *
 * @description Retries an LLM call with exponential backoff on failure.
 *
 * @template T - Return type
 * @param {() => Promise<T>} fn - Function to retry
 * @param {number} [retries=LLM_MAX_RETRIES] - Number of retries
 * @param {string} [context='LLM call'] - Context for logging
 * @returns {Promise<T>} Result of the function
 * @throws {Error} If all retries fail
 * @private
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = LLM_MAX_RETRIES,
  context = 'LLM call'
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries) {
        const delay = Math.min(1000 * 2 ** attempt, 5000); // Exponential backoff, max 5s
        logger.warn(
          `${context} failed, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`,
          { error },
          'TrendingGroupingService'
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Result from combined grouping and summary analysis
 */
interface GroupingWithSummary {
  tagToGroup: Map<string, number>;
  groupSummaries: Map<number, string>;
}

/**
 * Parse the LLM grouping XML. Group IDs are assigned per <group> element (the
 * model's own <id> values may repeat), only known input tags are accepted,
 * each tag joins at most one group, and groups need 2+ distinct known tags.
 */
export function parseGroupingResponse(
  content: string,
  knownTagNames: readonly string[]
): GroupingWithSummary {
  const known = new Set(knownTagNames);
  const xmlContent = content
    .replace(/```xml\n?/g, '')
    .replace(/```\n?/g, '')
    .trim();

  const tagToGroup = new Map<string, number>();
  const groupSummaries = new Map<number, string>();
  let nextGroupId = 1;

  for (const groupMatch of xmlContent.matchAll(/<group>([\s\S]*?)<\/group>/g)) {
    const groupContent = groupMatch[1];
    if (!groupContent) continue;

    const members = [
      ...new Set(
        [...groupContent.matchAll(/<tag>([\s\S]*?)<\/tag>/g)]
          .map((m) => m[1]?.trim() ?? '')
          .filter((name) => known.has(name) && !tagToGroup.has(name))
      ),
    ];
    if (members.length < 2) continue;

    const groupId = nextGroupId++;
    for (const name of members) {
      tagToGroup.set(name, groupId);
    }
    const summary = groupContent
      .match(/<summary>([\s\S]*?)<\/summary>/)?.[1]
      ?.trim();
    if (summary) {
      groupSummaries.set(groupId, summary);
    }
  }

  return { tagToGroup, groupSummaries };
}

/**
 * Use LLM to analyze, group, and summarize related trending tags in a single call
 */
async function analyzeAndSummarizeTags(
  tags: TrendingTag[]
): Promise<GroupingWithSummary> {
  const emptyResult: GroupingWithSummary = {
    tagToGroup: new Map(),
    groupSummaries: new Map(),
  };

  if (tags.length <= 1) {
    return emptyResult;
  }

  // Without an LLM there is no evidence that tags share a story; leave them
  // ungrouped rather than inventing groups from category/post-count similarity.
  if (!openai) {
    logger.info(
      'No LLM available - trending tags left ungrouped',
      undefined,
      'TrendingGroupingService'
    );
    return emptyResult;
  }
  // Store in local const after null check to help TypeScript narrow the type
  const client = openai;

  const tagList = tags
    .map(
      (t, i) =>
        `${i + 1}. ${t.tag} (${t.category || 'General'}, ${t.postCount} posts${t.summary ? `, context: "${t.summary}"` : ''})`
    )
    .join('\n');

  const prompt = `Analyze these trending topics from a tech/crypto/politics social platform. Group related tags and generate summaries.

TRENDING TAGS:
${tagList}

YOUR TASK:
1. Identify tags that belong to the SAME story, person, company, or event
2. Group them together (2+ tags per group)
3. Write a catchy summary for each group (like X/Twitter trending descriptions)

GROUPING RULES:
✅ Group tags about the SAME topic:
   - Person + their company: "AIlon Musk" + "TeslAI" + "SpAIceX"
   - Event + participants: "OpenAGI DevDay" + "Sam AIltman" + "SMH-9000"
   - Breaking story + related: "SEC Investigation" + "CoinbAIse" + "Brian AIrmstrong"
   - Product + company: "SMH-6" + "OpenAGI" + "Sam AIltman"

❌ DON'T group just because same category:
   - "BitcAIn" and "EtherAIum" are SEPARATE (different ecosystems)
   - "AIlon Musk" and "Jeff BAIzos" are SEPARATE (unless same story)
   - "TeslAI" and "NvidAI" are SEPARATE (different companies)

SUMMARY RULES:
- Max 12 words, punchy like a headline
- Explain WHY these are trending together
- No hashtags, no emojis
- Sound like a trending topic description

EXAMPLES:

Example 1 - CEO + Company story:
<response>
  <groups>
    <group>
      <id>1</id>
      <tags>
        <tag>Sam AIltman</tag>
        <tag>OpenAGI</tag>
        <tag>SMH-6</tag>
      </tags>
      <summary>OpenAGI unveils SMH-6 at DevDay, AIltman promises AGI by 2026</summary>
    </group>
  </groups>
</response>

Example 2 - Multiple separate stories:
<response>
  <groups>
    <group>
      <id>1</id>
      <tags>
        <tag>TeslAI</tag>
        <tag>AIlon Musk</tag>
        <tag>Cybertruck</tag>
      </tags>
      <summary>TeslAI Cybertruck deliveries begin amid Musk's latest controversy</summary>
    </group>
    <group>
      <id>2</id>
      <tags>
        <tag>SEC</tag>
        <tag>CoinbAIse</tag>
      </tags>
      <summary>SEC escalates CoinbAIse lawsuit, crypto markets react</summary>
    </group>
  </groups>
</response>

Example 3 - No groups needed:
<response>
  <groups></groups>
</response>

Return ONLY valid XML. No markdown, no explanations.`;

  const startTime = Date.now();

  const response = await withRetry(
    async () =>
      await tracedCompletion(client, useGroq ? 'groq' : 'openai', 'trending', {
        model: GROUPING_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an XML-only assistant that analyzes trending topics. Respond ONLY with valid XML matching the exact format shown. No markdown, no JSON, no explanations.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    LLM_MAX_RETRIES,
    'Tag grouping and summary analysis'
  );

  const duration = Date.now() - startTime;

  logger.debug(
    'LLM grouping call completed',
    {
      durationMs: duration,
      model: GROUPING_MODEL,
      // undefined when the provider did not report usage (not "0 tokens")
      tokensUsed: response.usage?.total_tokens,
    },
    'TrendingGroupingService'
  );

  const content = response.choices[0]?.message?.content?.trim();
  if (content && isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: 'trending_grouping_with_summary',
      input: `System: You are an XML-only assistant that analyzes trending topics. Respond ONLY with valid XML matching the exact format shown. No markdown, no JSON, no explanations.\n\nUser: ${prompt}`,
      output: content,
      metadata: {
        provider: useGroq ? 'groq' : 'openai',
        model: GROUPING_MODEL,
        temperature: 0.3,
        maxTokens: 2000,
      },
    });
  }

  if (!content) {
    throw new Error('Trending grouping returned empty content');
  }

  const { tagToGroup, groupSummaries } = parseGroupingResponse(
    content,
    tags.map((t) => t.tag)
  );

  logger.info(
    'LLM grouping analysis complete',
    {
      totalGroups: groupSummaries.size,
      groupedTags: tagToGroup.size,
      durationMs: duration,
    },
    'TrendingGroupingService'
  );

  return { tagToGroup, groupSummaries };
}

/**
 * Generate a one-sentence summary for a single trending tag based on recent posts
 * (Ported from trending-summary-service.ts)
 */
export async function generateTrendingSummary(
  tagDisplayName: string,
  category: string | null,
  recentPosts: string[]
): Promise<string> {
  // Combine recent posts for context
  const context = recentPosts.slice(0, 3).join(' | ');

  // If no context, return a generic summary
  if (!context || context.trim().length === 0) {
    return `Trending topic in ${category || 'general'} discussions`;
  }

  if (!openai) {
    return `Trending topic in ${category || 'general'} discussions`;
  }
  // Store in local const after null check to help TypeScript narrow the type
  const client = openai;

  const prompt = `Generate a ONE SENTENCE summary for the trending topic "${tagDisplayName}" (Category: ${category || 'General'}).

Recent posts about this topic:
${context}

Requirements:
- Exactly ONE sentence, no more than 12 words
- Describe what people are discussing/why it's trending
- Natural, engaging tone like X/Twitter
- No hashtags, no emojis
- Don't start with "People are..." or "Users are..."

Examples:
- "Latest developments in SpaceX launch schedule"
- "Market reactions to new AI regulation"
- "Breaking news on election results"

One sentence summary:`;

  const startTime = Date.now();

  const response = await withRetry(
    async () =>
      await tracedCompletion(client, useGroq ? 'groq' : 'openai', 'trending', {
        model: SUMMARY_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are a trending topics summarization expert. Generate concise, engaging one-sentence summaries.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 50,
      }),
    LLM_MAX_RETRIES,
    'Single trend summary generation'
  );
  const duration = Date.now() - startTime;

  logger.debug(
    'LLM single summary call completed',
    {
      durationMs: duration,
      model: SUMMARY_MODEL,
      tokensUsed: response.usage?.total_tokens,
    },
    'TrendingGroupingService'
  );

  let cleanSummary =
    response.choices[0]?.message?.content
      ?.trim()
      ?.replace(/^["']|["']$/g, '')
      ?.replace(/\.$/, '')
      ?.trim() || '';

  if (isPromptLoggingEnabled()) {
    await logPrompt({
      promptType: 'trending_single_summary',
      input: `System: You are a trending topics summarization expert. Generate concise, engaging one-sentence summaries.\n\nUser: ${prompt}`,
      output: response.choices[0]?.message?.content || '',
      metadata: {
        provider: useGroq ? 'groq' : 'openai',
        model: SUMMARY_MODEL,
        temperature: 0.7,
        maxTokens: 50,
      },
    });
  }

  if (!cleanSummary) {
    throw new Error('Trending summary returned empty content');
  }

  if (
    !cleanSummary.endsWith('.') &&
    !cleanSummary.endsWith('!') &&
    !cleanSummary.endsWith('?')
  ) {
    cleanSummary += '.';
  }

  const wordCount = cleanSummary.split(' ').length;
  if (wordCount > 20) {
    cleanSummary = cleanSummary.split(' ').slice(0, 12).join(' ') + '...';
  }

  return cleanSummary;
}

/**
 * Generate summaries for multiple trending tags
 * (Ported from trending-summary-service.ts)
 */
export async function generateTrendingSummaries(
  tags: Array<{
    displayName: string;
    category: string | null;
    recentPosts: string[];
  }>
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Process in small batches to avoid rate limits
  for (const tag of tags) {
    const summary = await generateTrendingSummary(
      tag.displayName,
      tag.category,
      tag.recentPosts
    );
    results.set(tag.displayName, summary);

    // Small delay to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return results;
}

/**
 * Group related trending tags using LLM analysis
 * Now uses combined grouping + summary in single LLM call for efficiency
 */
export async function groupTrendingTags(
  tags: TrendingTag[]
): Promise<GroupedTrend[]> {
  if (tags.length === 0) {
    return [];
  }

  const startTime = Date.now();
  logger.info(
    'Starting trending tags grouping',
    { tagCount: tags.length },
    'TrendingGroupingService'
  );

  // Get grouping instructions AND summaries from LLM in single call
  const { tagToGroup, groupSummaries } = await analyzeAndSummarizeTags(tags);

  // Build groups
  const groups = new Map<number, TrendingTag[]>();
  const ungroupedTags: TrendingTag[] = [];

  for (const tag of tags) {
    const groupId = tagToGroup.get(tag.tag);
    if (groupId !== undefined) {
      if (!groups.has(groupId)) {
        groups.set(groupId, []);
      }
      groups.get(groupId)!.push(tag);
    } else {
      ungroupedTags.push(tag);
    }
  }

  // Create grouped trends
  const result: GroupedTrend[] = [];

  // Process groups (multiple tags)
  for (const [groupId, groupTags] of groups.entries()) {
    if (groupTags.length < 2) {
      // If group ended up with only 1 tag, treat as ungrouped
      ungroupedTags.push(...groupTags);
      continue;
    }

    // Sort by post count to pick primary tag
    groupTags.sort((a, b) => b.postCount - a.postCount);
    const primaryTag = first(groupTags);
    if (!primaryTag) continue;

    // Use pre-generated summary from combined LLM call, or fallback
    const summary =
      groupSummaries.get(groupId) ||
      `${groupTags.map((t) => t.tag).join(', ')} trending in ${primaryTag.category || 'general'}`;

    logger.debug(
      'Created grouped trend',
      {
        groupId,
        tags: groupTags.map((t) => t.tag),
        totalPosts: groupTags.reduce((sum, t) => sum + t.postCount, 0),
        summary,
      },
      'TrendingGroupingService'
    );

    result.push({
      id: primaryTag.id,
      tags: groupTags.map((t) => t.tag),
      tagSlugs: groupTags.map((t) => t.tagSlug),
      tagIds: groupTags.map((t) => t.id),
      category: primaryTag.category,
      totalPostCount: groupTags.reduce((sum, t) => sum + t.postCount, 0),
      summary,
      rank: Math.min(...groupTags.map((t) => t.rank)), // Use best rank
    });
  }

  // Add ungrouped tags as single-tag groups
  for (const tag of ungroupedTags) {
    result.push({
      id: tag.id,
      tags: [tag.tag],
      tagSlugs: [tag.tagSlug],
      tagIds: [tag.id],
      category: tag.category,
      totalPostCount: tag.postCount,
      summary: tag.summary || `Trending in ${tag.category || 'general'}`,
      rank: tag.rank,
    });
  }

  // Sort by rank
  result.sort((a, b) => a.rank - b.rank);

  const duration = Date.now() - startTime;
  logger.info(
    'Trending tags grouping complete',
    {
      inputTags: tags.length,
      outputGroups: result.length,
      multiTagGroups: result.filter((g) => g.tags.length > 1).length,
      durationMs: duration,
    },
    'TrendingGroupingService'
  );

  return result;
}
