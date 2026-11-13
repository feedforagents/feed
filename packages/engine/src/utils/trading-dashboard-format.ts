/**
 * Shared Trading Dashboard Formatting
 *
 * Canonical helpers for formatting NPC trading dashboards and market tables.
 * Used by both MarketDecisionEngine (LLM prompt) and dev tools (context-inspector).
 *
 * Extracted from MarketDecisionEngine private methods to enable reuse
 * without behavioral drift.
 */

import { getPositionExposure } from '../npc/portfolio-metrics';
import {
  formatTradingStrategyBias,
  getNpcTradingStrategy,
  TRADING_STRATEGIES,
} from '../npc/trading-strategies';
import type { NPCMarketContext, NPCPosition } from '../types/market-context';

/**
 * Map a free-text personality description to a trading archetype label.
 *
 * Mirrors the logic previously private on MarketDecisionEngine.
 */
export function mapPersonalityToArchetype(personality: string): string {
  const p = personality.toLowerCase();
  // Cautious descriptors are checked first so "risk-averse" / "risk manager"
  // are not misclassified as degen by the generic "risk" keyword below.
  if (
    p.includes('cautious') ||
    p.includes('conservative') ||
    p.includes('risk-averse') ||
    p.includes('risk averse') ||
    p.includes('manager')
  ) {
    return 'RISK_MANAGER';
  }
  if (
    p.includes('risk') ||
    p.includes('aggressive') ||
    p.includes('degen') ||
    p.includes('speculator')
  ) {
    return 'DEGEN_TRADER';
  }
  if (p.includes('analytical') || p.includes('quant') || p.includes('math')) {
    return 'QUANT_TRADER';
  }
  if (p.includes('insider') || p.includes('connected')) {
    return 'INSIDER';
  }
  return 'SYSTEMATIC_TRADER';
}

/**
 * Calculate portfolio exposure as a percentage of total equity.
 *
 * Formula: (totalPositionValue / totalEquity) × 100
 * where totalPositionValue = Σ(position value + unrealizedPnL)
 * and   totalEquity        = cash + totalPositionValue
 *
 * A position's value is the capital actually deployed: for prediction
 * markets that is the cash cost (`size`), but for perps `size` is the
 * leveraged notional, so the deployed capital is the margin
 * `|size / leverage|` — the same exposure `getPositionExposure` reports
 * everywhere else. Summing raw notional overstated a 5x perp's exposure
 * fivefold in the prompt the LLM trades from.
 *
 * Clamped to [0, 100].
 */
export function calculatePortfolioExposure(
  balance: number,
  positions: Pick<
    NPCPosition,
    'size' | 'unrealizedPnL' | 'marketType' | 'leverage'
  >[]
): number {
  const totalPositionValue = positions.reduce(
    (sum, p) =>
      sum +
      getPositionExposure(
        p.size,
        p.marketType === 'perp' ? p.leverage : undefined
      ) +
      p.unrealizedPnL,
    0
  );
  const totalEquity = balance + totalPositionValue;

  if (totalEquity <= 0) return 0;
  return Math.min(100, Math.max(0, (totalPositionValue / totalEquity) * 100));
}

/**
 * Format a single NPC's trading dashboard block.
 *
 * Produces the same output as MarketDecisionEngine.formatNPCsList per entry.
 * @param ctx   - Full NPC market context
 * @param index - Optional 1-based index for multi-NPC listings
 */
export function formatSingleNPCDashboard(
  ctx: NPCMarketContext,
  index?: number
): string {
  const archetype = mapPersonalityToArchetype(ctx.personality);
  const strategyKey = getNpcTradingStrategy(ctx.npcId);
  const strategy = TRADING_STRATEGIES[strategyKey];
  const exposure = calculatePortfolioExposure(
    ctx.availableBalance,
    ctx.currentPositions
  );

  const totalPnL = ctx.currentPositions.reduce(
    (sum, p) => sum + p.unrealizedPnL,
    0
  );
  const pnlSign = totalPnL >= 0 ? '+' : '';

  const allPositions = [...ctx.currentPositions]
    .sort((a, b) => Math.abs(b.unrealizedPnL) - Math.abs(a.unrealizedPnL))
    .map((p) => {
      const market = ctx.predictionMarkets.find(
        (market) => market.id === p.marketId
      );
      const symbol =
        p.marketType === 'perp'
          ? p.ticker
          : `marketId=${p.marketId}${market ? ` question=${JSON.stringify(market.text)}` : ''}`;
      const posSign = p.unrealizedPnL >= 0 ? '+' : '';
      return `${symbol} ${p.side} ($${p.size.toFixed(0)}, PnL: ${posSign}$${p.unrealizedPnL.toFixed(0)}) [ID:${p.id}]`;
    })
    .join(', ');

  const relationships =
    ctx.relationships && ctx.relationships.length > 0
      ? ctx.relationships
          .map(
            (r) =>
              `${r.actorName}: ${r.relationshipType}, sentiment=${r.sentiment}, strength=${r.strength}${r.history ? `; ${r.history}` : ''}`
          )
          .join(', ')
      : 'None';

  const privateIntel =
    ctx.groupChatMessages.length > 0
      ? ctx.groupChatMessages
          .map(
            (m) =>
              `[${m.chatName}; ${m.timestamp}] "${m.fromName}: ${m.message}"`
          )
          .join(' | ')
      : 'None';

  const prefix = index !== undefined ? `[${index}] ` : '';

  // Character voice context for in-character trading reasoning
  const voiceHint =
    'voice' in ctx && ctx.voice ? `Voice: ${String(ctx.voice)}` : '';
  const domainsHint =
    'domains' in ctx && ctx.domains
      ? `Expertise: ${((ctx.domains as string[]) ?? []).join(', ')}`
      : '';

  return `${prefix}TRADER DASHBOARD
ID: ${ctx.npcId} | Name: ${ctx.npcName}
Personality: ${ctx.personality}
Archetype: ${archetype} | Strategy: ${strategy.label} (${strategyKey})
${voiceHint ? voiceHint + '\n' : ''}${domainsHint ? domainsHint + '\n' : ''}Bias: ${formatTradingStrategyBias(strategy)} | Cash: $${ctx.availableBalance.toLocaleString()}
Total PnL: ${pnlSign}$${totalPnL.toFixed(0)} | Exposure: ${exposure.toFixed(1)}%
Network: ${relationships}
Positions: ${allPositions || 'None'}
PRIVATE INTEL: ${privateIntel}
RELEVANT FEED:
${ctx.recentPosts.map((p) => `[${p.timestamp}] ${p.authorName}: ${p.content}${p.articleTitle ? ` (Article: ${p.articleTitle})` : ''}`).join('\n') || 'None'}
OBSERVED EVENTS:
${ctx.recentEvents.map((e) => `[${e.timestamp}] ${e.type}: ${e.description}`).join('\n') || 'None'}`;
}

/**
 * Format an array of NPC contexts into a separator-delimited dashboard list.
 *
 * Direct replacement for MarketDecisionEngine.formatNPCsList.
 */
export function formatNPCsDashboardList(contexts: NPCMarketContext[]): string {
  return contexts
    .map((ctx, i) => formatSingleNPCDashboard(ctx, i + 1))
    .join('\n----------------------------------------\n');
}

/**
 * Format the shared market data table shown to all NPCs.
 *
 * Direct replacement for MarketDecisionEngine.formatMarketTable.
 * Takes a single context (all NPCs see the same market state).
 */
export function formatMarketDataTable(ctx: NPCMarketContext): string {
  const perps = ctx.perpMarkets;
  const predictions = ctx.predictionMarkets;

  if (perps.length === 0 && predictions.length === 0) {
    return 'No Market Data Available';
  }

  let table =
    '| Ticker/ID | Type | Price | 24h Change | 24h Range | Context | Vol / MaxBet |\n|---|---|---|---|---|---|---|\n';

  for (const p of perps) {
    const sign = p.changePercent24h >= 0 ? '+' : '';
    const range = `$${p.low24h.toFixed(2)}-$${p.high24h.toFixed(2)}`;
    table += `| ${p.ticker} | PERP | $${p.currentPrice.toFixed(2)} | ${sign}${p.changePercent24h.toFixed(2)}% | ${range} | spot | $${(p.volume24h / 1000).toFixed(1)}k / — |\n`;
  }

  for (const p of predictions) {
    const daysLeft = p.daysUntilResolution;
    const safeText = p.text.replace(/\|/g, '/');
    const contextLabel = `${p.horizonBucket} / ${p.liquidityTier} / ${p.urgencyLevel} / ${p.eventSensitivity}`;
    const maxBetLabel =
      p.maxSafeBet > 0
        ? `$${(Math.floor(p.maxSafeBet * 100) / 100).toFixed(2)}`
        : '$0.00';
    table += `| ${p.id} | PRED | Yes: ${p.yesPrice.toFixed(0)}¢ / No: ${p.noPrice.toFixed(0)}¢ | ${daysLeft}d left; resolves ${p.resolutionDate} | "${safeText}" | ${contextLabel} | $${(p.totalVolume / 1000).toFixed(1)}k / max ${maxBetLabel} |\n`;
  }

  return table;
}
