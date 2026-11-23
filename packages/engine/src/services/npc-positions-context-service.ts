/**
 * NPC Positions Context Service
 *
 * Builds a compact, prompt-ready summary of an NPC's current market exposure.
 * This is injected into comments/replies/quotes to make interactions:
 * - more specific ("you’re coping because you’re long YES on Q12")
 * - more agenda-driven (self-serving narrative consistent with their bags)
 *
 * IMPORTANT: Must work in both PostgreSQL and JSON modes (no raw Drizzle queries).
 */

import { db } from '@feed/db';

export interface PositionsContextOptions {
  maxPredictionPositionsPerActor?: number;
  maxPerpPositionsPerActor?: number;
}

function clampNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const v = Math.floor(value);
  return v >= 0 ? v : fallback;
}

function parseNullableNumber(
  value: number | string | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSignedNumber(n: number, decimals = 0): string {
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const fixed = decimals > 0 ? abs.toFixed(decimals) : String(Math.round(abs));
  return `${sign}${fixed}`;
}

function formatCurrency(n: number): string {
  // Keep it compact; this is for internal prompt guidance.
  const abs = Math.abs(n);
  if (abs >= 1000000) return `$${formatSignedNumber(n / 1000000, 1)}M`;
  if (abs >= 1000) return `$${formatSignedNumber(n / 1000, 1)}k`;
  return `$${formatSignedNumber(n, 0)}`;
}

function truncateQuestionText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
}

function formatQuestionLabel(q: {
  questionNumber: number;
  text: string;
}): string {
  return `Q${q.questionNumber}: "${truncateQuestionText(q.text)}"`;
}

function formatMarketLabel(questionText: string): string {
  return `"${truncateQuestionText(questionText)}"`;
}

export async function buildPositionsPromptContextByActorId(
  actorIds: string[],
  options: PositionsContextOptions = {}
): Promise<Record<string, string>> {
  const maxPred = clampNonNegativeInt(
    options.maxPredictionPositionsPerActor ?? 2,
    2
  );
  const maxPerps = clampNonNegativeInt(
    options.maxPerpPositionsPerActor ?? 2,
    2
  );

  if (actorIds.length === 0) return {};

  const [predictionPositions, perpPositions] = await Promise.all([
    db.position.findMany({
      where: { userId: { in: actorIds }, status: 'active' },
      select: {
        userId: true,
        marketId: true,
        side: true,
        questionId: true,
        pnl: true,
        amount: true,
        shares: true,
      },
    }),
    db.perpPosition.findMany({
      where: { userId: { in: actorIds }, closedAt: null },
      select: {
        userId: true,
        ticker: true,
        side: true,
        leverage: true,
        size: true,
        unrealizedPnL: true,
        liquidationPrice: true,
      },
    }),
  ]);

  const questionNumbers = Array.from(
    new Set(
      predictionPositions
        .map((p) => p.questionId)
        .filter((q): q is number => typeof q === 'number')
    )
  );
  const marketIds = Array.from(
    new Set(
      predictionPositions
        .filter((p) => typeof p.questionId !== 'number')
        .map((p) => p.marketId)
    )
  );

  const questionOrClauses = [
    ...(questionNumbers.length > 0
      ? [{ questionNumber: { in: questionNumbers } }]
      : []),
    ...(marketIds.length > 0
      ? [{ marketId: { in: marketIds } }, { id: { in: marketIds } }]
      : []),
  ];

  const questions =
    questionOrClauses.length > 0
      ? await db.question.findMany({
          where: { OR: questionOrClauses },
          select: {
            id: true,
            marketId: true,
            questionNumber: true,
            text: true,
          },
        })
      : [];

  const questionByNumber = new Map<number, string>();
  const questionByMarketId = new Map<string, string>();
  for (const q of questions) {
    const label = formatQuestionLabel(q);
    questionByNumber.set(q.questionNumber, label);
    questionByMarketId.set(q.id, label);
    if (q.marketId) {
      questionByMarketId.set(q.marketId, label);
    }
  }

  const unresolvedMarketIds = marketIds.filter(
    (id) => !questionByMarketId.has(id)
  );
  const markets =
    unresolvedMarketIds.length > 0
      ? await db.market.findMany({
          where: { id: { in: unresolvedMarketIds } },
          select: { id: true, question: true },
        })
      : [];
  for (const m of markets) {
    questionByMarketId.set(m.id, formatMarketLabel(m.question));
  }

  // Group positions by actor
  const predByActor = new Map<string, typeof predictionPositions>();
  for (const p of predictionPositions) {
    const list = predByActor.get(p.userId) ?? [];
    list.push(p);
    predByActor.set(p.userId, list);
  }

  const perpsByActor = new Map<string, typeof perpPositions>();
  for (const p of perpPositions) {
    const list = perpsByActor.get(p.userId) ?? [];
    list.push(p);
    perpsByActor.set(p.userId, list);
  }

  const out: Record<string, string> = {};

  for (const actorId of actorIds) {
    const pred = predByActor.get(actorId) ?? [];
    const perps = perpsByActor.get(actorId) ?? [];

    const lines: string[] = [];

    if (maxPred > 0 && pred.length > 0) {
      // Rank by exposure (amount at risk), tie-broken by |PnL|. Positions
      // with no remaining shares are not current holdings and are skipped.
      const scored = pred
        .filter((p) => (parseNullableNumber(p.shares) ?? 0) > 0)
        .map((p) => {
          const pnl = parseNullableNumber(p.pnl);
          const exposure = Math.abs(parseNullableNumber(p.amount) ?? 0);
          return { p, pnl, exposure };
        })
        .sort(
          (a, b) =>
            b.exposure - a.exposure ||
            Math.abs(b.pnl ?? 0) - Math.abs(a.pnl ?? 0)
        )
        .slice(0, maxPred);

      for (const { p, pnl } of scored) {
        const qLabel =
          typeof p.questionId === 'number'
            ? (questionByNumber.get(p.questionId) ?? `Q${p.questionId}`)
            : (questionByMarketId.get(p.marketId) ?? 'Unknown question');
        const side = p.side ? 'YES' : 'NO';
        const pnlText = pnl !== null ? ` (${formatCurrency(pnl)})` : '';
        lines.push(`- ${qLabel} → ${side}${pnlText}`);
      }
    }

    if (maxPerps > 0 && perps.length > 0) {
      const scored = perps
        .map((p) => ({ p, score: Math.abs(p.unrealizedPnL) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPerps);

      for (const { p } of scored) {
        const side = p.side.toUpperCase();
        const lev = `${p.leverage}x`;
        const pnlText = formatCurrency(p.unrealizedPnL);
        const liq = Number.isFinite(p.liquidationPrice)
          ? `, liq ${p.liquidationPrice.toFixed(2)}`
          : '';
        lines.push(`- ${p.ticker} ${side} ${lev} (uPnL ${pnlText}${liq})`);
      }
    }

    if (lines.length === 0) {
      out[actorId] = '';
      continue;
    }

    out[actorId] = `=== YOUR CURRENT POSITIONS (bias + trash talk fuel) ===
${lines.join('\n')}
Let this bias your tone. If you're down bad, be defensive/coping; if you're up, be smug. Use it to accuse others of bagholding (specifically).
====================================================`;
  }

  return out;
}
