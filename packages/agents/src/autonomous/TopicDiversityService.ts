/**
 * Topic Diversity Service
 *
 * Ensures agents post about different topics like real humans would.
 * Prevents the "echo chamber" effect where all agents post about the same thing.
 *
 * Key mechanisms:
 * 1. Topic tracking - Track what topics have been covered recently (per-domain)
 * 2. Topic assignment - Assign different topics to different agents based on their domain
 * 3. Similarity detection - Detect and reject similar posts
 * 4. Cooldown management - Prevent same topic spam in short windows
 * 5. Domain-aware limits - NPCs in different domains have separate topic pools
 */

import { db, desc, gte, posts } from '@feed/db';
import { StaticDataRegistry } from '@feed/engine';
import { jaccardSimilarity } from '@feed/shared';
import { logger } from '../shared/logger';

// =============================================================================
// Types
// =============================================================================

interface TopicPost {
  agentId: string;
  domain: string;
  content: string;
  postedAt: number;
}

interface AgentPhrase {
  phrase: string;
  postedAt: number;
}

interface TopicAssignment {
  /** Primary topic/market for this agent */
  primaryTopicKey: string;
  /** Market ID if this is a prediction market topic */
  marketId?: string;
  /** Signal direction from arc plan (YES/NO/NEUTRAL) */
  signalDirection?: 'YES' | 'NO' | 'NEUTRAL';
  /** NPC's personality from their character data */
  personality?: string;
  /** NPC's post style from their character data */
  postStyle?: string;
}

export interface PredictionMarketForTopic {
  id: string;
  question: string;
  yesPrice: number;
  noPrice: number;
}

// =============================================================================
// Constants
// =============================================================================

/** How long to track topic coverage (30 minutes) */
const TOPIC_TRACKING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Max posts about same topic in window before blocking (GLOBAL)
 * Increased to allow more NPCs to post about hot topics
 */
const MAX_TOPIC_COVERAGE_GLOBAL = 20;

/**
 * Max posts per domain about same topic
 * Allows multiple NPCs in same domain to cover a topic from different angles
 */
const MAX_TOPIC_COVERAGE_PER_DOMAIN = 5;

/** Minimum word overlap to consider posts similar */
const SIMILARITY_THRESHOLD = 0.3; // Lower threshold for stricter duplicate detection

/** Common repetitive phrases to detect and block */
const REPETITIVE_PHRASE_PATTERNS = [
  // Statistical patterns
  /\d+%\s*crowd\s*consensus/i,
  /\d+:\d+\s*asymmetry/i,
  /\d+%\s*(yes|no)\s*(on|for|against)/i,
  // Trading cliches
  /exit\s*liquidity/i,
  /fade\s*the\s*herd/i,
  /when\s*everyone['']?s\s*(certain|bullish|bearish|long|short)/i,
  /security\s*(first|rule|101)/i,
  /risk\s*asymmetry/i,
  /consensus\s*(reversal|flips?)/i,
  /mean[\s-]?reversion/i,
  /cascade\s*liquidations?/i,
  /crowded\s*(long|short|trade)/i,
];

/** Angles for variety in posting - exported for use in prompt construction */
export const POSTING_ANGLES = [
  'contrarian', // Disagree with consensus
  'analytical', // Data/numbers focused
  'skeptical', // Question the narrative
  'bullish', // Optimistic take
  'bearish', // Pessimistic take
  'humorous', // Joking/sarcastic
  'insider', // Claim special knowledge
  'historical', // Compare to past events
  'questioning', // Ask a question
  'declarative', // Bold statement
] as const;

// =============================================================================
// Topic Diversity Service
// =============================================================================

export class TopicDiversityService {
  /** In-memory topic coverage tracking */
  private topicCoverage = new Map<string, TopicPost[]>();

  /** Agent to assigned topic mapping for current tick batch */
  private agentAssignments: Map<string, TopicAssignment> = new Map();

  /** Per-agent phrase tracking to prevent repetitive patterns */
  private agentPhraseHistory = new Map<string, AgentPhrase[]>();

  /**
   * Extract topic key from content (normalized keywords)
   */
  extractTopicKey(content: string): string {
    // Normalize: lowercase, remove punctuation, extract key terms
    const normalized = content
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract key nouns/entities (simple heuristic)
    const words = normalized.split(' ');
    const stopWords = new Set([
      'the',
      'a',
      'an',
      'is',
      'are',
      'was',
      'were',
      'be',
      'been',
      'being',
      'have',
      'has',
      'had',
      'do',
      'does',
      'did',
      'will',
      'would',
      'could',
      'should',
      'may',
      'might',
      'must',
      'shall',
      'can',
      'need',
      'dare',
      'ought',
      'used',
      'to',
      'of',
      'in',
      'for',
      'on',
      'with',
      'at',
      'by',
      'from',
      'up',
      'about',
      'into',
      'over',
      'after',
      'and',
      'but',
      'or',
      'so',
      'yet',
      'both',
      'either',
      'neither',
      'not',
      'only',
      'own',
      'same',
      'than',
      'too',
      'very',
      'just',
      'also',
      'now',
      'here',
      'there',
      'when',
      'where',
      'why',
      'how',
      'all',
      'each',
      'every',
      'few',
      'more',
      'most',
      'other',
      'some',
      'such',
      'no',
      'nor',
      'as',
      'if',
      'then',
      'because',
      'while',
      'although',
      'though',
      'whether',
      'my',
      'your',
      'his',
      'her',
      'its',
      'our',
      'their',
      'this',
      'that',
      'these',
      'those',
      'i',
      'you',
      'he',
      'she',
      'it',
      'we',
      'they',
      'me',
      'him',
      'us',
      'them',
    ]);

    const keyTerms = words
      .filter((w) => w.length > 3 && !stopWords.has(w))
      .slice(0, 5)
      .sort()
      .join('_');

    return keyTerms || 'generic';
  }

  /**
   * Calculate similarity between two pieces of content
   * Uses Jaccard similarity on word sets
   */
  calculateSimilarity(content1: string, content2: string): number {
    return jaccardSimilarity(content1, content2);
  }

  /**
   * Get the primary domain for an agent (first domain in their list)
   */
  private getAgentPrimaryDomain(agentId: string): string {
    const actor = StaticDataRegistry.getActor(agentId);
    if (!actor || actor.domain.length === 0) {
      return 'general';
    }
    // Handle empty strings in domain array (e.g., [""])
    const firstDomain = actor.domain[0];
    return firstDomain && firstDomain.trim() !== '' ? firstDomain : 'general';
  }

  /**
   * Get all domains for an agent
   */
  private getAgentDomains(agentId: string): string[] {
    const actor = StaticDataRegistry.getActor(agentId);
    if (!actor || actor.domain.length === 0) {
      return ['general'];
    }
    // Filter out empty strings in domain array
    const validDomains = actor.domain.filter((d) => d && d.trim() !== '');
    return validDomains.length > 0 ? validDomains : ['general'];
  }

  /**
   * Extract repetitive phrases from content for tracking
   */
  extractRepetitivePhrases(content: string): string[] {
    const phrases: string[] = [];
    for (const pattern of REPETITIVE_PHRASE_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        phrases.push(match[0].toLowerCase());
      }
    }
    return phrases;
  }

  /**
   * Check if content uses repetitive phrases the agent has used recently
   */
  hasRepetitivePhrases(
    agentId: string,
    content: string
  ): { hasRepetition: boolean; repeatedPhrase?: string } {
    const contentPhrases = this.extractRepetitivePhrases(content);
    if (contentPhrases.length === 0) {
      return { hasRepetition: false };
    }

    this.cleanupOldEntries();
    const history = this.agentPhraseHistory.get(agentId);
    if (!history) {
      return { hasRepetition: false };
    }

    // Check if any phrase has been used before
    for (const phrase of contentPhrases) {
      // Normalize for comparison
      const normalizedPhrase = phrase.replace(/\d+/g, 'N'); // Replace numbers with N for pattern matching
      for (const entry of history) {
        const normalizedHistory = entry.phrase.replace(/\d+/g, 'N');
        if (normalizedPhrase === normalizedHistory) {
          return { hasRepetition: true, repeatedPhrase: phrase };
        }
      }
    }

    return { hasRepetition: false };
  }

  /**
   * Record phrases used by an agent
   */
  recordAgentPhrases(
    agentId: string,
    content: string,
    timestamp = new Date()
  ): void {
    const phrases = this.extractRepetitivePhrases(content);
    if (phrases.length === 0) return;

    this.cleanupOldEntries();
    const history = this.agentPhraseHistory.get(agentId) ?? [];
    const postedAt = timestamp.getTime();
    history.push(...phrases.map((phrase) => ({ phrase, postedAt })));
    this.agentPhraseHistory.set(agentId, history.slice(-20));
  }

  /** Record a committed post and its coverage of a topic. */
  recordTopicCoverage(
    agentId: string,
    content: string,
    topicKey?: string,
    timestamp = new Date()
  ): void {
    this.cleanupOldEntries();

    const key = topicKey || this.extractTopicKey(content);
    const coverage = this.topicCoverage.get(key) ?? [];
    coverage.push({
      agentId,
      domain: this.getAgentPrimaryDomain(agentId),
      content: content.substring(0, 200),
      postedAt: timestamp.getTime(),
    });
    this.topicCoverage.set(key, coverage);
    this.recordAgentPhrases(agentId, content, timestamp);
  }

  /**
   * Check if a topic can be posted about (not over-covered)
   * Now uses domain-aware limits so different domains have separate quotas
   */
  canPostAboutTopic(
    agentId: string,
    topicKey: string
  ): {
    canPost: boolean;
    reason?: string;
  } {
    this.cleanupOldEntries();

    const coverage = this.topicCoverage.get(topicKey);
    if (!coverage) return { canPost: true };

    // Block if this agent already posted about it recently
    if (coverage.some((post) => post.agentId === agentId)) {
      return {
        canPost: false,
        reason: `You already posted about this topic recently. Try a different angle or topic.`,
      };
    }

    // Block if global limit exceeded
    if (coverage.length >= MAX_TOPIC_COVERAGE_GLOBAL) {
      return {
        canPost: false,
        reason: `This topic is heavily covered. Try something fresh that others haven't posted about.`,
      };
    }

    // Check domain-specific limit
    const agentDomain = this.getAgentPrimaryDomain(agentId);
    const domainCount = coverage.filter(
      (post) => post.domain === agentDomain
    ).length;

    if (domainCount >= MAX_TOPIC_COVERAGE_PER_DOMAIN) {
      // Suggest the agent's other domains or a unique angle
      const agentDomains = this.getAgentDomains(agentId);
      const otherDomains = agentDomains.filter((d) => d !== agentDomain);

      if (otherDomains.length > 0) {
        return {
          canPost: false,
          reason: `Too many ${agentDomain} voices on this topic. Try approaching from your ${otherDomains.join(' or ')} perspective instead.`,
        };
      }
      return {
        canPost: false,
        reason: `Your domain already covered this topic enough. Post about something in your unique wheelhouse.`,
      };
    }

    return { canPost: true };
  }

  /**
   * Check if content is too similar to recent posts
   */
  isTooSimilarToRecent(content: string): {
    isSimilar: boolean;
    matchedContent?: string;
    similarity?: number;
  } {
    this.cleanupOldEntries();

    for (const coverage of this.topicCoverage.values()) {
      for (const sample of coverage.slice(-10)) {
        const similarity = this.calculateSimilarity(content, sample.content);
        if (similarity >= SIMILARITY_THRESHOLD) {
          return {
            isSimilar: true,
            matchedContent: sample.content,
            similarity,
          };
        }
      }
    }

    return { isSimilar: false };
  }

  /**
   * Validate content before posting
   * Returns issues if any, empty array if OK
   *
   * Focus: Prevent repetitiveness, NOT restrict creative language
   * Now domain-aware: NPCs in different domains have separate quotas
   */
  validateContent(agentId: string, content: string): string[] {
    const issues: string[] = [];

    // Check topic coverage - domain-aware limits
    const topicKey = this.extractTopicKey(content);
    const topicCheck = this.canPostAboutTopic(agentId, topicKey);
    if (!topicCheck.canPost && topicCheck.reason) {
      issues.push(topicCheck.reason);
    }

    // Check similarity - prevent copy-paste style repetition
    const similarityCheck = this.isTooSimilarToRecent(content);
    if (similarityCheck.isSimilar) {
      issues.push(
        `Content is ${Math.round((similarityCheck.similarity ?? 0) * 100)}% similar to a recent post. Add your unique take.`
      );
    }

    // Check phrase repetition - prevent repetitive patterns
    const phraseCheck = this.hasRepetitivePhrases(agentId, content);
    if (phraseCheck.hasRepetition) {
      issues.push(
        `You've used the phrase pattern "${phraseCheck.repeatedPhrase}" recently. Try a different angle or phrasing.`
      );
    }

    return issues;
  }

  /**
   * Assign topics to agents for a batch tick
   * Ensures each agent gets a different primary topic
   * NOW DOMAIN-AWARE: Considers each NPC's domain when assigning topics
   */
  async assignTopicsToAgents(
    agentIds: string[],
    availableMarkets: PredictionMarketForTopic[]
  ): Promise<Map<string, TopicAssignment>> {
    this.cleanupOldEntries();
    this.agentAssignments.clear();

    // Shuffle agents for fairness
    const shuffledAgents = [...agentIds].sort(() => Math.random() - 0.5);

    // For each agent, score markets based on:
    // 1. How under-covered the topic is in their domain
    // 2. How relevant the market is to their domain (keyword matching)
    // 3. Random bonus for variety
    for (const agentId of shuffledAgents) {
      if (!agentId) continue;

      const agentDomains = this.getAgentDomains(agentId);
      const primaryDomain = agentDomains[0] ?? 'general';

      // Score each market for THIS agent
      const marketScores = availableMarkets.map((market) => {
        const topicKey = this.extractTopicKey(market.question);
        const coverage = this.topicCoverage.get(topicKey);
        const globalCount = coverage?.length ?? 0;
        const domainCount =
          coverage?.filter((post) => post.domain === primaryDomain).length ?? 0;

        // Higher score = better for this agent
        // Freshness: prefer topics not covered much in their domain
        const domainFreshness = Math.max(
          0,
          MAX_TOPIC_COVERAGE_PER_DOMAIN - domainCount
        );
        const globalFreshness = Math.max(
          0,
          MAX_TOPIC_COVERAGE_GLOBAL - globalCount
        );

        // Relevance: check if market keywords match agent domains
        const marketLower = market.question.toLowerCase();
        let relevanceBonus = 0;
        for (const domain of agentDomains) {
          if (marketLower.includes(domain)) {
            relevanceBonus += 2;
          }
        }

        // Random bonus for variety
        const randomBonus = Math.random() * 2;

        return {
          market,
          topicKey,
          score:
            domainFreshness * 2 +
            globalFreshness +
            relevanceBonus +
            randomBonus,
        };
      });

      // Sort by score (highest first)
      marketScores.sort((a, b) => b.score - a.score);

      // Pick the best market for this agent
      const bestMarket = marketScores[0];

      if (!bestMarket) continue;

      // Get NPC's actual personality and post style from their character data
      const actor = StaticDataRegistry.getActor(agentId);

      this.agentAssignments.set(agentId, {
        primaryTopicKey: bestMarket.topicKey,
        marketId: bestMarket.market.id,
        personality: actor?.personality,
        postStyle: actor?.postStyle,
      });
    }

    logger.info(
      `Assigned topics to ${shuffledAgents.length} agents (domain-aware)`,
      {
        marketsAvailable: availableMarkets.length,
        assignmentCount: this.agentAssignments.size,
      },
      'TopicDiversityService'
    );

    return this.agentAssignments;
  }

  /**
   * Get the assigned topic for an agent
   */
  getAgentAssignment(agentId: string): TopicAssignment | undefined {
    return this.agentAssignments.get(agentId);
  }

  /**
   * Load recent posts from DB to seed the topic tracker
   */
  async seedFromRecentPosts(): Promise<void> {
    const cutoff = new Date(Date.now() - TOPIC_TRACKING_WINDOW_MS);

    const recentPosts = await db
      .select({
        authorId: posts.authorId,
        content: posts.content,
        timestamp: posts.timestamp,
      })
      .from(posts)
      .where(gte(posts.timestamp, cutoff))
      .orderBy(desc(posts.timestamp))
      .limit(100);

    for (const post of recentPosts.reverse()) {
      this.recordTopicCoverage(
        post.authorId,
        post.content,
        undefined,
        post.timestamp
      );
    }

    logger.info(
      `Seeded topic tracker with ${recentPosts.length} recent posts`,
      {
        topicsTracked: this.topicCoverage.size,
        agentsWithPhraseHistory: this.agentPhraseHistory.size,
      },
      'TopicDiversityService'
    );
  }

  /**
   * Get diversity instructions for an agent's prompt
   *
   * Uses the NPC's actual character data (domains, personality, postStyle)
   * rather than hardcoded suggestions. Now DOMAIN-AWARE for topic limits.
   */
  getDiversityInstructions(agentId: string): string {
    this.cleanupOldEntries();
    const assignment = this.agentAssignments.get(agentId);
    const agentDomains = this.getAgentDomains(agentId);
    const primaryDomain = agentDomains[0] ?? 'general';

    // Get NPC's actual character data
    const actor = StaticDataRegistry.getActor(agentId);
    const personality =
      actor?.personality || assignment?.personality || 'unique';
    const postStyle = actor?.postStyle || assignment?.postStyle;

    // Find topics that are over-covered in this NPC's domain
    const overCoveredInDomain: string[] = [];
    const overCoveredGlobally: string[] = [];
    const ownTopics: string[] = [];

    for (const [key, coverage] of this.topicCoverage.entries()) {
      const domainCount = coverage.filter(
        (post) => post.domain === primaryDomain
      ).length;
      if (domainCount >= MAX_TOPIC_COVERAGE_PER_DOMAIN) {
        overCoveredInDomain.push(key);
      }
      if (coverage.length >= MAX_TOPIC_COVERAGE_GLOBAL * 0.7) {
        overCoveredGlobally.push(key);
      }
      if (coverage.some((post) => post.agentId === agentId)) {
        ownTopics.push(key);
      }
    }

    let instructions = `
# PLAY THE GAME - MIX IT UP

## Your Personality: ${personality.toUpperCase()}
${postStyle ? `Your posting style: ${postStyle}` : ''}

## Your Domain Expertise: ${agentDomains.join(', ').toUpperCase()}
Use your unique ${primaryDomain} perspective. Don't paraphrase recent posts. Give a different subject or a concrete new observation in distinct language. For a due market clue, stay with its question and bring a fresh observation.

## Topics You Recently Posted About (choose something different):
${ownTopics.length > 0 ? ownTopics.slice(-3).join(', ') : 'None'}

## What to Do This Tick (pick what feels natural):
- TRADE on prediction markets or perps
- POST about events, markets, your thesis, anything
- COMMENT on someone else's post from the feed - engage!
- REPLY_COMMENT to pending comment replies on your posts/threads
- REPLY_CHAT to pending DMs or group messages
- React to news, rumors, price movements
- Dunk on a bad take or amplify a good one

## Topics OVER-COVERED in Your Domain (try something else):
${
  overCoveredInDomain.length > 0
    ? overCoveredInDomain
        .slice(0, 3)
        .map((t) => `- ${t}`)
        .join('\n')
    : '- None - you have fresh topics available!'
}

## Topics Covered A Lot Globally (bring a fresh angle if covering):
${
  overCoveredGlobally.length > 0
    ? overCoveredGlobally
        .slice(0, 3)
        .map((t) => `- ${t}`)
        .join('\n')
    : '- None currently'
}

## Post Ideas Based on YOUR Character:
- React to current events in YOUR ${personality} way
- Something only YOU would notice given your domains
- A take that fits YOUR voice and posting style
- Engage with other posts from YOUR perspective
`;

    if (assignment?.marketId) {
      instructions += `
## Your Focus Market:
Market ID: ${assignment.marketId}
You could trade this, post about it, or comment on price action.
`;
    }

    return instructions;
  }

  /**
   * Clean up old entries from the tracker
   */
  private cleanupOldEntries(): void {
    const cutoff = Date.now() - TOPIC_TRACKING_WINDOW_MS;
    this.pruneHistory(this.topicCoverage, cutoff);
    this.pruneHistory(this.agentPhraseHistory, cutoff);
  }

  private pruneHistory<T extends { postedAt: number }>(
    history: Map<string, T[]>,
    cutoff: number
  ): void {
    for (const [key, entries] of history) {
      const recent = entries.filter((entry) => entry.postedAt > cutoff);
      if (recent.length === 0) {
        history.delete(key);
      } else if (recent.length < entries.length) {
        history.set(key, recent);
      }
    }
  }

  /**
   * Get current topic coverage stats (for debugging/monitoring)
   */
  getTopicStats(): {
    topicsTracked: number;
    mostCovered: { topic: string; count: number }[];
    agentsWithPhraseHistory: number;
  } {
    this.cleanupOldEntries();
    const sorted = Array.from(this.topicCoverage.entries())
      .map(([topic, coverage]) => ({ topic, count: coverage.length }))
      .sort((a, b) => b.count - a.count);

    return {
      topicsTracked: this.topicCoverage.size,
      mostCovered: sorted.slice(0, 10),
      agentsWithPhraseHistory: this.agentPhraseHistory.size,
    };
  }
}

// Export singleton
export const topicDiversityService = new TopicDiversityService();
