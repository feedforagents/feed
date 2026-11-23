import type { AgentTickContext } from './templates/multi-step-decision';

type TradeParameters = Record<string, unknown>;

const PREDICTION_SIDES = new Set(['buy_yes', 'buy_no', 'sell_yes', 'sell_no']);
const PERP_SIDES = new Set(['open_long', 'open_short', 'close_position']);
const PREDICTION_MARKET_TYPE_ALIASES = new Set([
  'prediction',
  'predictions',
  'predict',
  'perception',
  'market',
  'binary',
  'option',
  'options',
]);
const PERP_MARKET_TYPE_ALIASES = new Set([
  'perp',
  'perps',
  'perpetual',
  'perpetuals',
  'futures',
  'future',
]);
const NOOP_SIDES = new Set([
  '',
  'none',
  'null',
  'n/a',
  'na',
  'hold',
  'wait',
  'skip',
  'finish',
]);

function toNormalizedToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function coerceIdLikeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }

  return '';
}

function normalizeMarketType(
  rawMarketType: unknown
): 'prediction' | 'perp' | undefined {
  if (typeof rawMarketType !== 'string') {
    return undefined;
  }

  const normalized = toNormalizedToken(rawMarketType);
  if (PREDICTION_MARKET_TYPE_ALIASES.has(normalized)) {
    return 'prediction';
  }
  if (PERP_MARKET_TYPE_ALIASES.has(normalized)) {
    return 'perp';
  }

  return undefined;
}

function resolvePredictionMarketId(
  rawMarketId: string,
  context: AgentTickContext
): string | undefined {
  const trimmed = rawMarketId.trim();
  if (!trimmed) {
    return undefined;
  }

  const predictionCandidates = [
    ...context.predictionMarkets.map((market) => ({
      id: market.id,
      question: market.question,
    })),
    ...context.agentPositions.predictions.map((position) => ({
      id: position.marketId,
      question: position.question,
    })),
  ].filter(
    (candidate, index, collection) =>
      collection.findIndex((entry) => entry.id === candidate.id) === index
  );

  const directId = predictionCandidates.find((market) => market.id === trimmed);
  if (directId) {
    return directId.id;
  }

  const numericPrefix = trimmed.match(/^(\d+)/)?.[1];
  if (numericPrefix) {
    const prefixed = predictionCandidates.find(
      (market) => market.id === numericPrefix
    );
    if (prefixed) {
      return prefixed.id;
    }
  }

  const normalized = trimmed.toUpperCase();
  const byQuestion = predictionCandidates.find((market) => {
    const question = market.question.toUpperCase();
    return question === normalized;
  });
  if (byQuestion) {
    return byQuestion.id;
  }

  return undefined;
}

function resolvePerpTicker(
  rawMarketId: string,
  context: AgentTickContext
): string | undefined {
  const trimmed = rawMarketId.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed.toUpperCase();
  const leadingToken = normalized
    .split(':', 1)[0]
    ?.trim()
    .split(/\s+/, 1)[0]
    ?.trim();

  const perpCandidates: Array<{ ticker: string; name?: string }> = [
    ...context.perpMarkets.map((market) => ({
      ticker: market.ticker,
      name: market.name,
    })),
  ];
  const seenTickers = new Set(
    perpCandidates.map((market) => market.ticker.toUpperCase())
  );
  for (const position of context.agentPositions.perps) {
    const tickerKey = position.ticker.toUpperCase();
    if (!seenTickers.has(tickerKey)) {
      seenTickers.add(tickerKey);
      perpCandidates.push({ ticker: position.ticker });
    }
  }

  for (const market of perpCandidates) {
    const ticker = market.ticker.toUpperCase();
    const name = market.name?.toUpperCase();

    if (
      normalized === ticker ||
      leadingToken === ticker ||
      normalized.startsWith(`${ticker}:`) ||
      normalized.includes(`${ticker} @`) ||
      (name !== undefined && normalized === name)
    ) {
      return market.ticker;
    }
  }

  return undefined;
}

function normalizeTradeSide(
  rawSide: string,
  predictionMarketId: string | undefined,
  perpTicker: string | undefined,
  explicitMarketType: 'prediction' | 'perp' | undefined,
  context: AgentTickContext
): string | undefined {
  const normalized = toNormalizedToken(rawSide);
  if (NOOP_SIDES.has(normalized)) {
    return undefined;
  }

  if (PREDICTION_SIDES.has(normalized) || PERP_SIDES.has(normalized)) {
    return normalized;
  }

  if (
    normalized === 'sell' ||
    normalized === 'close' ||
    normalized === 'exit' ||
    normalized === 'take_profit' ||
    normalized === 'stop_loss'
  ) {
    if (explicitMarketType === 'perp' || perpTicker) {
      return 'close_position';
    }

    if (predictionMarketId) {
      // A generic "sell" is only resolvable when exactly one side is held;
      // holding both YES and NO is ambiguous and must not pick one.
      const heldSides = new Set(
        context.agentPositions.predictions
          .filter((position) => position.marketId === predictionMarketId)
          .map((position) => position.side?.trim().toUpperCase())
      );
      if (heldSides.size === 1 && heldSides.has('YES')) {
        return 'sell_yes';
      }
      if (heldSides.size === 1 && heldSides.has('NO')) {
        return 'sell_no';
      }
    }

    return undefined;
  }

  if (
    normalized === 'buy' ||
    normalized === 'yes' ||
    normalized === 'buy_yes' ||
    normalized === 'bullish'
  ) {
    return explicitMarketType === 'perp' || perpTicker
      ? 'open_long'
      : 'buy_yes';
  }

  if (
    normalized === 'no' ||
    normalized === 'buy_no' ||
    normalized === 'bearish'
  ) {
    return explicitMarketType === 'perp' || perpTicker
      ? 'open_short'
      : 'buy_no';
  }

  if (
    normalized === 'long' ||
    normalized === 'open' ||
    normalized === 'open_long'
  ) {
    return explicitMarketType === 'prediction' && !perpTicker
      ? 'buy_yes'
      : 'open_long';
  }

  if (normalized === 'short' || normalized === 'open_short') {
    return explicitMarketType === 'prediction' && !perpTicker
      ? 'buy_no'
      : 'open_short';
  }

  if (normalized === 'sell_yes' || normalized === 'close_yes') {
    return 'sell_yes';
  }

  if (normalized === 'sell_no' || normalized === 'close_no') {
    return 'sell_no';
  }

  return undefined;
}

export function normalizeTradeDecisionParameters(
  parameters: TradeParameters,
  context: AgentTickContext
): TradeParameters {
  const rawMarketId = coerceIdLikeValue(parameters.marketId);
  const rawSide = typeof parameters.side === 'string' ? parameters.side : '';
  const nextParameters: TradeParameters = { ...parameters };

  const explicitMarketType = normalizeMarketType(parameters.marketType);
  if (explicitMarketType) {
    nextParameters.marketType = explicitMarketType;
  } else if ('marketType' in nextParameters) {
    delete nextParameters.marketType;
  }

  if (!rawMarketId) {
    return nextParameters;
  }

  const predictionMarketId = resolvePredictionMarketId(rawMarketId, context);
  const perpTicker =
    explicitMarketType === 'perp' || !predictionMarketId
      ? resolvePerpTicker(rawMarketId, context)
      : undefined;
  const normalizedSide = normalizeTradeSide(
    rawSide,
    predictionMarketId,
    perpTicker,
    explicitMarketType,
    context
  );
  if (normalizedSide) {
    nextParameters.side = normalizedSide;
  } else if ('side' in nextParameters) {
    delete nextParameters.side;
  }

  const marketType =
    explicitMarketType ??
    (normalizedSide && PREDICTION_SIDES.has(normalizedSide)
      ? 'prediction'
      : normalizedSide && PERP_SIDES.has(normalizedSide)
        ? 'perp'
        : undefined);

  if (marketType === 'prediction') {
    nextParameters.marketType = 'prediction';
    if (predictionMarketId) {
      nextParameters.marketId = predictionMarketId;
      return nextParameters;
    }

    return nextParameters;
  }

  if (marketType === 'perp') {
    nextParameters.marketType = 'perp';
    if (perpTicker) {
      nextParameters.marketId = perpTicker;
      return nextParameters;
    }

    return nextParameters;
  }

  if (predictionMarketId) {
    nextParameters.marketType = 'prediction';
    nextParameters.marketId = predictionMarketId;
    return nextParameters;
  }

  if (perpTicker) {
    nextParameters.marketType = 'perp';
    nextParameters.marketId = perpTicker;
  }

  return nextParameters;
}
